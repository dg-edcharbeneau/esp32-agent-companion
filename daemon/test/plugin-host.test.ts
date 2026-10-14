import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {PluginHost, pluginEnvironment, type PluginHostServices} from '../src/plugin-host.js';
import {PluginStore} from '../src/plugin-store.js';
import {writeFixturePlugin, type FixtureBehavior} from './plugin-fixtures.js';

const consent = {version: '1.0.0', permissions: ['speech.provide' as const], network: ['api.example.com']};
const fast = {
  handshakeMs: 5_000, pingIntervalMs: 60_000, pingTimeoutMs: 200, stopMs: 500, synthesizeMs: 5_000,
  backoffMs: [20, 40], healthyMs: 60_000, quarantineCrashes: 3, quarantineWindowMs: 60_000, maxJunkLines: 20,
};

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the plugin.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function hostWith(t: TestContext, behavior: FixtureBehavior, options: {
  change?: Record<string, unknown>; timings?: Partial<typeof fast>; services?: Partial<PluginHostServices>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-host-'));
  await writeFixturePlugin(join(root, 'plugins'), 'echo-speech', behavior, options.change);
  const store = new PluginStore(join(root, 'plugins.json'), join(root, 'plugin-state'));
  const logs: string[] = [];
  const original = {log: console.log, error: console.error};
  console.log = (line: string) => logs.push(line);
  console.error = (line: string) => logs.push(line);
  const host = new PluginHost({
    directory: join(root, 'plugins'),
    store,
    timings: {...fast, ...options.timings},
    services: {
      status: () => ({state: 'idle', connected: true, transport: 'wifi', wifi: true, voiceMode: 'off'}),
      narrate: async () => undefined,
      ...options.services,
    },
  });
  t.after(async () => {
    await host.stopAll();
    console.log = original.log;
    console.error = original.error;
    await rm(root, {recursive: true, force: true});
  });
  return {host, store, logs, root};
}

const stateOf = async (host: PluginHost) => (await host.list())[0]?.state;

test('an installed plugin waits for consent, then speaks', async t => {
  const {host, store} = await hostWith(t, 'speech');
  await host.load();
  assert.equal(await stateOf(host), 'disabled');
  assert.equal(host.speechProviders()[0]?.available, false);
  await assert.rejects(host.enable('echo-speech', {...consent, network: []}), /Review and accept/);
  await host.enable('echo-speech', consent);
  await until(async () => await stateOf(host) === 'running');
  // Required settings are missing, so the provider explains what it needs.
  const [provider] = host.speechProviders();
  assert.equal(provider?.key, 'echo-speech/echo');
  assert.equal(provider?.available, false);
  assert.match(provider?.reason ?? '', /Add API key in Plugins/);
  await assert.rejects(host.synthesize('echo-speech/echo', 'hello', 'speak'), /Add API key/);
  await host.setSettings('echo-speech', {apiKey: 'sk-test'});
  assert.equal(host.speechProviders()[0]?.available, true);
  const pcm = await host.synthesize('echo-speech/echo', 'hello', 'speak');
  assert.equal(pcm.length, 480);
  assert.equal(pcm.subarray(0, 5).toString(), 'hello');
  const [info] = await host.list();
  assert.deepEqual(info?.values, {apiKey: {set: true}, voice: 'a'});
  assert.doesNotMatch(JSON.stringify(await host.list()), /sk-test/);
  assert.equal((await store.record('echo-speech')).consent?.version, '1.0.0');
  await host.disable('echo-speech');
  assert.equal(await stateOf(host), 'disabled');
});

test('rejects audio in the wrong format', async t => {
  const {host} = await hostWith(t, 'badAudio');
  await host.load();
  await host.enable('echo-speech', consent);
  await host.setSettings('echo-speech', {apiKey: 'sk'});
  await until(async () => await stateOf(host) === 'running');
  await assert.rejects(host.synthesize('echo-speech/echo', 'hello', 'speak'), /unsupported format/);
});

test('restarts a crashing plugin with backoff, then quarantines it across restarts', async t => {
  const {host, store, root} = await hostWith(t, 'crash');
  await host.load();
  await host.enable('echo-speech', consent);
  await until(async () => await stateOf(host) === 'quarantined');
  assert.equal((await store.record('echo-speech')).quarantined, true);
  assert.match((await host.list())[0]?.problem ?? '', /Stopped after 3 crashes/);
  const again = new PluginHost({directory: join(root, 'plugins'), store, timings: fast,
                                services: {status: () => ({state: 'idle', connected: false, transport: null,
                                                           wifi: false, voiceMode: 'off'}),
                                           narrate: async () => undefined}});
  await again.load();
  assert.equal(await stateOf(again), 'quarantined');
  await again.stopAll();
});

test('restarts a plugin that stops answering health checks', async t => {
  const {host} = await hostWith(t, 'hang', {timings: {pingIntervalMs: 50, pingTimeoutMs: 50, quarantineCrashes: 100}});
  await host.load();
  await host.enable('echo-speech', consent);
  await until(async () => (await host.list())[0]?.problem?.includes('health checks') === true);
});

test('restarts a plugin that keeps printing to stdout', async t => {
  const {host, logs} = await hostWith(t, 'noisy', {timings: {quarantineCrashes: 100}});
  await host.load();
  await host.enable('echo-speech', consent);
  await until(async () => (await host.list())[0]?.problem?.includes('non-protocol') === true);
  assert.ok(logs.some(line => line.includes('not JSON-RPC')));
});

test('gives plugins a scrubbed environment and no daemon secrets', async t => {
  process.env.AGENT_COMPANION_SOCKET = '/tmp/should-not-leak.sock';
  t.after(() => { delete process.env.AGENT_COMPANION_SOCKET; });
  const env = pluginEnvironment('echo-speech', '/data');
  assert.equal(env.AGENT_COMPANION_SOCKET, undefined);
  assert.equal(env.AGENT_BUDDY_PLUGIN_ID, 'echo-speech');
  const {host, logs} = await hostWith(t, 'env');
  await host.load();
  await host.enable('echo-speech', consent);
  await until(() => logs.some(line => line.includes('ENV ')));
  const seen = JSON.parse(logs.find(line => line.includes('ENV '))!.split('ENV ')[1]!) as string[];
  assert.ok(seen.includes('AGENT_BUDDY_PLUGIN_ID'));
  assert.ok(!seen.some(name => name.startsWith('AGENT_COMPANION_')));
});

test('denies host methods the plugin did not ask for, and allows the ones it did', async t => {
  const denied = await hostWith(t, 'narrate');
  await denied.host.load();
  await denied.host.enable('echo-speech', consent);
  await until(() => denied.logs.some(line => line.includes('NARRATE')));
  assert.match(denied.logs.find(line => line.includes('NARRATE'))!, /-32002/);

  const spoken: string[] = [];
  const allowed = await hostWith(t, 'narrate', {
    change: {permissions: ['speech.provide', 'voice.narrate']},
    services: {narrate: async text => { spoken.push(text); }},
  });
  await allowed.host.load();
  await allowed.host.enable('echo-speech', {...consent, permissions: ['speech.provide', 'voice.narrate']});
  await until(() => spoken.length === 1);
  assert.deepEqual(spoken, ['Hello from a plugin']);
});

test('stops a plugin that ignores shutdown', async t => {
  const {host} = await hostWith(t, 'slowExit');
  await host.load();
  await host.enable('echo-speech', consent);
  await until(async () => await stateOf(host) === 'running');
  const started = Date.now();
  await host.stopAll();
  assert.ok(Date.now() - started < 3_000);
  assert.equal(await stateOf(host), 'stopped');
});

test('reports a broken plugin without starting it', async t => {
  const {host} = await hostWith(t, 'speech', {change: {permissions: ['speech.provide', 'root.access']}});
  await host.load();
  const [info] = await host.list();
  assert.equal(info?.state, 'broken');
  assert.match(info?.problem ?? '', /Unknown permission/);
});
