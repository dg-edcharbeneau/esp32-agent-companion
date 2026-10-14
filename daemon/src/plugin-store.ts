import {chmod, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {pluginRegistryPath, pluginStateDirectory} from './paths.js';
import {settingDefaults, type PluginManifest, type PluginPermission, type SettingValues} from './plugin-manifest.js';

// What the user agreed to when enabling a plugin. A new version that asks for more needs consent again.
export interface PluginConsent {
  version: string;
  permissions: PluginPermission[];
  network: string[];
}

export interface PluginRecord {
  enabled: boolean;
  consent: PluginConsent | null;
  // Set after repeated crashes; stays set across restarts until the user restarts the plugin.
  quarantined: boolean;
  source: {type: 'path' | 'git'; ref: string; commit?: string} | null;
}

// A setting as the Settings page sees it: secrets only say whether they are set.
export type PublicSettingValue = string | number | boolean | {set: boolean};

const emptyRecord: PluginRecord = {enabled: false, consent: null, quarantined: false, source: null};

async function writePrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

function isConsent(value: unknown): value is PluginConsent {
  const consent = value as PluginConsent;
  return !!consent && typeof consent.version === 'string' && Array.isArray(consent.permissions)
    && Array.isArray(consent.network);
}

// A consent as it arrives from the Settings page or the CLI.
export function isPluginConsent(value: unknown): value is PluginConsent {
  const consent = value as PluginConsent;
  return !!consent && typeof consent === 'object' && typeof consent.version === 'string'
    && Array.isArray(consent.permissions) && consent.permissions.every(item => typeof item === 'string')
    && Array.isArray(consent.network) && consent.network.every(item => typeof item === 'string');
}

// True when the manifest asks for nothing beyond what the user already agreed to.
export function consentCovers(consent: PluginConsent | null, manifest: PluginManifest): boolean {
  if (!consent) return false;
  return manifest.permissions.every(permission => consent.permissions.includes(permission))
    && manifest.network.every(host => consent.network.includes(host));
}

export class PluginStore {
  readonly #registryPath: string;
  readonly #stateDir: string;
  // Writes to plugins.json happen one at a time so concurrent changes don't drop each other.
  #writes = Promise.resolve();

  constructor(registryPath = pluginRegistryPath(), stateDir = pluginStateDirectory()) {
    this.#registryPath = registryPath;
    this.#stateDir = stateDir;
  }

  dataDirectory(id: string): string {
    return join(this.#stateDir, id, 'data');
  }

  async records(): Promise<Record<string, PluginRecord>> {
    const raw = await readJson(this.#registryPath);
    const records: Record<string, PluginRecord> = {};
    for (const [id, value] of Object.entries(raw)) {
      const entry = (value ?? {}) as Record<string, unknown>;
      const source = entry.source as PluginRecord['source'];
      records[id] = {
        enabled: entry.enabled === true,
        consent: isConsent(entry.consent) ? entry.consent : null,
        quarantined: entry.quarantined === true,
        source: source && (source.type === 'path' || source.type === 'git') && typeof source.ref === 'string'
          ? source : null,
      };
    }
    return records;
  }

  async record(id: string): Promise<PluginRecord> {
    return (await this.records())[id] ?? {...emptyRecord};
  }

  update(id: string, change: Partial<PluginRecord>): Promise<PluginRecord> {
    const work = this.#writes.then(async () => {
      const records = await this.records();
      const next = {...emptyRecord, ...records[id], ...change};
      records[id] = next;
      await writePrivate(this.#registryPath, records);
      return next;
    });
    this.#writes = work.then(() => undefined, () => undefined);
    return work;
  }

  // Forgets a plugin: its record, and its settings and secrets unless keepData.
  async forget(id: string, keepData = false): Promise<void> {
    const work = this.#writes.then(async () => {
      const records = await this.records();
      delete records[id];
      await writePrivate(this.#registryPath, records);
      if (!keepData) await rm(join(this.#stateDir, id), {recursive: true, force: true});
    });
    this.#writes = work.then(() => undefined, () => undefined);
    return work;
  }

  // Every value the plugin sees: defaults, then saved settings, then saved secrets.
  async settings(manifest: PluginManifest): Promise<SettingValues> {
    const saved = await readJson(join(this.#stateDir, manifest.id, 'settings.json'));
    const secrets = await readJson(join(this.#stateDir, manifest.id, 'secrets.json'));
    const values: SettingValues = settingDefaults(manifest);
    for (const field of manifest.contributes.settings) {
      const value = field.type === 'secret' ? secrets[field.key] : saved[field.key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        values[field.key] = value;
    }
    return values;
  }

  // The values for the Settings page, with each secret replaced by whether it is set.
  async publicSettings(manifest: PluginManifest): Promise<Record<string, PublicSettingValue>> {
    const values = await this.settings(manifest);
    const result: Record<string, PublicSettingValue> = {};
    for (const field of manifest.contributes.settings) {
      if (field.type === 'secret') result[field.key] = {set: typeof values[field.key] === 'string' && values[field.key] !== ''};
      else if (values[field.key] !== undefined) result[field.key] = values[field.key]!;
    }
    return result;
  }

  // Saves a checked change. null clears a value; keys not in the change are kept.
  async saveSettings(manifest: PluginManifest, change: Record<string, unknown>): Promise<void> {
    const settingsPath = join(this.#stateDir, manifest.id, 'settings.json');
    const secretsPath = join(this.#stateDir, manifest.id, 'secrets.json');
    const saved = await readJson(settingsPath);
    const secrets = await readJson(secretsPath);
    const types = new Map(manifest.contributes.settings.map(field => [field.key, field.type]));
    let secretsChanged = false;
    for (const [key, value] of Object.entries(change)) {
      const target = types.get(key) === 'secret' ? secrets : saved;
      if (target === secrets) secretsChanged = true;
      if (value === null) delete target[key];
      else target[key] = value;
    }
    await writePrivate(settingsPath, saved);
    if (secretsChanged) await writePrivate(secretsPath, secrets);
  }
}
