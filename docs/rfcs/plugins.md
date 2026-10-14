# RFC: Agent Buddy plugins

**Status:** proposal, with a working prototype
**Authors:** Ed Charbeneau, for discussion with Dan Wahlin and Brady Gaster
**Prototype:** the `plugin-poc` branch (core host) and `agent-buddy-deepgram-speech` (first plugin)

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

The full reference, for authors and coding agents, is [docs/plugins.md](../plugins.md). In short:

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

## Decisions for Dan and Brady

1. **Sidecar processes** speaking stdio JSON-RPC, rather than in-process modules.
2. **Node only in v1** (the companion already ships Node); a generic `exec` runtime later.
3. **CLI-only install with consent**; nothing installs from the browser.
4. **The template and checker live in core**, so every plugin is checked the same way.

## Rollout

1. **The 1.75-C audio fix** goes in as its own PR (branch `fix-175c-audio-clock`).
2. **Land #12** (generic speech streaming and voice notifications).
3. **Land the plugin host:** `plugin-poc`, cleaned up into a PR that depends on #12.
4. **Publish `agent-buddy-deepgram-speech`** from its own repository as the first plugin.
5. **API 1.1:** audio capture for Agent Mic.
