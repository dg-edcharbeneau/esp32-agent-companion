import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {run, tone} from '../index.mjs';

// Runs the plugin in-process, the way the host talks to it, and collects what it writes.
function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  let exited = null;
  output.on('data', chunk => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) messages.push(JSON.parse(line));
  });
  run({input, output, exit: code => { exited = code; }});
  const send = message => input.write(`${JSON.stringify(message)}\n`);
  const reply = async id => {
    for (let i = 0; i < 100; i++) {
      const found = messages.find(message => message.id === id && message.method === undefined);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`No reply to ${id}`);
  };
  return {send, reply, messages, input, exited: () => exited};
}

test('answers the handshake with API 1.0 and reports ready', async () => {
  const plugin = harness();
  plugin.send({jsonrpc: '2.0', id: 1, method: 'initialize', params: {api: '1.0', settings: {pitch: 'low'}}});
  assert.deepEqual((await plugin.reply(1)).result, {api: '1.0'});
  assert.ok(plugin.messages.some(message => message.method === 'host/status' && message.params.state === 'ready'));
});

test('returns mono 24 kHz signed 16-bit audio, at most 15 seconds', async () => {
  const plugin = harness();
  plugin.send({jsonrpc: '2.0', id: 1, method: 'initialize', params: {settings: {}}});
  plugin.send({jsonrpc: '2.0', id: 2, method: 'speech/synthesize', params: {provider: 'tone', text: 'Hi', purpose: 'test'}});
  const {audio} = (await plugin.reply(2)).result;
  assert.equal(audio.encoding, 's16le');
  assert.equal(audio.sampleRate, 24000);
  assert.equal(audio.channels, 1);
  const pcm = Buffer.from(audio.data, 'base64');
  assert.equal(pcm.length % 2, 0);
  assert.ok(pcm.length > 0 && pcm.length <= 24000 * 15 * 2);
  assert.deepEqual(pcm, tone(330));
});

test('answers unknown methods with -32601 and exits when the host closes stdin', async () => {
  const plugin = harness();
  plugin.send({jsonrpc: '2.0', id: 9, method: 'no/such', params: {}});
  assert.equal((await plugin.reply(9)).error.code, -32601);
  plugin.input.end();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(plugin.exited(), 0);
});
