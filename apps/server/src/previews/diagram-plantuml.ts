import { instance } from '@viz-js/viz';
import { renderToString } from '@plantuml/core';
import '@plantuml/core/themes.js';
import '@plantuml/core/emoji.js';
import '@plantuml/core/openiconic.js';
import { runDiagram } from './diagram-runtime';

runDiagram(async (source, theme) => {
  const globals = globalThis as typeof globalThis & { PLANTUML_VIZ?: unknown; PLANTUML_STDLIB_LOADER?: unknown };
  // PlantUML's documented Viz hook lets both engines share the pinned, portable WASM build.
  globals.PLANTUML_VIZ = { instance };
  globals.PLANTUML_STDLIB_LOADER = (_name: string, _loaded: () => void, failed: (message: string) => void) => { failed('This library is not bundled'); return true; };
  let document = /^\s*@start\w+/im.test(source) ? source : `@startuml\n${source}\n@enduml`;
  document = document.replace(/^([ \t]*@startuml[^\n]*)(?:\n|$)/im, (_, start: string) => `${start}\nskinparam backgroundColor ${theme.background}\nskinparam defaultFontColor ${theme.foreground}\nskinparam defaultFontSize ${theme.fontSize}\nskinparam ArrowColor ${theme.line}\nskinparam LineColor ${theme.accent}\nskinparam sequenceActorBorderColor ${theme.accent}\nskinparam sequenceParticipantBorderColor ${theme.accent}\nskinparam sequenceActorBackgroundColor ${theme.background}\nskinparam sequenceParticipantBackgroundColor ${theme.background}\n`);
  return new Promise<string>((resolve, reject) => {
    renderToString(document.split('\n'), resolve, (message) => reject(new Error(message)), { dark: theme.dark, maxSvgSize: 8192 });
  });
}, ["plantuml", "puml", "uml", "wsd"]);
