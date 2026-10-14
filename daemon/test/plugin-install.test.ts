import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {addPlugin, isGitSource, removePlugin} from '../src/plugin-install.js';
import {PluginStore} from '../src/plugin-store.js';
import {writeFixturePlugin} from './plugin-fixtures.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'plugin-install-'));
  const directory = join(root, 'installed');
  const store = new PluginStore(join(root, 'plugins.json'), join(root, 'plugin-state'));
  return {root, directory, store, done: () => rm(root, {recursive: true, force: true})};
}

test('copies a plugin folder into place without running anything', async () => {
  const {root, directory, store, done} = await setup();
  try {
    const source = await writeFixturePlugin(join(root, 'src'), 'echo-speech');
    await writeFile(join(source, 'postinstall.sh'), 'touch should-not-run');
    const result = await addPlugin(source, {directory, store});
    assert.equal(result.manifest.id, 'echo-speech');
    assert.equal(result.previousVersion, null);
    assert.equal(result.needsConsent, true);
    assert.ok(existsSync(join(directory, 'echo-speech', 'index.mjs')));
    assert.ok(!existsSync(join(directory, 'echo-speech', 'should-not-run')));
    assert.deepEqual((await store.record('echo-speech')).source?.type, 'path');
    // Installing again updates in place and leaves no staging folders behind.
    assert.equal((await addPlugin(source, {directory, store})).previousVersion, '1.0.0');
    assert.deepEqual(await readdir(directory), ['echo-speech']);
    await removePlugin('echo-speech', {directory, store});
    assert.ok(!existsSync(join(directory, 'echo-speech')));
  } finally {
    await done();
  }
});

test('refuses broken manifests and native add-ons', async () => {
  const {root, directory, store, done} = await setup();
  try {
    const broken = await writeFixturePlugin(join(root, 'src'), 'echo-speech', 'speech', {permissions: ['root.access']});
    await assert.rejects(addPlugin(broken, {directory, store}), /Unknown permission/);
    const native = await writeFixturePlugin(join(root, 'src2'), 'echo-speech');
    await writeFile(join(native, 'addon.node'), '');
    await assert.rejects(addPlugin(native, {directory, store}), /native add-ons/);
    assert.deepEqual(existsSync(directory) ? await readdir(directory) : [], []);
  } finally {
    await done();
  }
});

test('clones a git source and records the commit', async t => {
  try {
    execFileSync('git', ['--version']);
  } catch {
    t.skip('git is not installed');
    return;
  }
  const {root, directory, store, done} = await setup();
  try {
    const source = await writeFixturePlugin(join(root, 'repo'), 'echo-speech');
    const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], {stdio: 'pipe'});
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
    assert.equal(isGitSource(`${source}/.git`), true);
    await addPlugin(`${source}/.git`, {directory, store});
    const record = await store.record('echo-speech');
    assert.equal(record.source?.type, 'git');
    assert.match(record.source?.commit ?? '', /^[0-9a-f]{40}$/);
    assert.ok(!existsSync(join(directory, 'echo-speech', '.git')));
  } finally {
    await done();
  }
});
