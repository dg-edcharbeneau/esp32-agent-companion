import assert from 'node:assert/strict';
import test from 'node:test';
import {isSpeechProviderKey, SpeechProviders} from '../src/speech-providers.js';
import {speechSampleRate} from '../src/speech.js';

function providers(selected: string, platform: NodeJS.Platform = 'darwin') {
  const calls: string[] = [];
  const plugins = {
    speechProviders: () => [
      {key: 'echo-speech/echo', name: 'Echo (Echo Speech)', plugin: 'echo-speech', available: true},
      {key: 'other/voice', name: 'Voice (Other)', plugin: 'other', available: false, reason: 'Add a key.'},
    ],
    synthesize: async (key: string, text: string) => {
      calls.push(`${key}:${text}`);
      return Buffer.alloc(4);
    },
  };
  const system = {synthesize: async (text: string) => Buffer.from(`system:${text}`)};
  return {registry: new SpeechProviders(plugins, () => selected, system, platform), calls};
}

test('lists the system voice first, then plugin providers', () => {
  const {registry} = providers('system');
  assert.deepEqual(registry.list().map(provider => provider.key), ['system', 'echo-speech/echo', 'other/voice']);
  assert.equal(registry.supported, true);
  assert.equal(providers('system', 'linux').registry.current().available, false);
  assert.match(providers('system', 'linux').registry.current().reason ?? '', /needs macOS/);
});

test('routes speech to the selected provider and wraps plugin audio for the device', async () => {
  const system = providers('system');
  assert.equal((await system.registry.synthesize('hi')).toString(), 'system:hi');
  const plugin = providers('echo-speech/echo');
  const packet = await plugin.registry.synthesize('hi');
  assert.equal(packet.toString('ascii', 0, 4), 'ACSP');
  assert.equal(packet.readUInt16LE(6), speechSampleRate);
  assert.equal(packet.readUInt32LE(8), 2);
  assert.deepEqual(plugin.calls, ['echo-speech/echo:hi']);
});

test('a provider that is missing or not ready explains why', () => {
  assert.equal(providers('other/voice').registry.current().reason, 'Add a key.');
  const missing = providers('gone/voice').registry.current();
  assert.equal(missing.available, false);
  assert.match(missing.reason ?? '', /not installed/);
  assert.equal(isSpeechProviderKey('deepgram-speech/flux'), true);
  assert.equal(isSpeechProviderKey('system'), true);
  assert.equal(isSpeechProviderKey('../etc'), false);
});
