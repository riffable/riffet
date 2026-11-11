# example.graphite-theme

A pure-assets appearance pack: one palette (light and dark) and a preset that selects it. There is
no server code and no capability, so installing it asks for nothing.

`assets/graphite.json` has the same shape as a custom theme (53 colour roles per mode, 16 ANSI
colours per mode); `id` and `name` in it are ignored, the contribution ids in `riffet-plugin.json`
identify it. The palette keeps the text ladder strictly decreasing, body and secondary text at
4.5:1 or better on the page, status and Agent colours at 3:1 or better, and the four Agent colours
apart from each other, in both modes.

```sh
riffet plugin pack examples/plugins/graphite-theme --out /tmp/graphite-theme.tgz
riffet plugin install /tmp/graphite-theme.tgz
```

The preset then appears in the appearance settings. See `docs/PLUGINS.md` and `docs/THEMES.md` section 7.
