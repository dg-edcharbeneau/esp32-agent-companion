import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {parsePluginManifest} from '../src/plugin-manifest.js';
import {consentCovers, isPluginConsent, PluginStore} from '../src/plugin-store.js';
import {fixtureManifest} from './plugin-fixtures.js';

const manifest = parsePluginManifest(fixtureManifest('echo-speech'));

async function withStore(run: (store: PluginStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-store-'));
  try {
    await run(new PluginStore(join(root, 'plugins.json'), join(root, 'plugin-state')), root);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

test('keeps secrets apart, private, and out of the public view', () => withStore(async (store, root) => {
  await store.saveSettings(manifest, {apiKey: 'sk-test-123', voice: 'b'});
  assert.deepEqual(await store.settings(manifest), {apiKey: 'sk-test-123', voice: 'b'});
  assert.deepEqual(await store.publicSettings(manifest), {apiKey: {set: true}, voice: 'b'});
  const secrets = join(root, 'plugin-state', 'echo-speech', 'secrets.json');
  assert.deepEqual(JSON.parse(await readFile(secrets, 'utf8')), {apiKey: 'sk-test-123'});
  assert.doesNotMatch(await readFile(join(root, 'plugin-state', 'echo-speech', 'settings.json'), 'utf8'), /sk-test/);
  if (process.platform !== 'win32') assert.equal((await stat(secrets)).mode & 0o777, 0o600);
  await store.saveSettings(manifest, {apiKey: null});
  assert.deepEqual(await store.publicSettings(manifest), {apiKey: {set: false}, voice: 'b'});
}));

test('records enablement, consent and quarantine, and forgets a plugin', () => withStore(async store => {
  assert.deepEqual(await store.record('echo-speech'),
                   {enabled: false, consent: null, quarantined: false, source: null});
  await Promise.all([
    store.update('echo-speech', {enabled: true}),
    store.update('echo-speech', {quarantined: true}),
  ]);
  const record = await store.record('echo-speech');
  assert.equal(record.enabled, true);
  assert.equal(record.quarantined, true);
  await store.saveSettings(manifest, {apiKey: 'sk'});
  await store.forget('echo-speech');
  assert.equal((await store.record('echo-speech')).enabled, false);
  assert.deepEqual(await store.settings(manifest), {voice: 'a'});
}));

test('consent must cover every permission and network host', () => {
  const consent = {version: '1.0.0', permissions: ['speech.provide' as const], network: ['api.example.com']};
  assert.equal(consentCovers(consent, manifest), true);
  assert.equal(consentCovers({...consent, network: []}, manifest), false);
  assert.equal(consentCovers({...consent, permissions: []}, manifest), false);
  assert.equal(consentCovers(null, manifest), false);
  assert.equal(isPluginConsent(consent), true);
  assert.equal(isPluginConsent({version: '1.0.0', permissions: 'all'}), false);
});
