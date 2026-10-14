# Building an Agent Buddy plugin

You are building a plugin for Agent Buddy, a desk companion that shows and speaks what AI coding agents are doing. A plugin is a separate program that the Agent Buddy companion service starts, talks to over stdin and stdout, and stops. Start from this folder: it is a working speech plugin that answers every line with a tone.

The full reference is [docs/plugins.md](../../docs/plugins.md) in the Agent Buddy repository. This file is the checklist.

## Golden rules

1. **stdout carries protocol messages only.** One JSON-RPC 2.0 message per line. Never `console.log`. Log with `host.log(level, message)` or to stderr.
2. **Exit when stdin closes.** `rpc.mjs` already does this. Don't remove it: it is how a plugin stops when the companion stops or crashes.
3. **Answer every request, even on failure.** Throw `PluginError(code, message)` for a known problem; `rpc.mjs` turns it into a JSON-RPC error. Use `-32003` (needs setup) when a required setting is missing, and `-32004` when your upstream service fails.
4. **Never log or return settings or secrets.** Error messages are shown to the user, so keep them short and plain.
5. **Do nothing slow at startup.** No network calls in `initialize`; answer it in well under 10 seconds. Check settings and report with `host.status('ready' | 'needsSetup' | 'error', message)`.
6. **No runtime dependencies, or bundle them.** Agent Buddy never runs `npm install` for a plugin. Ship a runnable `main` file. No native add-ons (`.node` files).
7. **Audio is mono, 24000 Hz, signed 16-bit little-endian, at most 15 seconds,** returned as base64 in `{audio: {encoding: "s16le", sampleRate: 24000, channels: 1, data}}`.
8. **Ask only for the permissions you use, and list every network host you call.** The user sees both before enabling the plugin.
9. **Files:** Node runs the plugin with `--permission`. It can read its own folder and read and write `params.plugin.dataDir` (also in `AGENT_BUDDY_PLUGIN_DATA`). Nothing else.

## Steps

1. Copy this folder to a new repository. Pick an `id`: lowercase letters, digits and dashes, unique to your plugin.
2. Edit `agent-buddy.plugin.json`: `id`, `name`, `version`, `description`, `publisher`, `homepage`, `permissions`, `network`, `contributes.speechProviders` and `contributes.settings`. Use a `secret` setting for API keys; give it a `help` link to where users get one.
3. Implement `index.mjs`. Keep `rpc.mjs` unchanged. Read settings from `initialize` and `settings/changed`.
4. Write tests in `test/` that run the plugin in-process with fake streams and a fake `fetch`, as `test/plugin.test.mjs` does. Cover: the handshake, missing settings (`-32003`), a good request, an upstream failure, and exit on stdin close.
5. Run `npm test`, then, from an Agent Buddy checkout, `npm run plugin check <your folder>`. Fix every `FAIL`. Pass `--settings fixture.json` to check with real settings.
6. Try it: `npm run plugin add <your folder>`, enable it in **Settings > Plugins**, fill in its settings, choose its voice in **Agents > Voice notifications**, and press **Play test**.
7. Tag a release. Users install with `npm run plugin add <your git URL>`.

## Definition of done

- `npm test` passes in the plugin.
- `npm run plugin check <folder>` prints `All checks passed.`, with and without `--settings`.
- The plugin reports `needsSetup` with a clear message until required settings are filled in.
- The README says what the plugin sends where (for example, "spoken lines are sent to Example Speech").
