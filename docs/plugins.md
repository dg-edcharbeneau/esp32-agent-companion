# Plugins

Plugins add features that Agent Buddy doesn't build in, such as voices from a speech service. Each plugin is maintained by its author, runs as its own program, and talks to the companion service through a small, versioned protocol. Agent Buddy itself stays small: the companion owns the device, settings and secrets, and plugins own their integrations.

To build one, start from [plugins/template](../plugins/template) and follow its [AGENTS.md](../plugins/template/AGENTS.md). This page is the reference.

## How it works

```
companion service ──spawns──▶ plugin process (node <main>)
        │  stdin:  JSON-RPC requests and notifications from the host
        │  stdout: JSON-RPC responses and notifications from the plugin
        │  stderr: log lines
        └── settings, secrets, consent, device, voice queue stay in the service
```

- **Where plugins live.** `npm run plugin add` installs each plugin into `<data>/plugins/<id>/`. That folder is kept apart from the companion's own runtime, so app updates don't remove it. Settings and secrets live in `<data>/plugin-state/<id>/`.
- **When a plugin starts.** The companion starts a plugin only when the user has enabled it and agreed to what that version asks for.
- **If it fails.** The companion restarts a plugin that crashes or stops answering, waiting 1, 2, 4, 8, 16, 32, then 60 seconds. After 5 crashes in 10 minutes it is quarantined until the user restarts it from **Settings > Plugins**.
- **How it runs.** v1 plugins are JavaScript. They run on the Node.js that ships with the companion, so users don't install anything.

Plugins that an *agent* launches (hooks, MCP servers such as the narrate server in `plugins/copilot-app-companion`) are a different surface: they call the companion's local socket and are not managed here.

## Commands

| Command | What it does |
| --- | --- |
| `npm run plugin list` | Lists installed plugins and their state |
| `npm run plugin add FOLDER\|GIT-URL` | Copies or clones a plugin into place. Nothing in it runs. |
| `npm run plugin enable ID` | Shows what the plugin asks for and enables it after you agree |
| `npm run plugin disable ID` / `restart ID` | Stops it / restarts it (restart also clears a quarantine) |
| `npm run plugin set ID KEY [VALUE]` | Sets a setting. Secrets are typed at a hidden prompt or piped in, never passed as arguments. |
| `npm run plugin remove ID [--keep-data]` | Removes the plugin, and its settings and secrets unless `--keep-data` |
| `npm run plugin check FOLDER [--settings FILE]` | Runs the conformance checks that a plugin must pass |
| `npm run speech [PROVIDER]` | Lists voices, or picks one: `system` or `<plugin>/<provider>` |

Plugins are never installed from the Settings page.

## Manifest: `agent-buddy.plugin.json`

The manifest sits at the root of the plugin folder. The schema is [schemas/plugin-manifest-v1.json](schemas/plugin-manifest-v1.json).

```json
{
  "manifestVersion": 1,
  "id": "example-speech",
  "name": "Example Speech",
  "version": "0.1.0",
  "description": "Speaks Agent Buddy's lines with Example's voices.",
  "publisher": "Example, Inc.",
  "homepage": "https://github.com/example/agent-buddy-example-speech",
  "license": "MIT",
  "api": "1.0",
  "runtime": "node",
  "main": "dist/main.mjs",
  "permissions": ["speech.provide"],
  "network": ["api.example.com"],
  "contributes": {
    "speechProviders": [{"id": "neural", "name": "Example Neural"}],
    "settings": [
      {"key": "apiKey", "type": "secret", "title": "Example API key", "required": true,
       "help": {"text": "Get an API key", "url": "https://example.com/keys"}},
      {"key": "voice", "type": "select", "title": "Voice", "default": "ava",
       "options": [{"value": "ava", "label": "Ava"}, {"value": "leo", "label": "Leo"}]}
    ]
  }
}
```

| Field | Rules |
| --- | --- |
| `id` | 2–48 lowercase letters, digits and dashes. The installed folder is named after it. |
| `version` | Semantic version. A new version that asks for more permissions or hosts needs the user's consent again. |
| `api` | The lowest plugin API the plugin needs, `major.minor`. The host runs it when the major matches and its minor is the same or newer. |
| `runtime` | `"node"` in v1. |
| `main` | A file inside the plugin folder, already built. No install or build step runs. |
| `permissions` | See below. Unknown names are rejected. |
| `network` | Every host the plugin connects to. Shown at consent; not enforced in v1. |
| `contributes.speechProviders` | Up to 4. Selected as `<plugin id>/<provider id>`. Needs `speech.provide`. |
| `contributes.settings` | Up to 20 fields. Types: `string`, `secret`, `select`, `boolean`, `number`. Optional `required`, `default` (not for secrets), `pattern` (text), `min`/`max` (number), `description`, and `help: {text, url}` with an https URL. |

### Permissions

| Permission | Grants |
| --- | --- |
| `speech.provide` | Receives `speech/synthesize` for its providers (the spoken text is sent to the plugin) |
| `events.state` | Receives `events/state`: the character's state changes |
| `events.agent` | Receives `events/agent`: which agent and which hook event, never prompts, tool input or session ids |
| `voice.narrate` | May call `voice/narrate` to speak a line, under the user's voice mode and limits |
| `status.read` | May call `host/getStatus` for a small, sanitized status |
| `process.spawn` | May start child processes (Node's `--allow-child-process`) |

## Protocol (API 1.0)

The protocol is JSON-RPC 2.0, one UTF-8 message per line, at most 4 MiB per line. Both sides may have several requests in flight. Unknown fields and notifications are ignored, and unknown requests answer `-32601`.

### Host to plugin

| Method | Kind | Params → result |
| --- | --- | --- |
| `initialize` | request, 10 s | `{api, host: {name, version, platform}, plugin: {id, version, dataDir}, granted, settings}` → `{api: "1.0"}` |
| `initialized` | notification | Sent after the handshake; the plugin may call the host from now on |
| `settings/changed` | notification | `{settings}`, every value including secrets, after the user saves |
| `speech/synthesize` | request, 20 s | `{provider, text, purpose}` → `{audio: {encoding: "s16le", sampleRate: 24000, channels: 1, data: <base64>}}` |
| `events/state` | notification | `{state, previous, at}` (needs `events.state`) |
| `events/agent` | notification | `{agent, event, at}` (needs `events.agent`) |
| `$/ping` | request, every 30 s | `{}` → `{}`. Two missed answers restart the plugin. |
| `$/cancelRequest` | notification | `{id}`: the host stopped waiting for that request |
| `shutdown` | request, 2 s | `{}` → `{}`, then `exit` and stdin closes. A plugin that doesn't exit is killed 2 s later. |

- **`speech/synthesize` purposes:** `notification`, `narration`, `speak` or `test`.
- **Speech text:** at most 500 characters.
- **Audio:** mono 24 kHz signed 16-bit little-endian, 1 frame to 15 seconds. The host checks the format and length before it reaches the device.

### Plugin to host

| Method | Kind | Params → result |
| --- | --- | --- |
| `host/status` | notification | `{state: "ready" \| "needsSetup" \| "error", message?}`, shown in **Plugins** and as the voice's reason |
| `host/log` | notification | `{level: "info" \| "warn" \| "error", message}`, written to the companion log |
| `host/getStatus` | request | `{}` → `{state, connected, transport, wifi, voiceMode}` (needs `status.read`) |
| `voice/narrate` | request | `{text}` → `{}` (needs `voice.narrate`; contextual mode and narration limits apply) |

### Errors

The standard JSON-RPC codes apply, plus the codes below. An error's `message` is shown to the user. Keep it short, and never include secrets.

| Code | Meaning |
| --- | --- |
| `-32001` | Called before the handshake finished |
| `-32002` | The plugin lacks the permission for that host method |
| `-32003` | Needs setup, such as a missing API key; the message says what to do |
| `-32004` | The plugin's service failed or is rate limited |
| `-32005` | Busy; try again later |
| `-32800` | Cancelled |

## Security model

A plugin is code the user chose to install, running as the user. The companion limits the damage of a buggy plugin; it is **not** a sandbox against a malicious one.

- Node runs plugins with `--permission`. A plugin can read its own folder and read and write its data folder, and nothing else on disk. Child processes need `process.spawn`, and native add-ons and workers are not allowed.
- The memory limit is 128 MB.
- The environment is reduced to PATH, HOME, TEMP, locale and proxy variables, plus `AGENT_BUDDY_PLUGIN_ID` and `AGENT_BUDDY_PLUGIN_DATA`. Plugins never see the companion's socket, settings token or other plugins' secrets.
- Network access is not restricted in Node 24. The `network` list is shown to the user at consent.
- Secrets are stored in `<data>/plugin-state/<id>/secrets.json` with mode 0600 and given only to their plugin. Status and the Settings page say only whether a secret is set.
- The Settings page renders plugin text with `textContent` and opens only https links. No plugin code runs in the page.
- Installing never runs plugin code: no `npm install`, no scripts.

## Versioning

- **Within API major 1, changes are additive.** New methods, new optional fields and new permissions can appear. Plugins ask for the minor version they need in `api`, and feature-detect from `initialize`.
- **A breaking change becomes API 2.** The host then supports 1 and 2 for at least one release.
- **The manifest has its own `manifestVersion`.**

## Planned

These are not in v1:

- An `exec` runtime for plugins that aren't JavaScript.
- Audio capture for microphone plugins: `audio/startCapture` and `audio/frames`, which need a firmware `/listen` stream.
- Device input events.
- Installing from npm.
- Signed plugins.
