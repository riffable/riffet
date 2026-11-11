import mermaid from 'mermaid';
import { runDiagram } from './diagram-runtime';

let nextDiagram = 0;

runDiagram(async (source, { dark, foreground, background, line, accent, fontSize }) => {
  mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels: false,
    maxTextSize: 50_000, maxEdges: 500, theme: 'base', look: 'classic', layout: 'dagre',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'dompurifyConfig'],
    themeVariables: {
      darkMode: dark, background, fontSize: `${fontSize}px`,
      primaryColor: background, primaryTextColor: foreground, primaryBorderColor: accent,
      secondaryColor: background, secondaryTextColor: foreground, secondaryBorderColor: line,
      tertiaryColor: background, tertiaryTextColor: foreground, tertiaryBorderColor: line,
      lineColor: line, textColor: foreground, edgeLabelBackground: background,
      mainBkg: background, nodeBorder: accent, clusterBkg: background, clusterBorder: line,
      actorBkg: background, actorBorder: accent, actorTextColor: foreground,
      signalColor: foreground, signalTextColor: foreground, labelBoxBkgColor: background,
      labelBoxBorderColor: line, labelTextColor: foreground, loopTextColor: foreground,
      noteBkgColor: background, noteBorderColor: line, noteTextColor: foreground,
    },
  });
  return (await mermaid.render(`riffet-mermaid-diagram-${++nextDiagram}`, source)).svg;
}, ["mermaid", "mmd"]);
