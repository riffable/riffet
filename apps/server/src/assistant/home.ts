import { execFile } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AssistantFile, AssistantMemory } from '../../../../packages/contracts/src/index.js';
import { assistantSystemPrompt, riffetSkills } from '../prompts/index.js';
import { SERVER_VERSION } from '../version.js';

/*
 * The 助理's directory (docs/ASSISTANT.md §2): what its CLI reads besides `AGENTS.md`, which
 * `work-items/assistant.ts` owns. Everything here is plain Markdown the 助理 edits itself, kept under git
 * so a bad edit can be found and undone.
 */

const run = promisify(execFile);
const USER_FILE = 'USER.md';
const MEMORY_DIR = 'memory';
const MEMORY_INDEX = 'MEMORY.md';
const USER_SEED = '# Owner\n\n<!-- Who the owner is and how they want to be helped. The assistant keeps this short. -->\n';
const MEMORY_SEED = '# Memory\n\n<!-- One line per entry. Details live in topic files beside this one. -->\n';
/** The CLI's own per-machine files, which are not the 助理's notes. */
const IGNORED = '.claude/settings.local.json\n';
/**
 * What is kept under git: the 助理's rules, its notes and its skills. Anything else it leaves in the directory
 * (a download, an MCP file holding a token) stays out of a history that deleting the file would not clean.
 */
const COMMITTED = ['AGENTS.md', 'CLAUDE.md', USER_FILE, MEMORY_DIR, '.claude/skills', 'packs', '.gitignore'];
/**
 * Capability packs (docs/ASSISTANT.md §8.2): each folder here is a Claude Code plugin the owner put in (skills, the MCP
 * servers they need), loaded with Riffet's own. A pack's `memory.md` seeds a topic file of the same name once.
 */
const PACKS_DIR = 'packs';
/**
 * The owner's files: the rules the 助理 runs under and what its CLI starts with. It reads them; a change is the
 * owner's to make. MCP files are here because the launch starts their servers without asking again.
 */
const PROTECTED = ['AGENTS.md', 'CLAUDE.md', '.mcp.json', '.claude/settings.json', '.claude/settings.local.json', `${PACKS_DIR}/**`];

export interface AssistantHome {
  /** Riffet's text, rewritten on every start; outside the directory, so the 助理 cannot edit what it runs under. */
  systemPromptFile: string;
  memoryDir: string;
  /** Riffet's own skills for the 助理, as a plugin directory its CLI loads for one launch (docs/ASSISTANT.md §8). */
  pluginDir: string;
  /** The capability packs the owner put in its `packs/` folder, read at each launch. */
  packDirs(): string[];
  /** The directory's own MCP servers, when it declares any. */
  mcpConfigFiles(): string[];
  protectedFiles: string[];
}

/** The files a conversation of the 助理 starts with; each is written only when missing. */
export function ensureAssistantHome(stateDir: string, cwd: string): AssistantHome {
  const memoryDir = join(cwd, MEMORY_DIR);
  mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  seed(join(cwd, USER_FILE), USER_SEED);
  seed(join(memoryDir, MEMORY_INDEX), MEMORY_SEED);
  seed(join(cwd, '.gitignore'), IGNORED);
  const runtimeDir = join(stateDir, 'assistant-runtime');
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const systemPromptFile = join(runtimeDir, 'system-prompt.md');
  const text = `${assistantSystemPrompt()}\n`;
  if (read(systemPromptFile) !== text) writeFileSync(systemPromptFile, text, { mode: 0o600 });
  const pluginDir = join(runtimeDir, 'riffet');
  writeSkillPlugin(pluginDir);
  const mcp = join(cwd, '.mcp.json');
  return { systemPromptFile, memoryDir, pluginDir, packDirs: () => packs(cwd, memoryDir), mcpConfigFiles: () => existsSync(mcp) ? [mcp] : [], protectedFiles: PROTECTED.map(file => join(cwd, file)) };
}

/** The pack folders that are plugins; each one's memory seed is written once, beside the index, as `<pack>.md`. */
function packs(cwd: string, memoryDir: string): string[] {
  const root = join(cwd, PACKS_DIR);
  let names: string[];
  try { if (!lstatSync(root).isDirectory()) return []; names = readdirSync(root); } catch { return []; }
  return names.filter(name => !name.startsWith('.')).flatMap(name => {
    const dir = join(root, name);
    try { if (!lstatSync(dir).isDirectory() || !lstatSync(join(dir, '.claude-plugin', 'plugin.json')).isFile()) return []; } catch { return []; }
    const seedFile = join(dir, 'memory.md');
    try { if (lstatSync(seedFile).isFile() && /^[\w.-]+$/.test(name)) seed(join(memoryDir, `${name}.md`), readFileSync(seedFile, 'utf8')); } catch { /* no seed */ }
    return [dir];
  });
}

function read(path: string): string | undefined { try { return readFileSync(path, 'utf8'); } catch { return undefined; } }

/**
 * Riffet's skills for the 助理, laid out as the plugin `riffet`, so its CLI lists them as `riffet:<name>` beside the
 * directory's own. Rewritten on every start: they follow the server's version, and being outside the directory,
 * the 助理 cannot edit them.
 */
function writeSkillPlugin(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'riffet', version: SERVER_VERSION, description: "Riffet's own skills for the personal assistant" }, null, 2)}\n`, { mode: 0o600 });
  for (const skill of riffetSkills('assistant')) {
    mkdirSync(join(dir, 'skills', skill.name), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'skills', skill.name, 'SKILL.md'), skill.text, { mode: 0o600 });
  }
}

/** Longest text of one memory file the owner is shown, how many topic files, and how many names are looked at to find them. */
const MEMORY_FILE_CHARS = 20_000;
const MEMORY_FILES = 200;
const MEMORY_SCANNED = 2000;

/**
 * What the 助理 remembers, for its owner to read. The workspace file routes refuse the state directory, where
 * this lives, so its memory has a reader of its own: `USER.md`, the index, and the Markdown files beside the
 * index. A link the 助理 left there (a file, or the memory directory itself) is not followed, so this never
 * reads outside its memory; a file is read up to its cap, and only the newest files are read at all.
 */
export function readAssistantMemory(cwd: string): AssistantMemory {
  let updatedAt = '';
  const stamp = (path: string): string | undefined => {
    try { const stat = lstatSync(path); return stat.isFile() ? stat.mtime.toISOString() : undefined; } catch { return undefined; }
  };
  const file = (path: string, modifiedAt = stamp(path)): { text: string; modifiedAt: string } | undefined => {
    if (!modifiedAt) return undefined;
    let fd: number | undefined;
    try {
      // A character is at most four bytes; one more byte than that tells a longer file from one that fits.
      const buffer = Buffer.alloc(MEMORY_FILE_CHARS * 4 + 1);
      fd = openSync(path, 'r');
      const text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
      if (modifiedAt > updatedAt) updatedAt = modifiedAt;
      return { text: text.length > MEMORY_FILE_CHARS ? `${text.slice(0, MEMORY_FILE_CHARS)}\n…` : text, modifiedAt };
    } catch { return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
  };
  const dir = join(cwd, MEMORY_DIR);
  let own = false;
  try { own = lstatSync(dir).isDirectory(); } catch { /* no memory yet */ }
  let names: string[] = [];
  if (own) try { names = readdirSync(dir).filter(name => name.endsWith('.md') && name !== MEMORY_INDEX).slice(0, MEMORY_SCANNED); } catch { /* unreadable: nothing to show */ }
  const entries = names.flatMap(name => { const modifiedAt = stamp(join(dir, name)); return modifiedAt ? [{ name, modifiedAt }] : []; })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, MEMORY_FILES)
    .flatMap(({ name, modifiedAt }) => { const read = file(join(dir, name), modifiedAt); return read ? [{ name, ...read }] : []; });
  return { profile: file(join(cwd, USER_FILE))?.text ?? '', index: own ? file(join(dir, MEMORY_INDEX))?.text ?? '' : '', entries, ...(updatedAt ? { updatedAt } : {}) };
}
/**
 * The owner removes one topic file of the 助理's memory. Only a regular Markdown file beside the index, named as
 * `readAssistantMemory` lists it; the removal is committed at once, so the history can bring it back.
 */
export async function forgetAssistantMemory(cwd: string, name: string): Promise<void> {
  const dir = join(cwd, MEMORY_DIR);
  const valid = /^[^/\\\0]+\.md$/.test(name) && name !== MEMORY_INDEX && !name.startsWith('.');
  let file = false;
  try { file = valid && lstatSync(dir).isDirectory() && lstatSync(join(dir, name)).isFile(); } catch { file = false; }
  if (!file) throw Object.assign(new Error('No such memory'), { code: 'MEMORY_NOT_FOUND' });
  rmSync(join(dir, name));
  await commitAssistantHome(cwd);
}

/** Where the 助理 leaves what it made for the owner: drafts, research, exports (docs/ASSISTANT.md §3.2). */
export const FILES_DIR = 'files';
const LISTED_FILES = 200;

/**
 * The files the 助理 made for the owner, newest first: regular files directly in `files/` and one folder below it.
 * Links are not followed, so nothing outside the folder is listed or served.
 */
export function listAssistantFiles(cwd: string): AssistantFile[] {
  const root = join(cwd, FILES_DIR);
  try { if (!lstatSync(root).isDirectory()) return []; } catch { return []; }
  const found: AssistantFile[] = [];
  const visit = (relative: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(join(root, relative)); } catch { return; }
    for (const name of names.slice(0, MEMORY_SCANNED)) {
      if (name.startsWith('.')) continue;
      const path = relative ? `${relative}/${name}` : name;
      let stat;
      try { stat = lstatSync(join(root, path)); } catch { continue; }
      if (stat.isDirectory() && depth < 1) visit(path, depth + 1);
      else if (stat.isFile()) found.push({ path, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  };
  visit('', 0);
  return found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, LISTED_FILES);
}

/** The absolute path of one listed file, or undefined for anything that is not one. */
export function assistantFilePath(cwd: string, path: string): string | undefined {
  return listAssistantFiles(cwd).some(file => file.path === path) ? join(cwd, FILES_DIR, path) : undefined;
}

function seed(path: string, text: string): void { if (!existsSync(path)) writeFileSync(path, text, { mode: 0o600 }); }

const GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'user.name=Riffet', '-c', 'user.email=riffet@localhost', '-c', 'commit.gpgsign=false'];

/**
 * Records the directory's current files as a commit when anything changed. History is the undo for what the 助理
 * writes to its own memory; a host without git simply has none. Returns whether a commit was made.
 */
export async function commitAssistantHome(cwd: string, at = new Date()): Promise<boolean> {
  const git = (...args: string[]) => run('git', [...GIT, ...args], { cwd, timeout: 20_000, maxBuffer: 1024 * 1024 });
  try {
    if (!existsSync(join(cwd, '.git'))) await git('init', '-q');
    const [present, gone] = [COMMITTED.filter(path => existsSync(join(cwd, path))), COMMITTED.filter(path => !existsSync(join(cwd, path)))];
    if (present.length) await git('add', '-A', '--', ...present);
    // A path removed whole is not something `add` can be pointed at: its files leave the index here.
    if (gone.length) await git('rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...gone);
    // Exits 1 when something is staged, which is the one case there is a commit to make.
    const staged = await git('diff', '--cached', '--quiet').then(() => false, () => true);
    if (!staged) return false;
    await git('commit', '-q', '-m', at.toISOString());
    return true;
  } catch {
    return false;
  }
}
