import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  isApiCompatible, loadPluginManifest, missingSettings, parsePluginManifest, settingDefaults, validateSettingChange,
} from '../src/plugin-manifest.js';
import {fixtureManifest, writeFixturePlugin} from './plugin-fixtures.js';

const valid = fixtureManifest('echo-speech');
const parse = (change: Record<string, unknown>, folder?: string) =>
  parsePluginManifest({...valid, ...change}, folder);

test('reads a complete manifest', () => {
  const manifest = parsePluginManifest(valid, 'echo-speech');
  assert.equal(manifest.id, 'echo-speech');
  assert.deepEqual(manifest.api, {major: 1, minor: 0});
  assert.deepEqual(manifest.permissions, ['speech.provide']);
  assert.deepEqual(manifest.contributes.speechProviders, [{id: 'echo', name: 'Echo', description: undefined}]);
  assert.deepEqual(settingDefaults(manifest), {voice: 'a'});
  assert.deepEqual(missingSettings(manifest, settingDefaults(manifest)).map(field => field.key), ['apiKey']);
});

test('rejects manifests that would surprise the host or the user', () => {
  assert.throws(() => parse({}, 'other-name'), /folder must be named "echo-speech"/);
  assert.throws(() => parse({id: 'Echo'}), /lowercase/);
  assert.throws(() => parse({manifestVersion: 2}), /manifestVersion/);
  assert.throws(() => parse({version: '1.0'}), /semantic version/);
  assert.throws(() => parse({runtime: 'python'}), /runtime/);
  assert.throws(() => parse({main: '../escape.mjs'}), /inside the plugin folder/);
  assert.throws(() => parse({main: '/etc/passwd'}), /inside the plugin folder/);
  assert.throws(() => parse({permissions: ['speech.provide', 'device.everything']}), /Unknown permission/);
  assert.throws(() => parse({permissions: []}), /needs the speech.provide permission/);
  assert.throws(() => parse({network: ['not a host']}), /not a host name/);
  assert.throws(() => parse({homepage: 'http://example.com'}), /https/);
  assert.throws(() => parse({api: '1'}), /api must be a version/);
  const settings = (setting: Record<string, unknown>) => parse({contributes: {settings: [setting]}});
  assert.throws(() => settings({key: 'k', type: 'secret', title: 'K', default: 'x'}), /cannot have a default/);
  assert.throws(() => settings({key: 'k', type: 'select', title: 'K', options: [{value: 'a', label: 'A'}], default: 'z'}),
                /not one of the choices/);
  assert.throws(() => settings({key: 'k', type: 'color', title: 'K'}), /type must be one of/);
  assert.throws(() => settings({key: 'k', type: 'string', title: 'K', help: {text: 'Docs', url: 'javascript:alert(1)'}}),
                /https/);
  assert.throws(() => settings({key: 'k', type: 'string', title: 'K\u0007'}), /control characters/);
});

test('runs plugins built for this API major and an equal or older minor', () => {
  assert.equal(isApiCompatible({major: 1, minor: 0}, {major: 1, minor: 0}), true);
  assert.equal(isApiCompatible({major: 1, minor: 0}, {major: 1, minor: 3}), true);
  assert.equal(isApiCompatible({major: 1, minor: 4}, {major: 1, minor: 3}), false);
  assert.equal(isApiCompatible({major: 2, minor: 0}, {major: 1, minor: 9}), false);
});

test('checks setting changes against their fields', () => {
  const manifest = parsePluginManifest(valid);
  assert.deepEqual(validateSettingChange(manifest, {voice: 'b', apiKey: null}), {voice: 'b', apiKey: null});
  assert.throws(() => validateSettingChange(manifest, {voice: 'c'}), /Voice is not one of the choices/);
  assert.throws(() => validateSettingChange(manifest, {color: 'red'}), /not a setting/);
  assert.throws(() => validateSettingChange(manifest, ['voice']), /must be an object/);
});

test('loads a manifest from disk and keeps main inside the folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-manifest-'));
  try {
    const folder = await writeFixturePlugin(root, 'echo-speech');
    assert.equal(loadPluginManifest(folder).id, 'echo-speech');
    await writeFile(join(folder, 'agent-buddy.plugin.json'), JSON.stringify({...valid, main: 'dist/missing.mjs'}));
    assert.throws(() => loadPluginManifest(folder), /Build the plugin first/);
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside', 'evil.mjs'), '');
    await symlink(join(root, 'outside', 'evil.mjs'), join(folder, 'link.mjs'));
    await writeFile(join(folder, 'agent-buddy.plugin.json'), JSON.stringify({...valid, main: 'link.mjs'}));
    assert.throws(() => loadPluginManifest(folder), /outside the plugin folder/);
    await writeFile(join(folder, 'agent-buddy.plugin.json'), '{');
    assert.throws(() => loadPluginManifest(folder), /not valid JSON/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
