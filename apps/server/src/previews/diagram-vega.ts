import { View, parse, loader } from 'vega';
import { compile } from 'vega-lite';
import { expressionInterpreter } from 'vega-interpreter';
import { runDiagram } from './diagram-runtime';

runDiagram(async (source, theme, language) => {
  const spec = JSON.parse(source);
  // Generated charts carry their data in the source. A document cannot fetch a URL, even when a
  // spec embeds it deep in an image mark, a lookup transform or a nested data source.
  const offline = loader();
  offline.load = async () => { throw new Error('External chart data is unavailable'); };
  offline.sanitize = async () => { throw new Error('External chart resources are unavailable'); };
  const config = {
    background: theme.background,
    mark: { color: theme.accent, fill: theme.accent },
    axis: { labelColor: theme.foreground, titleColor: theme.foreground, domainColor: theme.line, tickColor: theme.line, gridColor: theme.line },
    legend: { labelColor: theme.foreground, titleColor: theme.foreground },
    title: { color: theme.foreground }, text: { color: theme.foreground },
    range: { category: [theme.accent, theme.line, theme.foreground] },
  };
  const compiled = /^(?:vega-lite|vegalite|vl)$/i.test(language) ? compile({ ...spec, config: { ...config, ...spec.config } }).spec : { ...spec, config: { ...config, ...spec.config } };
  const view = new View(parse(compiled, undefined, { ast: true }), { expr: expressionInterpreter, renderer: 'none', loader: offline });
  try {
    await view.runAsync();
    return await view.toSVG();
  } finally { view.finalize(); }
}, ["vega", "vega-lite", "vegalite", "vl"]);
