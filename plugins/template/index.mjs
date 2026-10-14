// A speech plugin that answers every line with a short tone. Replace the tone with a call to your
// service; keep the rest. See AGENTS.md for the rules every plugin follows.
import {errors, PluginError, startPlugin} from './rpc.mjs';

const sampleRate = 24_000;
const maxSeconds = 15;
const pitches = {low: 330, high: 660};

// One tone per line: 0.4 s of a sine wave, mono signed 16-bit little-endian PCM at 24 kHz.
export function tone(frequency, seconds = 0.4) {
  const frames = Math.round(sampleRate * seconds);
  const pcm = Buffer.alloc(frames * 2);
  for (let frame = 0; frame < frames; frame++) {
    const fade = Math.min(1, frame / 240, (frames - frame) / 240);
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * frame / sampleRate) * 8000 * fade), frame * 2);
  }
  return pcm;
}

// Exported so the tests can run the plugin in-process with fake streams.
export function run(options = {}) {
  let settings = {};
  return startPlugin({
    ...options,
    methods: {
      initialize(params, host) {
        settings = params.settings ?? {};
        host.status('ready');
        return {api: '1.0'};
      },
      'speech/synthesize'(params) {
        if (params.provider !== 'tone') throw new PluginError(errors.invalidParams, 'Unknown provider.');
        const pcm = tone(pitches[settings.pitch] ?? pitches.low);
        if (pcm.length > sampleRate * maxSeconds * 2) throw new PluginError(errors.upstream, 'Audio is too long.');
        return {audio: {encoding: 's16le', sampleRate, channels: 1, data: pcm.toString('base64')}};
      },
    },
    notifications: {
      'settings/changed'(params) {
        settings = params.settings ?? {};
      },
    },
  });
}

