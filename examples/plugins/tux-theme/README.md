# example.tux-theme

A complete pure-assets appearance pack demonstrating palettes, light/dark underlay wallpapers,
custom SVG logos, and a single preset that applies them together. No server code or capability is
requested.

- `assets/palette.json`: glacier light and aurora dark palette (53 colour roles and 16 ANSI colours
  per mode, meeting the contrast rules in `docs/THEMES.md`).
- `assets/bg-light.jpg` / `assets/bg-dark.jpg`: light glacier and dark aurora underlay wallpapers
  with `surfaceOpacity: 0.86`.
- `assets/logo.svg` / `assets/logo-dark.svg`: minimal Tux penguin mark for the sidebar header and
  browser favicon.

```sh
riffet plugin pack examples/plugins/tux-theme --out /tmp/tux-theme.tgz
riffet plugin install /tmp/tux-theme.tgz
```

## Credit & Licence

Inspired by Tux the Linux penguin, originally created by Larry Ewing (1996) and freely usable for
any purpose. All assets in this directory are original minimalist renditions contributed under the
repository's Apache-2.0 licence.
