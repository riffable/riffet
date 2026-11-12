# Riffet Plugin API

API v1 for Riffet product plugins. Stable entry points are the manifest, lifecycle, model-source, command and task contracts; Agent interfaces and the in-app Web SDK remain experimental. `@riffet/plugin-api/experimental/agent` makes that boundary explicit while the existing root exports remain compatible.

The package ships compiled ESM, TypeScript declarations, the manifest JSON Schema and the `riffet-plugin` executable. It does not import a Riffet checkout or private host implementation.

The SDK is not published to a registry yet. Inside a Riffet checkout the sources are in `packages/plugin-api`; to consume it from a separate plugin, build the archives (see below) and pin them as a dependency. [`examples/plugins`](../../examples/plugins) shows plugins that need no SDK at all.

```json
{
  "$schema": "<path to riffet-plugin.schema.json>",
  "id": "example.plugin",
  "vendor": "Example",
  "name": "Example",
  "apiVersion": 1,
  "version": "1.0.0",
  "defaultEnabled": true,
  "activation": ["startup"],
  "entries": { "server": "server/index.mjs" }
}
```

`$schema` is optional editor completion: point it at `packages/plugin-api/riffet-plugin.schema.json` in a Riffet checkout, or at the same file inside an installed SDK package (`node_modules/@riffet/plugin-api/riffet-plugin.schema.json`).

Package and develop from a plugin directory:

```sh
riffet plugin pack
riffet plugin pack ./my-plugin --format zip
riffet plugin dev ./my-plugin
```

`pack` builds current sources, validates the result and creates `dist/<id>-<version>.tgz`. `--format tgz|tar|zip` chooses the container (`tar.gz` is an alias for `tgz`); `--out <file>` changes its location. The intermediate installable package lives in the plugin's own `dist/package`. Failed builds preserve the previous successful package and archive. `pack dist/package` also accepts an existing built package. No plugin lifecycle scripts run during packaging or validation.

A resource plugin needs only `riffet-plugin.json`, `assets/` and its license files. It does not need a package.json, SDK dependency, build configuration or node_modules. Omit the example's `$schema` reference when no SDK is installed, and omit `entries` when there is no executable code. Use the Riffet CLI to package or watch these directories.

For plugins with code, the build uses `index.ts` for the server and `web/index.ts` for the Web entry, writing to the paths declared in `entries`. JavaScript sources and already prepared manifest entry paths also work. Dependencies are bundled by esbuild; assets, declared icons and license files accompany the output. Source tests, vendor archives, package metadata and node_modules do not enter the installable package. Keep SDKs and other compilation tools in devDependencies.

Extra server entry points can be declared once in the plugin's package.json:

```json
{
  "riffetPlugin": {
    "build": {
      "entries": { "route-daemon": "route-daemon.ts" }
    }
  }
}
```

These entries are emitted next to `entries.server`, using its extension. `--entry route-daemon=route-daemon.ts` remains available for an override or a one-off build.

`dev` builds, links the output to the local Riffet host, watches source changes and reloads after successful builds. The host CLI owns registration and reload; no separate `RIFFET_DEV_PLUGINS` launch is needed. If Riffet is stopped, the directory is linked for its next start; the command does not start a host. Links persist after the watcher exits; `riffet plugin unlink <id>` removes them while keeping settings and data. Use `--state-dir` for a non-default host; an installed version with the same ID must be removed before linking development code. Failed rebuilds retain the running package. With a locally installed SDK, `riffet-plugin pack` uses the same implementation and `riffet-plugin dev` delegates to `riffet plugin dev`; `--riffet <executable>` selects that host executable. `riffet-plugin dev --build-only` watches and builds without linking or starting a host. The lower-level `riffet-plugin build [directory]` and `riffet-plugin check [directory]` commands remain available.

Manifest validation and JSON Schema come from `@riffet/plugin-api/manifest`. Structural rules power editor completion; ownership, duplicate identities and declared contribution references are additionally checked at runtime. The JSON Schema does not grant permissions. Installation trust belongs to the host's version record.

The `@riffet/plugin-api/tooling` entry point exports `buildPlugin(sourceDir, options)`, `packSource(sourceDir, options)` and `watchPlugin(sourceDir, options)` for CLI integrations. Build results include `manifest`, `directory` and `sourceDirectory`; pack results additionally include `file`, archive bytes, integrity, capabilities and warnings. `watchPlugin` calls `onBuild` after its initial build and subsequent successful builds, reports later failures to `onError`, and returns an `initial` result and a `close()` handle. It does not start Riffet or exit the process. The existing `packPlugin(directory)` API continues to validate and archive an already built directory without compiling it.

Build the SDK archives from a Riffet checkout with `node scripts/build-plugin-sdk.mjs --out <directory>`. This creates publishable archives locally and never publishes to a registry. Pin those archives, or an approved registry release, inside each independently built plugin.

Plugins that need Riffet's CLI, process, credential or other in-process host APIs declare `requiresTrustedHost: true` in the manifest. This is a requirement, not a trust grant. Local Web/Mac imports ask for explicit trust before installation; remote clients must install on the service machine. Legacy model-source IDs remain compatible through the same explicit-trust flow.

Plugin details offer whole-plugin uninstall (all versions, settings and data retained) or removal of a development package while keeping its source directory. Development removal also persists an exclusion from automatic discovery; explicitly linking the directory again restores it. `riffet plugin uninstall <id> [version]` provides the same whole-plugin or single-version choice. A running dev watcher never restores a removed link.
