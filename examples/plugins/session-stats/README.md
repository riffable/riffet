# Session stats

A sidebar view that shows the open conversation's turn count, total and median turn duration, and the tools of its last turn. It is a custom view of a package that is not built in, so it runs in a sandboxed frame (Web) or a WebView (macOS) and reaches Riffet only through the message bridge (docs/PLUGIN_ARCHITECTURE.md, 自定义视图).

- `riffet-plugin.json`: the id `example.session-stats`, one `sidebar` view for `web` and `macos`, and the capability `sessions.read`, which the bridge needs for `sessions.outline` and `sessions.timeline`.
- `src/main.ts`: plain DOM. It negotiates the UI host with `connect({ requiredMethods })`, refreshes on project-scoped data invalidations, and calls from the bridge client, reads the outline and the last turn's rows, and styles itself with the pushed theme variables (`var(--fg)`, `var(--bg-subtle)`, ...).
- `web/index.js`: the web entry, built from `src/main.ts` with the bridge client bundled in. It is committed so the package runs as it is.

## Rebuild

```bash
node examples/plugins/session-stats/build.mjs
```

The script uses `esbuild` from the repository. Outside the repository, copy `packages/plugin-web/src/bridge.ts` and `bridge-client.ts` next to your source and bundle to one classic script (`--format=iife`).

## Run as a development package

```bash
riffet plugin dev examples/plugins/session-stats
# Remove the persistent link when finished:
riffet plugin unlink example.session-stats
```

A development package is trusted: it gets the capabilities it asks for without a grant, and its view still runs through the bridge.

## Install as a package

```bash
riffet plugin pack examples/plugins/session-stats --out /tmp/session-stats.tgz
riffet plugin install /tmp/session-stats.tgz
```

The package requests `sessions.read`: the view can read the conversations of the project it is open in, including their rows. `riffet plugin install` lists it and installs nothing until it is given `--yes`. A development package is trusted and gets it without a grant.
