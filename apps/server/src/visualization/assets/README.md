# Visualization preview assets

`visualize.css` and `visualize.html` are Riffet's own implementation of the
preview contract used by generated conversation artifacts. `renderVisualization`
loads both files and serves them inline, so a preview needs neither an installed
plugin nor a third-party runtime.

## Contract

- `visualize.html` starts with `<!--__INLINE_VISUALIZATION_FRAGMENT__-->`. The
  server removes that marker and appends the remaining runtime to the preview
  body. Keep the marker first.
- `visualize.css` is injected into a `<style>` element in the document head.
  `:root` exposes `--font-size-base`, the light/dark tokens and the status
  colors used by the components below.
- The server injects the local interaction-state bridge and the sandbox
  resource policy. The assets do not define that bridge and do not call a
  Riffet API.

## Classes

The stylesheet keeps the class names generated artifacts already use:

`btn` `btn-ghost` `btn-primary` `card` `cursor-interaction` `form-check`
`form-check-input` `form-check-label` `form-control` `form-control-color`
`form-label` `form-range` `form-select` `form-switch` `is-selected` `nav`
`nav-justified` `nav-link` `nav-pills` `progress` `progress-bar` `sr-only`
`table` `table-responsive` `tabular-nums` `text-destructive` `text-muted`
`text-small` `text-warning` `tooltip` `viz-badge` `viz-carousel`
`viz-carousel-caret` `viz-carousel-controls` `viz-carousel-count`
`viz-carousel-name` `viz-carousel-next` `viz-carousel-options`
`viz-carousel-picker` `viz-carousel-previous` `viz-controls`
`viz-dotted-background` `viz-grid` `viz-row` `viz-stat` `viz-stat-value`
`widget`

## Runtime behavior

- Tooltips: `[data-tooltip]` opens on hover or keyboard focus and on tap.
  `data-tooltip-placement` accepts `top`, `right`, `bottom` and `left`; the
  runtime positions the bubble with fixed coordinates and clamps it to the
  viewport. Open triggers receive `aria-describedby`, and Escape closes.
- Tabs: `.nav[role="tablist"] [role="tab"]` supports click, arrow keys, Home
  and End. Selection updates `aria-selected`, the `active` class and the
  `hidden` state of the linked `aria-controls` panel.
- Carousel: every `:scope > [data-variant]` child of `.viz-carousel` is a panel.
  With more than one panel the runtime adds previous/next buttons, a position
  counter, the active variant name and a keyboard-operable `<details>` picker.
  `data-previous-label` and `data-next-label` override the default English
  button labels. Icons are inline SVG.

Everything ships inline. No icon package or script from a CDN is loaded, and
the source contains no upstream project identifiers.
