Paper: a colour palette of near-neutral ink and low-chroma paper, with the Inter font and a paper grain background, plus a preset of the same name. It contains only palette, font, background and preset, with no server entry. The font licence is in `assets/Inter-OFL.txt`.

## Development

No package.json, Node dependencies, lockfile or SDK is needed. With Riffet installed:

```sh
riffet plugin pack .
riffet plugin install "$PWD/dist/riffet.appearance-paper-1.0.0.tgz" --trusted

# After editing assets: validate and refresh the local Riffet automatically
riffet plugin dev .
riffet plugin unlink riffet.appearance-paper
```

If a version with the same ID is already installed, uninstall it before developing. Quitting the watcher keeps the development link; only `unlink` removes it.

`--trusted` keeps the official `riffet.` identity; a resource-only package never starts server code. The build directory and archive are written to this plugin's `dist/`; `--format zip` or `--format tar` switches the archive format. A failed build keeps the last successful output.

`riffet-plugin.json` is the source of the declaration and the resources are in `assets/`. `scripts/generate-grain.mjs` only regenerates the paper grain, uses Node built-ins, and is neither run nor shipped when packing.
