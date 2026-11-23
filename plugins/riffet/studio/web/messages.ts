import type { MessageCatalogs } from '@riffet/plugin-web';

/*
 * The page's own text. It is in English in every language, as the Git panel and the trace are: it is an
 * IDE's surface whose words (module, outline, usages, go to class) are the ones Android Studio and the
 * build use, and a page that mixes them with translated labels reads worse than either. Its name, Code
 * Studio, is a tool's name and stays the same in every language too (`index.ts`).
 */

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const en = {
  project: 'Project',
  server: 'Server',
  noProjects: 'No projects',
  views: { modules: 'Modules', project: 'Files' },
  search: 'Search everywhere',
  searchTabs: { all: 'All', classes: 'Classes', files: 'Files', symbols: 'Symbols', text: 'Text', actions: 'Actions' },
  searchPlaceholder: { all: 'Class, file, symbol or :line', classes: 'Class name', files: 'File name or path', symbols: 'Symbol name', text: 'Text in files', actions: 'Action' },
  sections: { recent: 'Recent files', classes: 'Classes', files: 'Files', symbols: 'Symbols', actions: 'Actions' },
  goToLine: (line: number) => `Go to line ${line}`,
  matchCase: 'Match case',
  wholeWord: 'Words',
  regex: 'Regex',
  mask: 'File mask',
  maskPlaceholder: '*.kt, *.java',
  moreMatches: (keys: string) => `More matches: ${keys} lists them all in the find panel`,
  findIncomplete: { time: 'Stopped at the time limit; there may be more', budget: 'Stopped at the size limit; there may be more', error: 'Some files could not be read' },
  searchFailed: 'Search failed',
  noMatches: 'No matches',
  treeView: 'View',
  annotate: 'Annotate with Git Blame',
  closeAnnotate: 'Close annotations',
  blameFailed: 'Could not annotate',
  hashCopied: 'Commit hash copied',
  collapseAll: 'Collapse all',
  actions: {
    locate: 'Select opened file in tree', quote: 'Quote file in conversation', showOutline: 'Show structure', hideOutline: 'Hide structure',
    annotate: 'Annotate with Git Blame', closeAnnotate: 'Close annotations',
    modules: 'Show modules', files: 'Show files', collapse: 'Collapse tree', rebuild: 'Rebuild index', closeTabs: 'Close all tabs',
  },
  noResults: 'No results',
  outline: 'Structure',
  locate: 'Select in tree',
  quoteFile: 'Quote file in conversation',
  noOutline: 'No declarations',
  closeTab: 'Close',
  noFile: 'No file open',
  definitions: (word: string) => `Declarations of ${word}`,
  usages: (word: string) => `Usages of ${word}`,
  textResults: (query: string) => `Text “${query}”`,
  results: (n: number) => count(n, 'result'),
  incomplete: 'Stopped at the limit; there may be more',
  noDefinition: (word: string) => `No declaration of ${word} found`,
  closePanel: 'Close',
  scope: { module: 'Module', project: 'Project' },
  index: {
    idle: 'Not indexed',
    building: (done: number, files: number) => `Indexing ${files ? Math.floor((done / files) * 100) : 0}%`,
    ready: (symbols: number) => count(symbols, 'symbol'),
    failed: 'Index failed',
    rebuild: 'Rebuild index',
    pending: 'Class and symbol search is ready once indexing finishes',
  },
  lineColumn: (line: number) => `Line ${line}`,
  loadFailed: 'Could not load',
};

export type Messages = typeof en;
export const catalogs: MessageCatalogs<Messages> = { 'zh-Hans': en, en };
