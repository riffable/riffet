/**
 * Validates the workbench's assumptions about Claude Code subagent storage against real sessions.
 *
 * A child transcript is read from `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`, and
 * the tool call it belongs to comes from `agent-<agentId>.meta.json`'s `toolUseId`. Both the layout
 * and the field are the CLI's own private shape: if they change, subagent rows silently stop
 * opening, so run this after a Claude Code update to see which assumption broke:
 *
 *   pnpm tsx scripts/probe-claude-subagents.ts [sessions]
 *
 * It only reads, and the sessions argument (default 40) bounds how many are inspected.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

type Level = 'ok' | 'warn' | 'fail';
interface Check { level: Level; name: string; detail: string }
const checks: Check[] = [];
const add = (level: Level, name: string, detail: string) => { checks.push({ level, name, detail }); };

const limit = Number(process.argv[2] ?? 40);
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const projects = join(configDir, 'projects');
console.log(`config dir : ${configDir}`);
console.log('');

/** Every `tool_use` id a transcript records, so a meta's `toolUseId` can be looked up. */
function toolUseIds(file: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(file)) return ids;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || !line.includes('"tool_use"')) continue;
    try {
      const row = JSON.parse(line) as { message?: { content?: unknown } };
      const content = row.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_use') {
          const id = (block as { id?: unknown }).id;
          if (typeof id === 'string') ids.add(id);
        }
      }
    } catch { /* one unreadable line does not invalidate the rest */ }
  }
  return ids;
}

if (!existsSync(projects)) {
  add('fail', 'projects', `no ${projects} — has Claude Code ever run on this machine?`);
} else {
  const dirs = readdirSync(projects).filter((name) => !name.startsWith('.'));
  add(dirs.length ? 'ok' : 'warn', 'projects', `${dirs.length} project director${dirs.length === 1 ? 'y' : 'ies'}`);

  interface Session { project: string; sessionId: string; root: string; mtime: number }
  const sessions: Session[] = [];
  for (const project of dirs) {
    let entries: string[];
    try { entries = readdirSync(join(projects, project), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch { continue; }
    for (const sessionId of entries) {
      const root = join(projects, project, sessionId, 'subagents');
      if (!existsSync(root)) continue;
      let mtime = 0;
      try { mtime = statSync(root).mtimeMs; } catch { /* keep zero */ }
      sessions.push({ project, sessionId, root, mtime });
    }
  }
  add(sessions.length ? 'ok' : 'warn', 'sessions with subagents', `${sessions.length} session director${sessions.length === 1 ? 'y' : 'ies'} hold a subagents/ folder`);

  const selected = sessions.sort((left, right) => right.mtime - left.mtime).slice(0, limit);
  let metas = 0, linked = 0, unlinked = 0, missingFiles = 0, missingMeta = 0, nested = 0;
  const depths = new Map<number, number>();
  const sample: string[] = [];
  for (const session of selected) {
    const transcriptDir = join(projects, session.project);
    const sessionFile = join(transcriptDir, `${session.sessionId}.jsonl`);
    if (!existsSync(sessionFile)) { add('fail', `session ${session.sessionId.slice(0, 8)}`, 'subagents/ exists but the session JSONL does not'); continue; }
    const sessionToolUses = toolUseIds(sessionFile);
    let agentFiles: string[];
    try { agentFiles = readdirSync(session.root).filter(name => name.startsWith('agent-') && name.endsWith('.jsonl')); } catch { continue; }
    for (const agentFile of agentFiles) {
      const agentId = agentFile.slice('agent-'.length, -'.jsonl'.length);
      const metaFile = join(session.root, `agent-${agentId}.meta.json`);
      if (!existsSync(metaFile)) { missingMeta += 1; continue; }
      let meta: { toolUseId?: string; agentType?: string; spawnDepth?: number; parentAgentId?: string };
      try { meta = JSON.parse(readFileSync(metaFile, 'utf8')) as typeof meta; } catch { add('fail', `meta ${agentId}`, 'not JSON'); continue; }
      metas += 1;
      const depth = typeof meta.spawnDepth === 'number' ? meta.spawnDepth : -1;
      depths.set(depth, (depths.get(depth) ?? 0) + 1);
      if (!meta.toolUseId) { unlinked += 1; continue; }
      // A nested child's tool call lives in its parent agent's transcript, not in the session's.
      const owner = meta.parentAgentId ? join(session.root, `agent-${meta.parentAgentId}.jsonl`) : sessionFile;
      if (meta.parentAgentId) nested += 1;
      const ids = meta.parentAgentId ? toolUseIds(owner) : sessionToolUses;
      if (!existsSync(owner)) { missingFiles += 1; continue; }
      if (ids.has(meta.toolUseId)) {
        linked += 1;
        if (sample.length < 5) sample.push(`${session.sessionId.slice(0, 8)} depth ${depth} ${meta.agentType ?? '?'} → ${basename(owner)}`);
      } else {
        add('warn', `child ${agentId}`, `toolUseId ${meta.toolUseId} is not in ${basename(owner)}`);
      }
    }
  }

  add(metas ? 'ok' : 'fail', 'child metas', `${metas} read from ${selected.length} session(s)`);
  add(linked === metas - unlinked - missingFiles ? 'ok' : 'warn', 'toolUseId linkage', `${linked} linked, ${unlinked} without a toolUseId, ${missingFiles} with an unreadable owner transcript`);
  add(missingMeta ? 'warn' : 'ok', 'meta beside every child', missingMeta ? `${missingMeta} child file(s) have no .meta.json` : 'every child file has a meta');
  add(nested ? 'ok' : 'warn', 'nested children', `${nested} child(ren) name a parentAgentId`);
  console.log(`depths     : ${[...depths].sort(([a], [b]) => a - b).map(([depth, count]) => `${depth}:${count}`).join('  ')}`);
  if (sample.length) console.log(`sample     :\n  ${sample.join('\n  ')}`);
  console.log('');
}

for (const check of checks) console.log(`${check.level === 'ok' ? '  ok' : check.level === 'warn' ? 'warn' : 'FAIL'}  ${check.name}: ${check.detail}`);
const failed = checks.filter(check => check.level === 'fail').length;
const warned = checks.filter(check => check.level === 'warn').length;
console.log('');
console.log(failed ? `${failed} assumption(s) broken${warned ? `, ${warned} warning(s)` : ''}.` : warned ? `All hard assumptions hold; ${warned} warning(s).` : 'All assumptions hold.');
process.exitCode = failed ? 1 : 0;
