#!/usr/bin/env node
// Checks that a plugin folder follows the Agent Buddy plugin rules, by running it the way the
// companion service does. Usage: node tools/plugin-check.mjs FOLDER [--settings settings.json]
// Exit code 0 means every check passed. Build the daemon first (npm run setup does).
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'daemon', 'dist', 'src');
const {hostApiVersion, isApiCompatible, loadPluginManifest, missingSettings, settingDefaults} =
  await import(pathToFileURL(join(dist, 'plugin-manifest.js')).href);
const {pluginEnvironment, pluginNodeArguments} = await import(pathToFileURL(join(dist, 'plugin-host.js')).href);
const {findNativeAddon} = await import(pathToFileURL(join(dist, 'plugin-install.js')).href);

const args = process.argv.slice(2);
const folderArg = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--settings');
const settingsFile = args.includes('--settings') ? args[args.indexOf('--settings') + 1] : undefined;
if (!folderArg) {
  console.error('Usage: node tools/plugin-check.mjs FOLDER [--settings settings.json]');
  process.exit(2);
}

let failures = 0;
const pass = message => console.log(`PASS ${message}`);
const fail = message => {
  failures++;
  console.log(`FAIL ${message}`);
};

const folder = await realpath(resolve(folderArg));
let manifest;
try {
  manifest = loadPluginManifest(folder, false);
  pass(`manifest: ${manifest.id} ${manifest.version}, permissions [${manifest.permissions.join(', ')}]`);
} catch (error) {
  fail(`manifest: ${error.message}`);
  process.exit(1);
}
if (isApiCompatible(manifest.api)) pass(`api ${manifest.api.major}.${manifest.api.minor} runs on host ${hostApiVersion.major}.${hostApiVersion.minor}`);
else fail(`api ${manifest.api.major}.${manifest.api.minor} needs a newer host than ${hostApiVersion.major}.${hostApiVersion.minor}`);
const addon = await findNativeAddon(folder);
if (addon) fail(`native add-on found: ${addon}`);
else pass('no native add-ons');

let settings = settingDefaults(manifest);
if (settingsFile) settings = {...settings, ...JSON.parse(await readFile(resolve(settingsFile), 'utf8'))};
const configured = missingSettings(manifest, settings).length === 0;

const data = await realpath(await mkdtemp(join(tmpdir(), 'plugin-check-')));
const child = spawn(process.execPath, pluginNodeArguments(manifest, folder, data), {
  cwd: folder, env: pluginEnvironment(manifest.id, data), stdio: ['pipe', 'pipe', 'pipe'],
});
let exited = null;
const exitedPromise = new Promise(done => child.once('exit', code => { exited = code ?? 'signal'; done(); }));
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });

// The checker is the host: it answers host methods and records what the plugin sends.
const replies = new Map();
const junk = [];
let buffer = '';
let nextId = 1;
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
      if (message.jsonrpc !== '2.0') throw new Error();
    } catch {
      junk.push(line);
      continue;
    }
    if (message.method === undefined) replies.get(message.id)?.(message);
    else if (message.id !== undefined)
      child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: message.id,
        error: {code: -32002, message: 'plugin-check does not grant host requests'}})}\n`);
  }
});
const request = (method, params, timeoutMs) => new Promise(done => {
  const id = nextId++;
  const timer = setTimeout(() => { replies.delete(id); done(null); }, timeoutMs);
  replies.set(id, message => { clearTimeout(timer); replies.delete(id); done(message); });
  child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`);
});

const init = await request('initialize', {
  api: `${hostApiVersion.major}.${hostApiVersion.minor}`,
  host: {name: 'agent-buddy', version: 'plugin-check', platform: process.platform},
  plugin: {id: manifest.id, version: manifest.version, dataDir: data},
  granted: manifest.permissions, settings,
}, 10_000);
if (!init) fail(`initialize: no answer in 10 s${exited !== null ? ` (exited ${exited})` : ''}${stderr ? `\n${stderr.trim()}` : ''}`);
else if (init.error) fail(`initialize: ${init.error.message}`);
else if (typeof init.result?.api !== 'string' || !/^1\.\d+$/.test(init.result.api)) fail('initialize: result must include "api": "1.x"');
else pass(`initialize answered with api ${init.result.api}`);
child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'initialized', params: {}})}\n`);

if (init && !init.error) {
  const ping = await request('$/ping', {}, 5_000);
  if (ping?.result) pass('$/ping answered');
  else fail('$/ping: no answer in 5 s');

  const unknown = await request('agent-buddy/no-such-method', {}, 5_000);
  if (unknown?.error?.code === -32601) pass('unknown methods get -32601');
  else fail('unknown methods must answer with error -32601');

  for (const provider of manifest.contributes.speechProviders) {
    const reply = await request('speech/synthesize', {provider: provider.id, text: 'This is Agent Buddy.', purpose: 'test'}, 20_000);
    if (!reply) {
      fail(`speech/synthesize ${provider.id}: no answer in 20 s`);
    } else if (reply.error) {
      if (!configured && reply.error.code === -32003) pass(`speech/synthesize ${provider.id} without settings asks for setup (-32003)`);
      else fail(`speech/synthesize ${provider.id}: ${reply.error.message}${configured ? '' : ' (expected -32003 while required settings are missing)'}`);
    } else {
      const audio = reply.result?.audio;
      const pcm = typeof audio?.data === 'string' ? Buffer.from(audio.data, 'base64') : Buffer.alloc(0);
      if (audio?.encoding !== 's16le' || audio.sampleRate !== 24000 || audio.channels !== 1)
        fail(`speech/synthesize ${provider.id}: audio must be {encoding: "s16le", sampleRate: 24000, channels: 1}`);
      else if (pcm.length === 0 || pcm.length % 2 || pcm.length > 24000 * 15 * 2)
        fail(`speech/synthesize ${provider.id}: audio must be 1 to 720000 bytes, an even count`);
      else pass(`speech/synthesize ${provider.id} returned ${(pcm.length / 48000).toFixed(2)} s of audio`);
    }
  }

  const shutdown = await request('shutdown', {}, 2_000);
  if (shutdown?.result) pass('shutdown answered');
  else fail('shutdown: no answer in 2 s');
}

child.stdin.end();
await Promise.race([exitedPromise, new Promise(done => setTimeout(done, 2_000))]);
if (exited === null) {
  fail('did not exit within 2 s of stdin closing');
  child.kill('SIGKILL');
} else {
  pass('exited when stdin closed');
}
if (junk.length) fail(`wrote ${junk.length} non-JSON-RPC line(s) to stdout; log to stderr or host/log. First: ${junk[0].slice(0, 80)}`);
else pass('stdout carried only JSON-RPC');
await rm(data, {recursive: true, force: true});

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
