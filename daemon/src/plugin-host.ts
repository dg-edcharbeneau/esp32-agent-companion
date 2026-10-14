import {spawn, type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdir, readdir, realpath} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {
  hostApiVersion, isApiCompatible, loadPluginManifest, missingSettings, validateSettingChange,
  type PluginManifest, type PluginPermission, type SettingField, type SettingValues,
} from './plugin-manifest.js';
import {RpcError, RpcPeer, rpcErrors} from './plugin-rpc.js';
import {consentCovers, PluginStore, type PluginConsent, type PublicSettingValue} from './plugin-store.js';
import {maxSpeechFrames, speechSampleRate, validateSpeechText} from './speech.js';

export interface PluginTimings {
  handshakeMs: number;
  pingIntervalMs: number;
  pingTimeoutMs: number;
  stopMs: number;
  synthesizeMs: number;
  // Waits between restarts after a crash; the last one repeats.
  backoffMs: number[];
  // Uptime after which a plugin counts as healthy and the backoff starts over.
  healthyMs: number;
  // This many crashes inside the window quarantines the plugin.
  quarantineCrashes: number;
  quarantineWindowMs: number;
  // Lines on stdout that are not JSON-RPC before the plugin is restarted.
  maxJunkLines: number;
}

export const defaultPluginTimings: PluginTimings = {
  handshakeMs: 10_000,
  pingIntervalMs: 30_000,
  pingTimeoutMs: 5_000,
  stopMs: 2_000,
  synthesizeMs: 20_000,
  backoffMs: [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000],
  healthyMs: 10 * 60_000,
  quarantineCrashes: 5,
  quarantineWindowMs: 10 * 60_000,
  maxJunkLines: 20,
};

// What the host lets plugins reach. Each call is checked against the plugin's permissions first.
export interface PluginHostServices {
  status(): {state: string; connected: boolean; transport: string | null; wifi: boolean; voiceMode: string};
  narrate(text: string): Promise<void>;
}

export type PluginState =
  | 'disabled' | 'starting' | 'running' | 'restarting' | 'stopped' | 'quarantined'
  | 'needsConsent' | 'incompatible' | 'broken';

export interface PluginReport {
  state: 'ready' | 'needsSetup' | 'error';
  message?: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string | null;
  description: string;
  publisher: string | null;
  homepage: string | null;
  permissions: PluginPermission[];
  network: string[];
  enabled: boolean;
  state: PluginState;
  // Set when the plugin is running: whether it is ready, or what it needs.
  report: PluginReport | null;
  // A problem that kept the plugin from loading or running.
  problem: string | null;
  settings: SettingField[];
  values: Record<string, PublicSettingValue>;
  speechProviders: {id: string; name: string; description?: string}[];
}

export interface PluginSpeechProvider {
  key: string;
  name: string;
  plugin: string;
  available: boolean;
  reason?: string;
}

export const pluginSpeechPurposes = ['notification', 'narration', 'speak', 'test'] as const;
export type SpeechPurpose = typeof pluginSpeechPurposes[number];

// Variables a plugin needs to run. Nothing else from the daemon's environment is passed on.
const passedEnvironment = [
  'PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
];

export function pluginEnvironment(id: string, dataDir: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of passedEnvironment) if (source[name] !== undefined) env[name] = source[name];
  env.AGENT_BUDDY_PLUGIN_ID = id;
  env.AGENT_BUDDY_PLUGIN_DATA = dataDir;
  return env;
}

// Node's permission model keeps a plugin to its own folder and data. It is a seat belt, not a sandbox:
// Node 24 does not limit network access. Pass real paths: Node checks the resolved path of every file it
// opens, so a folder reached through a symlink (macOS /var, for one) would otherwise be refused.
export function pluginNodeArguments(manifest: PluginManifest, folder: string, dataDir: string): string[] {
  return [
    '--permission',
    `--allow-fs-read=${folder}`,
    `--allow-fs-read=${dataDir}`,
    `--allow-fs-write=${dataDir}`,
    ...(manifest.permissions.includes('process.spawn') ? ['--allow-child-process'] : []),
    '--max-old-space-size=128',
    resolve(folder, manifest.main),
  ];
}

interface PluginEntry {
  id: string;
  folder: string;
  manifest: PluginManifest | null;
  problem: string | null;
  process: PluginProcess | null;
}

// One running plugin: its process, the protocol, health checks, and restarts.
class PluginProcess {
  readonly manifest: PluginManifest;
  readonly #folder: string;
  readonly #host: PluginHost;
  readonly #timings: PluginTimings;
  #child: ChildProcess | null = null;
  #peer: RpcPeer | null = null;
  #state: PluginState = 'stopped';
  #report: PluginReport | null = null;
  #problem: string | null = null;
  #stopping = false;
  #startedAt = 0;
  #crashes: number[] = [];
  #restarts = 0;
  #restartTimer: NodeJS.Timeout | null = null;
  #pingTimer: NodeJS.Timeout | null = null;
  #missedPings = 0;
  #junkLines = 0;
  #logLines: number[] = [];

  constructor(manifest: PluginManifest, folder: string, host: PluginHost, timings: PluginTimings) {
    this.manifest = manifest;
    this.#folder = folder;
    this.#host = host;
    this.#timings = timings;
  }

  get state(): PluginState {
    return this.#state;
  }

  get report(): PluginReport | null {
    return this.#state === 'running' ? this.#report : null;
  }

  get problem(): string | null {
    return this.#problem;
  }

  get ready(): boolean {
    return this.#state === 'running' && this.#report?.state === 'ready';
  }

  async start(): Promise<void> {
    if (this.#child || this.#state === 'quarantined') return;
    this.#stopping = false;
    this.#setState('starting');
    await mkdir(this.#host.store.dataDirectory(this.manifest.id), {recursive: true, mode: 0o700});
    const dataDir = await realpath(this.#host.store.dataDirectory(this.manifest.id));
    const folder = await realpath(this.#folder);
    const child = spawn(this.#host.nodePath, pluginNodeArguments(this.manifest, folder, dataDir), {
      cwd: folder,
      env: pluginEnvironment(this.manifest.id, dataDir),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    this.#child = child;
    this.#junkLines = 0;
    this.#missedPings = 0;
    const peer = new RpcPeer(child.stdout!, child.stdin!, {
      onJunk: line => {
        this.#log('warn', `wrote a line that is not JSON-RPC to stdout: ${line.slice(0, 120)}`);
        if (++this.#junkLines > this.#timings.maxJunkLines) this.#violation('kept writing non-protocol text to stdout');
      },
      onViolation: reason => this.#violation(reason),
    });
    this.#peer = peer;
    this.#listen(peer);
    child.stderr!.setEncoding('utf8');
    let partial = '';
    child.stderr!.on('data', (chunk: string) => {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) this.#log('info', line);
    });
    child.once('error', error => this.#exited(`could not start: ${error.message}`));
    child.once('exit', (code, signal) => this.#exited(signal ? `stopped by ${signal}` : `exited with code ${code}`));

    try {
      const settings = await this.#host.store.settings(this.manifest);
      const result = await peer.request('initialize', {
        api: `${hostApiVersion.major}.${hostApiVersion.minor}`,
        host: {name: 'agent-buddy', version: this.#host.hostVersion, platform: process.platform},
        plugin: {id: this.manifest.id, version: this.manifest.version, dataDir},
        granted: this.manifest.permissions,
        settings,
      }, this.#timings.handshakeMs) as {api?: unknown};
      if (typeof result?.api !== 'string' || !/^1\.\d+$/.test(result.api))
        throw new RpcError(rpcErrors.invalidRequest, 'answered initialize without "api": "1.x".');
      if (child !== this.#child) return;
      peer.notify('initialized', {});
      this.#report = this.#defaultReport(settings);
      this.#startedAt = Date.now();
      this.#problem = null;
      this.#setState('running');
      this.#schedulePing();
    } catch (error) {
      if (child !== this.#child) return;
      this.#problem = `Failed to start: ${error instanceof Error ? error.message : String(error)}`;
      this.#kill();
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#clearTimers();
    const child = this.#child;
    const peer = this.#peer;
    if (!child) {
      if (this.#state !== 'quarantined') this.#setState('stopped');
      return;
    }
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    try {
      await peer?.request('shutdown', {}, this.#timings.stopMs);
    } catch {
      // A plugin that doesn't answer is stopped anyway.
    }
    peer?.notify('exit', {});
    child.stdin?.end();
    const timer = setTimeout(() => child.kill(), this.#timings.stopMs);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }

  async restartNow(): Promise<void> {
    await this.stop();
    this.#crashes = [];
    this.#restarts = 0;
    this.#problem = null;
    this.#state = 'stopped';
    await this.start();
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.#state !== 'running' || !this.#peer)
      return Promise.reject(new RpcError(rpcErrors.internal, `${this.manifest.name} is not running.`));
    return this.#peer.request(method, params, timeoutMs);
  }

  notify(method: string, params: unknown): void {
    if (this.#state === 'running') this.#peer?.notify(method, params);
  }

  settingsChanged(settings: SettingValues): void {
    if (this.#state !== 'running') return;
    this.#report = this.#defaultReport(settings);
    this.#peer?.notify('settings/changed', {settings});
    this.#host.changed();
  }

  // Until the plugin says otherwise, a plugin missing required settings needs setup.
  #defaultReport(settings: SettingValues): PluginReport {
    const missing = missingSettings(this.manifest, settings);
    return missing.length
      ? {state: 'needsSetup', message: `Add ${missing.map(field => field.title).join(', ')} in Plugins.`}
      : {state: 'ready'};
  }

  #listen(peer: RpcPeer): void {
    const allowed = (permission: PluginPermission) => {
      if (this.#state !== 'running') throw new RpcError(rpcErrors.notInitialized, 'The plugin has not finished starting.');
      if (!this.manifest.permissions.includes(permission))
        throw new RpcError(rpcErrors.permissionDenied, `The plugin did not ask for the ${permission} permission.`);
    };
    peer.onNotification('host/status', params => {
      const report = params as {state?: unknown; message?: unknown};
      if (report?.state !== 'ready' && report?.state !== 'needsSetup' && report?.state !== 'error') return;
      this.#report = {state: report.state,
                      message: typeof report.message === 'string' ? report.message.slice(0, 200) : undefined};
      this.#host.changed();
    });
    peer.onNotification('host/log', params => {
      const entry = params as {level?: unknown; message?: unknown};
      if (typeof entry?.message === 'string')
        this.#log(entry.level === 'error' || entry.level === 'warn' ? entry.level : 'info', entry.message);
    });
    peer.onRequest('host/getStatus', () => {
      allowed('status.read');
      return this.#host.services.status();
    });
    peer.onRequest('voice/narrate', async params => {
      allowed('voice.narrate');
      const text = (params as {text?: unknown})?.text;
      if (typeof text !== 'string') throw new RpcError(rpcErrors.invalidParams, 'text must be a string.');
      await this.#host.services.narrate(text);
      return {};
    });
  }

  #schedulePing(): void {
    this.#pingTimer = setTimeout(async () => {
      this.#pingTimer = null;
      if (this.#state !== 'running' || !this.#peer) return;
      try {
        await this.#peer.request('$/ping', {}, this.#timings.pingTimeoutMs);
        this.#missedPings = 0;
      } catch {
        if (++this.#missedPings >= 2) {
          this.#violation('stopped answering health checks');
          return;
        }
      }
      if (Date.now() - this.#startedAt >= this.#timings.healthyMs) this.#restarts = 0;
      this.#schedulePing();
    }, this.#timings.pingIntervalMs);
    this.#pingTimer.unref();
  }

  #violation(reason: string): void {
    this.#problem = `Restarted: it ${reason}.`;
    this.#log('error', this.#problem);
    this.#kill();
  }

  #kill(): void {
    this.#child?.kill('SIGKILL');
  }

  #exited(reason: string): void {
    if (!this.#child) return;
    this.#child = null;
    this.#peer?.close(new RpcError(rpcErrors.internal, `${this.manifest.name} stopped.`));
    this.#peer = null;
    this.#clearTimers();
    if (this.#stopping) {
      this.#setState('stopped');
      return;
    }
    this.#problem ??= `It ${reason}.`;
    this.#log('error', `${reason}`);
    const now = Date.now();
    this.#crashes = [...this.#crashes.filter(at => now - at < this.#timings.quarantineWindowMs), now];
    if (this.#crashes.length >= this.#timings.quarantineCrashes) {
      this.#problem = `Stopped after ${this.#crashes.length} crashes in a row. Restart it from Plugins.`;
      // Saved before it is reported, so a daemon restart can't miss the quarantine.
      void this.#host.store.update(this.manifest.id, {quarantined: true}).catch(() => undefined)
        .finally(() => this.#setState('quarantined'));
      return;
    }
    const delays = this.#timings.backoffMs;
    const delay = delays[Math.min(this.#restarts++, delays.length - 1)]!;
    this.#setState('restarting');
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.start();
    }, delay);
    this.#restartTimer.unref();
  }

  #clearTimers(): void {
    if (this.#pingTimer) clearTimeout(this.#pingTimer);
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#pingTimer = null;
    this.#restartTimer = null;
  }

  #setState(state: PluginState): void {
    if (state !== 'running') this.#report = null;
    this.#state = state;
    this.#host.changed();
  }

  // Plugin output goes to the daemon log, at most 50 lines every 10 seconds per plugin.
  #log(level: 'info' | 'warn' | 'error', message: string): void {
    const now = Date.now();
    this.#logLines = this.#logLines.filter(at => now - at < 10_000);
    if (this.#logLines.length >= 50) return;
    this.#logLines.push(now);
    const line = `[plugin:${this.manifest.id}] ${message.slice(0, 500)}`;
    if (level === 'info') console.log(line);
    else console.error(line);
  }
}

export interface PluginHostOptions {
  store?: PluginStore;
  directory: string;
  services: PluginHostServices;
  nodePath?: string;
  hostVersion?: string | null;
  timings?: Partial<PluginTimings>;
}

// Finds the installed plugins, runs the enabled ones, and routes speech and events to them.
export class PluginHost extends EventEmitter {
  readonly store: PluginStore;
  readonly services: PluginHostServices;
  readonly nodePath: string;
  readonly hostVersion: string | null;
  readonly #directory: string;
  readonly #timings: PluginTimings;
  #entries = new Map<string, PluginEntry>();
  #revision = 0;
  #stopped = false;

  constructor(options: PluginHostOptions) {
    super();
    this.store = options.store ?? new PluginStore();
    this.services = options.services;
    this.nodePath = options.nodePath ?? process.execPath;
    this.hostVersion = options.hostVersion ?? null;
    this.#directory = options.directory;
    this.#timings = {...defaultPluginTimings, ...options.timings};
  }

  // Goes up whenever anything a plugin reports changes; the Settings page refetches on a new value.
  get revision(): number {
    return this.#revision;
  }

  changed(): void {
    this.#revision++;
    this.emit('change');
  }

  // Reads the plugin folder again and starts or stops plugins to match. Safe to call any time.
  async load(): Promise<void> {
    this.#stopped = false;
    let names: string[] = [];
    try {
      names = (await readdir(this.#directory, {withFileTypes: true}))
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const found = new Set(names);
    for (const [id, entry] of this.#entries) {
      if (found.has(id)) continue;
      await entry.process?.stop();
      this.#entries.delete(id);
    }
    for (const name of names) {
      const folder = join(this.#directory, name);
      let manifest: PluginManifest | null = null;
      let problem: string | null = null;
      try {
        manifest = loadPluginManifest(folder);
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      const existing = this.#entries.get(name);
      if (existing?.process && manifest?.version === existing.manifest?.version) continue;
      await existing?.process?.stop();
      this.#entries.set(name, {id: name, folder, manifest, problem, process: null});
    }
    await Promise.all([...this.#entries.keys()].map(id => this.#sync(id)));
    this.changed();
  }

  async #sync(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry?.manifest || this.#stopped) return;
    const record = await this.store.record(id);
    const runnable = record.enabled && !record.quarantined && consentCovers(record.consent, entry.manifest)
      && isApiCompatible(entry.manifest.api);
    if (!runnable) {
      await entry.process?.stop();
      return;
    }
    // A quarantine the user cleared (by enabling or restarting) starts from a fresh process.
    if (entry.process?.state === 'quarantined') entry.process = null;
    entry.process ??= new PluginProcess(entry.manifest, entry.folder, this, this.#timings);
    await entry.process.start();
  }

  async stopAll(): Promise<void> {
    this.#stopped = true;
    await Promise.all([...this.#entries.values()].map(entry => entry.process?.stop()));
  }

  async list(): Promise<PluginInfo[]> {
    const records = await this.store.records();
    const infos: PluginInfo[] = [];
    for (const entry of [...this.#entries.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const manifest = entry.manifest;
      const record = records[entry.id] ?? {enabled: false, consent: null, quarantined: false, source: null};
      let state: PluginState;
      let problem = entry.problem ?? entry.process?.problem ?? null;
      if (!manifest) state = 'broken';
      else if (!isApiCompatible(manifest.api)) {
        state = 'incompatible';
        problem = `Needs Agent Buddy plugin API ${manifest.api.major}.${manifest.api.minor}.`;
      } else if (record.quarantined) state = 'quarantined';
      else if (!record.enabled) state = 'disabled';
      else if (!consentCovers(record.consent, manifest)) state = 'needsConsent';
      else state = entry.process?.state ?? 'stopped';
      infos.push({
        id: entry.id,
        name: manifest?.name ?? entry.id,
        version: manifest?.version ?? null,
        description: manifest?.description ?? '',
        publisher: manifest?.publisher ?? null,
        homepage: manifest?.homepage ?? null,
        permissions: manifest?.permissions ?? [],
        network: manifest?.network ?? [],
        enabled: record.enabled,
        state,
        report: entry.process?.report ?? null,
        problem,
        settings: manifest?.contributes.settings ?? [],
        values: manifest ? await this.store.publicSettings(manifest) : {},
        speechProviders: manifest?.contributes.speechProviders ?? [],
      });
    }
    return infos;
  }

  #entry(id: string): PluginEntry & {manifest: PluginManifest} {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(`No plugin named "${id}" is installed.`);
    if (!entry.manifest) throw new Error(`${id} cannot load: ${entry.problem}`);
    return entry as PluginEntry & {manifest: PluginManifest};
  }

  // Enabling needs consent to exactly what this version of the plugin asks for.
  async enable(id: string, consent: PluginConsent): Promise<void> {
    const {manifest} = this.#entry(id);
    if (consent.version !== manifest.version || !consentCovers(consent, manifest))
      throw new Error(`Review and accept what ${manifest.name} ${manifest.version} asks for before enabling it.`);
    await this.store.update(id, {enabled: true, quarantined: false,
                                 consent: {version: manifest.version, permissions: [...manifest.permissions],
                                           network: [...manifest.network]}});
    await this.#sync(id);
    this.changed();
  }

  async disable(id: string): Promise<void> {
    this.#entry(id);
    await this.store.update(id, {enabled: false});
    await this.#sync(id);
    this.changed();
  }

  // Clears a quarantine and starts the plugin again.
  async restart(id: string): Promise<void> {
    const entry = this.#entry(id);
    await this.store.update(id, {quarantined: false});
    if (entry.process) {
      await entry.process.restartNow();
      if (entry.process.state === 'quarantined') entry.process = null;
    }
    if (!entry.process) await this.#sync(id);
    this.changed();
  }

  async setSettings(id: string, change: unknown): Promise<void> {
    const entry = this.#entry(id);
    const checked = validateSettingChange(entry.manifest, change);
    await this.store.saveSettings(entry.manifest, checked);
    entry.process?.settingsChanged(await this.store.settings(entry.manifest));
    this.changed();
  }

  speechProviders(): PluginSpeechProvider[] {
    const providers: PluginSpeechProvider[] = [];
    for (const entry of this.#entries.values()) {
      if (!entry.manifest) continue;
      for (const provider of entry.manifest.contributes.speechProviders) {
        const running = entry.process?.state === 'running';
        const report = entry.process?.report;
        providers.push({
          key: `${entry.id}/${provider.id}`,
          name: `${provider.name} (${entry.manifest.name})`,
          plugin: entry.id,
          available: !!entry.process?.ready,
          reason: entry.process?.ready ? undefined
            : running ? report?.message ?? `${entry.manifest.name} is not ready.`
            : `${entry.manifest.name} is not running. Enable it in Plugins.`,
        });
      }
    }
    return providers;
  }

  // Asks a plugin for speech and returns mono 24 kHz signed 16-bit PCM.
  async synthesize(key: string, text: string, purpose: SpeechPurpose): Promise<Buffer> {
    const [id, providerId] = key.split('/');
    const entry = this.#entries.get(id ?? '');
    if (!entry?.manifest?.contributes.speechProviders.some(provider => provider.id === providerId))
      throw new Error(`The speech provider "${key}" is not installed.`);
    if (!entry.process || entry.process.state !== 'running')
      throw new Error(`${entry.manifest.name} is not running. Enable it in Plugins.`);
    if (entry.process.report?.state === 'needsSetup')
      throw new Error(entry.process.report.message ?? `${entry.manifest.name} needs setup in Plugins.`);
    const result = await entry.process.request('speech/synthesize', {
      provider: providerId, text: validateSpeechText(text), purpose,
    }, this.#timings.synthesizeMs) as {audio?: {encoding?: unknown; sampleRate?: unknown; channels?: unknown; data?: unknown}};
    const audio = result?.audio;
    if (!audio || audio.encoding !== 's16le' || audio.sampleRate !== speechSampleRate || audio.channels !== 1
        || typeof audio.data !== 'string')
      throw new Error(`${entry.manifest.name} returned audio in an unsupported format.`);
    const pcm = Buffer.from(audio.data, 'base64');
    if (pcm.length === 0 || pcm.length % 2 !== 0) throw new Error(`${entry.manifest.name} returned empty or misaligned audio.`);
    if (pcm.length > maxSpeechFrames * 2) throw new Error(`${entry.manifest.name} returned more than 15 seconds of audio.`);
    return pcm;
  }

  notifyState(state: string, previous: string): void {
    this.#broadcast('events.state', 'events/state', {state, previous, at: Date.now()});
  }

  // Only which agent and which event: never prompts, tool input or session identifiers.
  notifyAgentEvent(agent: string, event: string): void {
    this.#broadcast('events.agent', 'events/agent', {agent, event, at: Date.now()});
  }

  #broadcast(permission: PluginPermission, method: string, params: unknown): void {
    for (const entry of this.#entries.values())
      if (entry.manifest?.permissions.includes(permission)) entry.process?.notify(method, params);
  }
}
