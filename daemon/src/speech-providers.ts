import type {PluginHost, SpeechPurpose} from './plugin-host.js';
import {createSpeechSynthesizer, speechPacketFromPcm, type SpeechSynthesizer} from './speech.js';

export const systemSpeechProvider = 'system';

// "system", or "<plugin>/<provider>" for a provider a plugin contributes.
export function isSpeechProviderKey(value: unknown): value is string {
  return typeof value === 'string'
    && (value === systemSpeechProvider || /^[a-z0-9][a-z0-9-]{1,47}\/[a-z0-9][a-z0-9-]{1,47}$/.test(value));
}

export interface SpeechProviderInfo {
  key: string;
  name: string;
  plugin?: string;
  available: boolean;
  reason?: string;
}

// The built-in system voice plus the providers plugins contribute. Speech goes to the selected one.
export class SpeechProviders implements SpeechSynthesizer {
  readonly #plugins: Pick<PluginHost, 'speechProviders' | 'synthesize'>;
  readonly #system: SpeechSynthesizer;
  readonly #platform: NodeJS.Platform;
  readonly #selected: () => string;

  constructor(plugins: Pick<PluginHost, 'speechProviders' | 'synthesize'>, selected: () => string,
              system: SpeechSynthesizer = createSpeechSynthesizer(), platform = process.platform) {
    this.#plugins = plugins;
    this.#selected = selected;
    this.#system = system;
    this.#platform = platform;
  }

  get selected(): string {
    return this.#selected();
  }

  list(): SpeechProviderInfo[] {
    const system: SpeechProviderInfo = this.#platform === 'darwin'
      ? {key: systemSpeechProvider, name: 'System voice', available: true}
      : {key: systemSpeechProvider, name: 'System voice', available: false,
         reason: 'The system voice needs macOS. Add a speech plugin in Plugins.'};
    return [system, ...this.#plugins.speechProviders()];
  }

  // The selected provider, or one that explains why the selection can't speak.
  current(): SpeechProviderInfo {
    const key = this.#selected();
    return this.list().find(provider => provider.key === key)
      ?? {key, name: key, available: false, reason: `The speech provider "${key}" is not installed.`};
  }

  // Whether speech can work at all right now.
  get supported(): boolean {
    return this.current().available;
  }

  synthesize(text: string, purpose: SpeechPurpose = 'speak'): Promise<Buffer> {
    return this.synthesizeWith(this.#selected(), text, purpose);
  }

  async synthesizeWith(key: string, text: string, purpose: SpeechPurpose = 'speak'): Promise<Buffer> {
    if (key === systemSpeechProvider) return this.#system.synthesize(text);
    return speechPacketFromPcm(await this.#plugins.synthesize(key, text, purpose));
  }
}
