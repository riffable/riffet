import { D2 } from '@d2lang/d2';
import { runDiagram } from './diagram-runtime';

runDiagram(async (source, theme) => {
  const palette = {
    N1: theme.foreground, N2: theme.foreground, N3: theme.line, N4: theme.line,
    N5: theme.background, N6: theme.background, N7: theme.background,
    B1: theme.accent, B2: theme.accent, B3: theme.accent, B4: theme.line, B5: theme.background, B6: theme.background,
    AA2: theme.accent, AA4: theme.background, AA5: theme.background, AB4: theme.line, AB5: theme.background,
  };
  const colors = Object.entries(palette).map(([key, value]) => `${key}: "${value}"`).join('\n');
  const themed = `vars: {d2-config: {theme-overrides: {\n${colors}\n}\ndark-theme-overrides: {\n${colors}\n}}}\n${source}`;
  const d2 = new D2();
  try {
    const result = await d2.compile(themed, { themeID: theme.dark ? 200 : 0, darkThemeID: theme.dark ? 200 : 0, pad: 20, noXMLTag: true });
    return await d2.render(result.diagram, result.renderOptions);
  } finally { await d2.dispose(); }
}, ["d2"]);
