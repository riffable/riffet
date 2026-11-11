import { instance } from '@viz-js/viz';
import { runDiagram } from './diagram-runtime';

runDiagram(async (source, theme) => {
  const viz = await instance();
  return viz.renderString(source, {
    format: 'svg',
    graphAttributes: { bgcolor: theme.background, fontcolor: theme.foreground, fontname: 'sans-serif', fontsize: theme.fontSize },
    nodeAttributes: { color: theme.accent, fontcolor: theme.foreground, fillcolor: theme.background, fontname: 'sans-serif', fontsize: theme.fontSize },
    edgeAttributes: { color: theme.line, fontcolor: theme.foreground, fontname: 'sans-serif', fontsize: theme.fontSize },
  });
}, ["dot", "graphviz", "gv"]);
