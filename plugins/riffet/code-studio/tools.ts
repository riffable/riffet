// The `code_*` tools (docs/CODE-STUDIO.md「Agent 工具」): read-only code navigation for the conversation's own project,
// answered by the core's code index through `host.code`. No project parameter: a call can only reach the project of the
// session that made it, on the server that session runs on. Results are compact JSON: project-relative paths, 1-based
// lines, line text clipped. A result never lets an unanswered lookup read as "nothing exists": `indexReady` and
// `complete` say what the answer covers, and `note` says what to do when it is partial.

import type { AgentToolContext, AgentToolDefinition, AgentToolGroup, AgentToolResult, PluginCodeNavigation, PluginHost } from '@riffet/plugin-api';

export const STUDIO_TOOL_GROUP = 'riffet.code-studio/code';

const MAX_ITEMS = 40;
const DEFAULT_LIMIT = 20;
const MAX_TEXT = 160;
const MAX_OUTLINE = 150;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const PATHS = 'Paths are relative to the project root; lines and columns are 1-based. Works on the conversation\'s own project only, and only reads (Kotlin, Java, Android resources have an index; other languages are answered by a text scan).';
const PREFER = 'Prefer it to grep or rg on a large Kotlin, Java or Android repository: it knows declarations, imports and modules and does not scan the tree. The result states whether the index is ready and the answer complete; when it says not, fall back to rg and do not read an empty list as "nothing exists".';

export const TOOLS: readonly AgentToolDefinition[] = [
  {
    name: 'code_search',
    description: `Find declarations (classes, interfaces, objects, enums, functions, properties) by name in this project, best match first; also matches camel-case initials (FF finds FeedFragment). Set types=true to list only classes, interfaces, objects, enums and annotations. ${PREFER} ${PATHS}`,
    inputSchema: object({
      query: { type: 'string', description: 'Part of a name, or camel-case initials.' },
      types: { type: 'boolean', description: 'Only type declarations (default false).' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_ITEMS, description: `Default ${DEFAULT_LIMIT}.` },
    }, ['query']),
  },
  {
    name: 'code_definition',
    description: `Where a name used on a line of a file is declared: follows imports, same-package types, members and Android resources (R.string.x, @string/x). Give path, line and word; column is optional (default: the first occurrence of word on that line, pass it when the word occurs twice). Several locations mean overloads or same-named declarations. ${PREFER} ${PATHS}`,
    inputSchema: object({
      path: { type: 'string', description: 'The file that uses the name.' },
      line: { type: 'integer', minimum: 1 },
      word: { type: 'string', description: 'The identifier only, no qualifier or call (e.g. "FeedFragment", not "FeedFragment.newInstance()").' },
      column: { type: 'integer', minimum: 1, description: 'Where the word starts on the line.' },
    }, ['path', 'line', 'word']),
  },
  {
    name: 'code_references',
    description: `Whole-word uses of a name in the files of the same language, as path:line with the line's text. scope=module (default) stays inside the build module of path; scope=project searches everything. A reference to a common name can be long: the list is capped and says how many more there are. ${PREFER} ${PATHS}`,
    inputSchema: object({
      path: { type: 'string', description: 'A file of the language and, for module scope, the module to search.' },
      word: { type: 'string', description: 'The identifier.' },
      scope: { type: 'string', enum: ['module', 'project'] },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 40.' },
    }, ['path', 'word']),
  },
  {
    name: 'code_outline',
    description: `The declarations of one file with their kinds and lines (classes, then members), without reading the whole file. Use it before reading a large file. ${PATHS}`,
    inputSchema: object({ path: { type: 'string' } }, ['path']),
  },
  {
    name: 'code_index_status',
    description: 'Whether this project\'s code index is ready (idle, building with progress, ready, failed) and how many files and declarations it holds. The other code_* tools report the same state in every result.',
    inputSchema: object({}),
  },
];

const result = (value: Record<string, unknown>): AgentToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const clip = (text: string) => { const line = text.trim(); return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT)}…` : line; };

function string(args: Record<string, unknown>, key: string, max: number, error: PluginHost['error'], required = true): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') { if (required) throw error('INVALID_ARGUMENT', `${key} is required`, 400); return undefined; }
  if (typeof value !== 'string' || value.length > max) throw error('INVALID_ARGUMENT', `${key} must be text of at most ${max} characters`, 400);
  return value;
}
function integer(args: Record<string, unknown>, key: string, min: number, max: number, error: PluginHost['error'], required = false): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) { if (required) throw error('INVALID_ARGUMENT', `${key} is required`, 400); return undefined; }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw error('INVALID_ARGUMENT', `${key} must be an integer from ${min} to ${max}`, 400);
  return value;
}

type Status = Awaited<ReturnType<PluginCodeNavigation['status']>>;

/** What the answer rests on. `ready` with an `error` is an index that does not cover every file (it was cut off or its last check failed). */
function indexState(status: Status): { indexReady: boolean; index: string; note?: string } {
  if (status.state === 'ready' && !status.error) {
    const rebuilding = status.done < status.files;
    return { indexReady: true, index: rebuilding ? `ready, updating ${status.done}/${status.files}` : 'ready' };
  }
  if (status.state === 'ready') return { indexReady: false, index: 'partial', note: `The index does not cover every file (${status.error}); fall back to rg for anything it does not find.` };
  if (status.state === 'building') return { indexReady: false, index: `building ${status.files ? Math.floor((status.done / status.files) * 100) : 0}%`, note: `Index building ${status.files ? Math.floor((status.done / status.files) * 100) : 0}%; it builds only while Code Studio is open; results may be missing, fall back to rg.` };
  if (status.state === 'failed') return { indexReady: false, index: 'failed', note: `Index failed${status.error ? `: ${status.error}` : ''}; fall back to rg.` };
  return { indexReady: false, index: 'idle', note: 'Index not built: it is built only while Code Studio is open on this project. Fall back to rg.' };
}

export function toolGroup(host: PluginHost): AgentToolGroup {
  const { error } = host;
  return {
    tools: TOOLS,
    async call(context: AgentToolContext, name: string, args: Record<string, unknown>): Promise<AgentToolResult> {
      const code = host.code;
      if (!code) throw error('CODE_NAVIGATION_UNAVAILABLE', 'This server does not offer code navigation to plugins', 501);
      const projectId = context.projectId;
      if (!projectId) throw error('NO_PROJECT', 'This conversation has no project, so there is no code to search', 409);
      const { signal } = context;
      switch (name) {
        case 'code_index_status': {
          const status = await code.status(projectId);
          const state = indexState(status);
          return result({ ...state, files: status.files, done: status.done, symbols: status.symbols, ...(status.builtAt ? { builtAt: status.builtAt } : {}) });
        }
        case 'code_search': {
          const query = string(args, 'query', 200, error)!;
          const limit = integer(args, 'limit', 1, MAX_ITEMS, error) ?? DEFAULT_LIMIT;
          const found = await code.search(projectId, query, { types: args.types === true, limit });
          const state = indexState(found.index);
          return result({
            ...state, count: found.items.length,
            items: found.items.slice(0, limit).map(item => `${item.kind} ${item.container ? `${item.container}.` : ''}${item.name} ${item.path}:${item.line}${item.package ? ` (${item.package})` : ''}`),
            ...(state.indexReady && !found.items.length ? { note: 'No declaration matches. Names are matched by prefix, camel-case initials and substring; libraries and non-Kotlin/Java files are not indexed.' } : {}),
          });
        }
        case 'code_definition': {
          const path = string(args, 'path', 8192, error)!;
          const word = string(args, 'word', 200, error)!;
          const line = integer(args, 'line', 1, 10_000_000, error, true)!;
          const column = integer(args, 'column', 1, 100_000, error);
          const found = await code.definition(projectId, { path, line, word, ...(column ? { column } : {}) }, signal);
          const state = indexState(await code.status(projectId));
          const locations = found.locations.slice(0, 10).map(item => `${item.path}:${item.line}  ${clip(item.text)}`);
          // Without a ready index the core answers by a time-limited scan of the project: what it found is right, only an empty answer is unsure.
          return result({
            indexReady: state.indexReady, index: state.index, count: found.locations.length, locations,
            ...(found.locations.length ? {} : {
              note: state.indexReady ? 'No declaration found in the project; it is probably from a library or the SDK.' : 'No declaration found by a time-limited scan (the index is not ready); confirm with rg.',
            }),
          });
        }
        case 'code_references': {
          const path = string(args, 'path', 8192, error)!;
          const word = string(args, 'word', 200, error)!;
          const scope = args.scope === 'project' ? 'project' : 'module';
          const limit = integer(args, 'limit', 1, 100, error) ?? MAX_ITEMS;
          const found = await code.references(projectId, { path, word, scope }, signal);
          const state = indexState(await code.status(projectId));
          const shown = found.locations.slice(0, limit);
          // Without a ready index the core scans the files itself, so `complete` alone says whether anything was missed.
          const notes = [
            ...(found.complete ? [] : ['Incomplete: the search hit its time or size budget, so more uses may exist; narrow scope or use rg.']),
            ...(found.locations.length > shown.length ? [`${found.locations.length - shown.length} more not shown.`] : []),
          ];
          return result({
            indexReady: state.indexReady, complete: found.complete, scope, total: found.locations.length,
            references: shown.map(item => `${item.path}:${item.line}  ${clip(item.text)}`),
            ...(notes.length ? { note: notes.join(' ') } : {}),
          });
        }
        case 'code_outline': {
          const path = string(args, 'path', 8192, error)!;
          const outline = await code.outline(projectId, path);
          const lines: string[] = [];
          let more = 0;
          const walk = (items: typeof outline.items, depth: number) => {
            for (const item of items) {
              if (lines.length >= MAX_OUTLINE) { more += 1; } else lines.push(`${'  '.repeat(depth)}${item.kind} ${item.name} :${item.line}`);
              if (item.children) walk(item.children, depth + 1);
            }
          };
          walk(outline.items, 0);
          return result({ path: outline.path, ...(outline.package ? { package: outline.package } : {}), items: lines, ...(more ? { note: `${more} more declarations not shown.` } : {}), ...(!outline.items.length ? { note: 'No declarations found: the file is not Kotlin or Java, or could not be parsed.' } : {}) });
        }
        default:
          throw error('TOOL_NOT_FOUND', `No tool named ${name}`, 404);
      }
    },
  };
}
