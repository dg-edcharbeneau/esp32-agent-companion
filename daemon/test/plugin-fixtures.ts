import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// A tiny plugin that speaks the protocol. `behavior` changes what it does, for the host tests.
export type FixtureBehavior = 'speech' | 'crash' | 'hang' | 'noisy' | 'env' | 'narrate' | 'badAudio' | 'slowExit';

export function fixtureCode(behavior: FixtureBehavior): string {
  return `
import {createInterface} from 'node:readline';
const behavior = ${JSON.stringify(behavior)};
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
let settings = {};
let pending = new Map();
let nextId = 1;
const request = (method, params) => new Promise(resolve => {
  const id = nextId++;
  pending.set(id, resolve);
  send({jsonrpc: '2.0', id, method, params});
});
if (behavior === 'crash') process.exit(3);
if (behavior === 'noisy') for (let i = 0; i < 40; i++) console.log('hello from a library');
const lines = createInterface({input: process.stdin});
lines.on('line', async line => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
    return;
  }
  const answer = result => send({jsonrpc: '2.0', id: message.id, result});
  const fail = (code, text) => send({jsonrpc: '2.0', id: message.id, error: {code, message: text}});
  switch (message.method) {
    case 'initialize':
      settings = message.params.settings;
      if (behavior === 'env') process.stderr.write('ENV ' + JSON.stringify(Object.keys(process.env)) + '\\n');
      return answer({api: '1.0'});
    case 'initialized':
      if (behavior === 'narrate') {
        const result = await request('voice/narrate', {text: 'Hello from a plugin'});
        process.stderr.write('NARRATE ' + JSON.stringify(result) + '\\n');
      }
      return;
    case '$/ping':
      if (behavior === 'hang') return;
      return answer({});
    case 'settings/changed':
      settings = message.params.settings;
      return;
    case 'speech/synthesize': {
      if (!settings.apiKey) return fail(-32003, 'Add an API key.');
      if (behavior === 'badAudio') return answer({audio: {encoding: 'mp3', sampleRate: 24000, channels: 1, data: ''}});
      const pcm = Buffer.alloc(480);
      pcm.write(message.params.text.slice(0, 40));
      return answer({audio: {encoding: 's16le', sampleRate: 24000, channels: 1, data: pcm.toString('base64')}});
    }
    case 'shutdown':
      return answer({});
    case 'exit':
      if (behavior !== 'slowExit') process.exit(0);
      return;
    default:
      if (message.id !== undefined) fail(-32601, 'Method not found');
  }
});
lines.on('close', () => { if (behavior !== 'slowExit') process.exit(0); });
`;
}

export function fixtureManifest(id: string, change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id,
    name: 'Echo Speech',
    version: '1.0.0',
    description: 'Speaks by echoing the text as silence.',
    api: '1.0',
    runtime: 'node',
    main: 'index.mjs',
    permissions: ['speech.provide'],
    network: ['api.example.com'],
    contributes: {
      speechProviders: [{id: 'echo', name: 'Echo'}],
      settings: [
        {key: 'apiKey', type: 'secret', title: 'API key', required: true},
        {key: 'voice', type: 'select', title: 'Voice', default: 'a',
         options: [{value: 'a', label: 'A'}, {value: 'b', label: 'B'}]},
      ],
    },
    ...change,
  };
}

export async function writeFixturePlugin(root: string, id: string, behavior: FixtureBehavior = 'speech',
                                         change: Record<string, unknown> = {}): Promise<string> {
  const folder = join(root, id);
  await mkdir(folder, {recursive: true});
  await writeFile(join(folder, 'agent-buddy.plugin.json'), JSON.stringify(fixtureManifest(id, change)));
  await writeFile(join(folder, 'index.mjs'), fixtureCode(behavior));
  return folder;
}
