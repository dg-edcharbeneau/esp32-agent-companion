# RFC: Agent Buddy plugins

**Status:** proposal, with a working prototype
**Authors:** Ed Charbeneau, for discussion with Dan Wahlin and Brady Gaster
**Prototype:** [core plugin host](https://github.com/dg-edcharbeneau/esp32-agent-companion/tree/plugin-poc) (the `plugin-poc` branch; [just the plugin commits](https://github.com/dg-edcharbeneau/esp32-agent-companion/compare/ad07f91...plugin-poc) on top of #12) and the [Deepgram Speech plugin](https://github.com/dg-edcharbeneau/agent-buddy-deepgram-speech/tree/plugin-poc)

## Why

Features that depend on one agent or on a third-party service, such as Deepgram speech, agent-written narration or the upcoming Agent Mic, add code the core must keep working as those services change. Dan's goal is to keep Agent Buddy focused and stable, and let the people who build an integration maintain it.

This RFC proposes a plugin model for that. It covers:
- speech providers now
- microphone and speech-to-text plugins next
- a path for boards later

## Proposal in one paragraph

A plugin is a folder with a manifest, `agent-buddy.plugin.json`, and a JavaScript entry point. The companion service starts each enabled plugin as **its own process** and talks to it with **JSON-RPC 2.0 over stdin and stdout**, the same style as the existing Copilot MCP server, with an LSP-like `initialize` handshake. The manifest declares:
- **permissions**, such as `speech.provide`
- **network hosts**
- **contributions**: speech providers, plus settings the Settings page renders for it

The core owns the device, the voice queue, settings, secrets and consent. Plugins own their integrations, and live in their authors' repositories.

## Two integration surfaces

| Surface | Started by | Talks to the core through | Examples |
| --- | --- | --- | --- |
| **Hosted plugins** (new) | The companion service | stdio JSON-RPC, supervised | Speech providers, Agent Mic, narration generators |
| **Agent integrations** (existing) | The agent | The local socket | Hooks, the narrate MCP server |

Naming both surfaces settles where things go. An MCP server is started by the agent, so it stays an agent integration. A feature the companion should run in the background is a hosted plugin.

## Why separate processes

| Option | Verdict |
| --- | --- |
| In-process (`import()` of plugin code) | **No.** A plugin bug could crash or hang the service that drives the device and answers hooks. It would also see the service's memory (tokens, other secrets) and be tied to its internal types. |
| Reuse MCP | **No** for the semantics: speech providers, settings, events and host calls don't map onto tools, and MCP changes often. **Yes** for the wire style: newline-delimited JSON-RPC with a handshake. |
| Plugins call the socket themselves | Right for agent integrations; wrong for background plugins, which would each need their own service manager. |
| **Supervised sidecar** | **Chosen.** A crash or hang stays contained, the protocol is language-agnostic, and the only coupling is a versioned contract. |

## The contract

The full reference, for authors and coding agents, is [docs/plugins.md](https://github.com/dg-edcharbeneau/esp32-agent-companion/blob/plugin-poc/docs/plugins.md), with a [JSON schema for the manifest](https://github.com/dg-edcharbeneau/esp32-agent-companion/blob/plugin-poc/docs/schemas/plugin-manifest-v1.json). The first plugin's manifest:

```json
{
  "manifestVersion": 1,
  "id": "deepgram-speech",
  "name": "Deepgram Speech",
  "version": "0.1.0",
  "api": "1.0",
  "runtime": "node",
  "main": "main.mjs",
  "permissions": ["speech.provide"],
  "network": ["api.deepgram.com"],
  "contributes": {
    "speechProviders": [{"id": "flux", "name": "Deepgram Flux"}],
    "settings": [
      {"key": "apiKey", "type": "secret", "title": "Deepgram API key", "required": true},
      {"key": "voice", "type": "select", "title": "Voice", "default": "flux-haley-en", "options": ["…"]}
    ]
  }
}
```

Speaking one line. Audio comes back as mono 24 kHz signed 16-bit PCM, at most 15 seconds, which is exactly what the device's `/speech` stream plays:

```text
companion → plugin  {"jsonrpc":"2.0","id":7,"method":"speech/synthesize",
                     "params":{"provider":"flux","text":"All done.","purpose":"notification"}}
plugin → companion  {"jsonrpc":"2.0","id":7,"result":{"audio":{"encoding":"s16le",
                     "sampleRate":24000,"channels":1,"data":"<base64>"}}}
```

In short:

- **Host → plugin:**
  - lifecycle: `initialize` / `initialized`, `$/ping`, `shutdown` / `exit`
  - `settings/changed`
  - `speech/synthesize` → mono 24 kHz s16le audio (base64, at most 15 s)
  - `events/state`, `events/agent` (sanitized)
- **Plugin → host:** `host/status` (ready, needsSetup, error), `host/log`, `host/getStatus`, `voice/narrate`.
- **Supervision:**
  - restart with backoff (1 s up to 60 s)
  - quarantine after 5 crashes in 10 minutes, kept across restarts
  - two missed pings mean a restart
  - plugins exit when stdin closes
- **Versioning:** `api` is `major.minor`, and changes within a major are additive only. A breaking change means API 2, and the host supports N and N−1 for at least one release.

## What the user sees

- **Install from a terminal.** `npm run plugin add <folder or git URL>` copies or clones the plugin into place. **Nothing in it runs**: no `npm install`, no scripts.
- **Enable with consent.** **Settings > Plugins** lists plugins. Enabling one shows what it asks for (permissions and network hosts) and records consent for that version. A new version that asks for more needs consent again.
- **Settings come from the manifest.** The page renders each plugin's settings with `textContent` only; no plugin code runs in the page. Secrets show only "Saved".
- **Choosing a voice.** Speech providers appear in **Agents > Voice notifications > Voice** next to the system voice, with a **Play test** button. If the chosen plugin is missing or needs setup, the page says why.

## Security model

This is the same trust level as editor extensions: code the user chose to install, running as the user. The core limits the damage of a buggy plugin; it is not a sandbox.

- Node's `--permission` limits the filesystem to the plugin's folder and data. There are no child processes without `process.spawn`, and no native add-ons.
- A 128 MB heap limit.
- A scrubbed environment, without the socket path or settings token.
- Network access is not restricted in Node 24, so the declared hosts are shown at consent.
- Secrets are stored in 0600 files, passed only to their own plugin, and never appear in status.

## Cost

- **Core:** about 1.1k lines of TypeScript and JavaScript, plus tests:
  - manifest validation, the RPC peer, the supervisor, the settings and secrets store
  - install and remove
  - the speech-provider registry
  - the Plugins tab
  - the CLI
- **Outside the runtime:**
  - the template plugin and its `AGENTS.md`
  - `tools/plugin-check.mjs`, the conformance checker an agent iterates against until it prints "All checks passed"
  - the docs

## How it covers the other asks

- **Deepgram speech.** It moves entirely out of core into `agent-buddy-deepgram-speech`: a manifest, a secret API key with a signup link, eight Flux voices and about 200 lines of code. Device-side Deepgram from #29 is dropped, so the firmware stays vendor-neutral and plugin audio uses #12's generic `/speech` stream.
- **Agent Mic.** It fits as API 1.1, built on core primitives that any microphone plugin would share:
  - **Firmware:** ES7210 capture on the shared I2S clocks (DSIN GPIO10) and a `/listen` stream.
  - **Host API:** `audio/startCapture` → `audio/frames`, and `events/input` for a push-to-talk tap.
  - **The plugin:** what happens with the transcript.
  
  A "listening" animation is a character state, so it's core work and should be proposed separately.
- **Narration for Claude Code and Codex.**
  - The generic `--narrate-only` MCP flag can go upstream as an agent integration.
  - Narration written by an LLM or a service becomes a hosted plugin that subscribes to `events/agent` and calls `voice/narrate`.
- **Boards.** Boards are compile-time firmware (`firmware/boards.json` plus `src/boards/<dir>`), so daemon plugins can't add them. That needs its own RFC: a documented driver interface, a contribution guide and a CI build matrix. v1 helps only by letting plugins check device capabilities rather than board names.

## The prototype

Everything above exists and was tested on a Waveshare 1.75-C.

- **Core** ([`plugin-poc`](https://github.com/dg-edcharbeneau/esp32-agent-companion/tree/plugin-poc), built on #12):
  - the plugin host, a Plugins tab, a voice picker and `npm run plugin`
  - a [template plugin](https://github.com/dg-edcharbeneau/esp32-agent-companion/tree/plugin-poc/plugins/template) with an `AGENTS.md` checklist for coding agents
  - `npm run plugin check`, which runs a plugin under the same sandbox as the host and prints "All checks passed" when it follows the rules
- **[Deepgram Speech plugin](https://github.com/dg-edcharbeneau/agent-buddy-deepgram-speech/tree/plugin-poc)**, in its own repository: one voice provider, eight Flux options and an API key setting.
- **Tests:** 324 core tests, 3 template tests and 8 plugin tests pass. The conformance check passes with and without a key; with a key it fetched real Deepgram audio.
- **On the device:**
  - A line spoke clearly through the plugin.
  - Killing the plugin, it restarted in about 2 seconds.
  - With the key removed, the voice explained what to fix.
  - The key never appeared in status or the logs.
- **Size:** the core contains no Deepgram code, and the firmware fell from 76% to 69% of flash.

## Decisions for Dan and Brady

1. **Sidecar processes** speaking stdio JSON-RPC, rather than in-process modules.
2. **Node only in v1** (the companion already ships Node); a generic `exec` runtime later.
3. **CLI-only install with consent**; nothing installs from the browser.
4. **The template and checker live in core**, so every plugin is checked the same way.

## Rollout

1. **The 1.75-C audio fix.** Open as #30.
2. **Land #12** (generic speech streaming and voice notifications). Open.
3. **Land the plugin host.** Prototype built: `plugin-poc`, to be cleaned up into a PR that depends on #12.
4. **Publish `agent-buddy-deepgram-speech`** from its own repository as the first plugin. Prototype built.
5. **API 1.1:** audio capture for Agent Mic. Next.
