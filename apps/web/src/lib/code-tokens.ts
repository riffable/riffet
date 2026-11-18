import type { TokensRequest, TokensResponse } from './code-highlight.worker';

/**
 * The code view's tokens, from the highlighting worker: Shiki's language ids by file name, and one
 * worker for the page, started on first use. `undefined` when the language is not known or the
 * worker fails, and the text stays plain.
 */

const BY_EXTENSION: Record<string, string> = {
  kt: 'kotlin', kts: 'kotlin', java: 'java', gradle: 'groovy', groovy: 'groovy', xml: 'xml', properties: 'properties', pro: 'properties', proto: 'proto', aidl: 'java',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'jsonc', json5: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini',
  html: 'html', htm: 'html', svg: 'xml', plist: 'xml', css: 'css', scss: 'scss', less: 'less', vue: 'vue', svelte: 'svelte',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', py: 'python', go: 'go', rs: 'rust', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', m: 'objective-c', mm: 'objective-cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', dart: 'dart', scala: 'scala', lua: 'lua', sql: 'sql', md: 'markdown', markdown: 'markdown', mdown: 'markdown', mkd: 'markdown', mdx: 'markdown', mdc: 'markdown',
  graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff', cmake: 'cmake', mk: 'makefile',
};
const BY_NAME: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'makefile', 'cmakelists.txt': 'cmake', gnumakefile: 'makefile' };

export function codeLanguage(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf('.');
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1)] : undefined;
}

export interface CodeTokens { ranges: Uint32Array; styles: Array<{ color: string; italic: boolean }> }

let worker: Worker | undefined;
let sequence = 0;
const waiting = new Map<number, (response: TokensResponse) => void>();
/**
 * One file tokenizes at a time; a file asked for while another tokenizes waits, and gives its turn to
 * one asked for after it, so stepping through tabs colours the file that stays rather than every one passed.
 */
let busy = false;
let next: { request: TokensRequest; settle: (response: TokensResponse) => void } | undefined;

function send(request: TokensRequest, settle: (response: TokensResponse) => void) {
  if (busy) { next?.settle({ id: next.request.id }); next = { request, settle }; return; }
  busy = true;
  waiting.set(request.id, (response) => {
    settle(response);
    busy = false;
    const queued = next;
    next = undefined;
    if (queued) send(queued.request, queued.settle);
  });
  (worker ?? start()).postMessage(request);
}

function start(): Worker {
  worker = new Worker(new URL('./code-highlight.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<TokensResponse>) => { waiting.get(event.data.id)?.(event.data); waiting.delete(event.data.id); };
  // A broken worker answers nothing: settle what waits on it, and start a new one next time.
  worker.onerror = () => { const settles = [...waiting]; waiting.clear(); worker?.terminate(); worker = undefined; for (const [id, settle] of settles) settle({ id }); };
  return worker;
}

/** `code` with its line breaks as CodeMirror counts them (one character), which the offsets are into. */
export function codeTokens(code: string, path: string): Promise<CodeTokens | undefined> {
  const language = codeLanguage(path);
  if (!language || typeof Worker === 'undefined') return Promise.resolve(undefined);
  const id = ++sequence;
  return new Promise((resolve) => {
    send({ id, code, language }, ({ ranges, styles }) => resolve(ranges && styles ? { ranges, styles: styles.map((key) => { const [color = '', italic] = key.split('|'); return { color, italic: italic === 'i' }; }) } : undefined));
  });
}
