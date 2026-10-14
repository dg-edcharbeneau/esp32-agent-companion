# Template Tone

A copyable starting point for Agent Buddy plugins. It contributes one speech provider, **Tone**, that answers every spoken line with a short beep, so you can see the whole plugin lifecycle without an API key.

```bash
npm test                                  # in this folder
npm run plugin check plugins/template     # from the Agent Buddy repository
npm run plugin add plugins/template       # install it, then enable it in Settings > Plugins
```

To build your own plugin, copy this folder and follow [AGENTS.md](AGENTS.md). The protocol and manifest are documented in [docs/plugins.md](../../docs/plugins.md).
