/**
 * Validates the workbench's assumptions about the Cursor CLI chat store against a real one.
 *
 * The native transcript is rebuilt from `chats/<md5(cwd)>/<chatId>/store.db`, which is a private
 * format: if the CLI changes it, the reader starts returning nothing and the conversation simply
 * looks empty. Run this after a CLI update to find out which assumption broke:
 *
 *   pnpm tsx scripts/probe-native-store.ts [projectCwd]
 *
 * It only reads: no writes, and nothing is copied out of the store. Chat titles are redacted so
 * the output is safe to paste.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cursorConfigDirectory } from '../plugins/riffet/cursor/cli-driver.js';
import { ChatReader, TranscriptMapper, workspaceChatsDir } from '../plugins/riffet/cursor/native/chat-store.js';

type Level = 'ok' | 'warn' | 'fail';
interface Check { level: Level; name: string; detail: string }
const checks: Check[] = [];
const add = (level: Level, name: string, detail: string) => { checks.push({ level, name, detail }); };

/** Mirrors the server's own resolution: the wrapper keeps its config outside ~/.cursor. */
function configDir(): string {
  return cursorConfigDirectory(process.env.CURSOR_CLI ?? 'cursor-agent');
}

const cwd = resolve(process.argv[2] ?? process.cwd());
const dir = workspaceChatsDir(configDir(), cwd);
console.log(`config dir : ${configDir()}`);
console.log(`project cwd: ${cwd}`);
console.log(`chat bucket: ${dir}  (md5 of cwd = ${createHash('md5').update(cwd).digest('hex')})`);
console.log('');

if (!existsSync(dir)) {
  add('fail', 'workspace bucket', 'no chats directory for this cwd — has the CLI ever run here?');
} else {
  const ids = readdirSync(dir).filter((name) => /^[0-9a-f-]{36}$/i.test(name));
  add(ids.length ? 'ok' : 'warn', 'workspace bucket', `${ids.length} chat director${ids.length === 1 ? 'y' : 'ies'}`);
  const chats = ids
    .map((id) => ({ id, mtime: statSync(join(dir, id)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, 5);
  if (!chats.length) console.log('(no chats to inspect)');

  const toolNames = new Set<string>();
  let subagentChats = 0;
  let contexts = 0;
  for (const chat of chats) {
    const path = join(dir, chat.id, 'store.db');
    const label = `chat ${chat.id.slice(0, 8)}`;
    if (!existsSync(path)) { add('fail', `${label} store.db`, 'missing'); continue; }
    const reader = new ChatReader(path);
    try {
      const meta = reader.meta();
      if (!meta) { add('fail', `${label} meta`, "meta key '0' did not decode to JSON with an agentId"); continue; }
      const title = meta.name ? '(title redacted)' : '(untitled)';
      add('ok', `${label} meta`, `agentId + ${title}${meta.subagentInfo ? ' + subagentInfo' : ''}`);
      if (meta.subagentInfo) subagentChats += 1;

      if (!meta.latestRootBlobId) { add('warn', `${label} root`, 'no latestRootBlobId yet (no turn recorded)'); continue; }
      const root = reader.snapshot();
      if (!root) { add('fail', `${label} root`, 'latestRootBlobId does not resolve to a readable blob'); continue; }
      if (!root.messageIds.length) { add('warn', `${label} message list`, 'root decoded but field 1 carried no 32-byte message ids'); continue; }
      add('ok', `${label} message list`, `${root.messageIds.length} message ids from protobuf field 1`);

      const records = root.messageIds.flatMap((id) => {
        const message = reader.message(id);
        return message ? [{ id, message }] : [];
      });
      add(records.length === root.messageIds.length ? 'ok' : 'fail', `${label} messages`, `${records.length}/${root.messageIds.length} blobs parsed as AI-SDK style JSON`);
      for (const record of records) {
        const parts = typeof record.message.content === 'string' ? [] : record.message.content;
        for (const part of parts) if (part.type === 'tool-call' && typeof part.toolName === 'string') toolNames.add(part.toolName);
      }
      const mapper = new TranscriptMapper();
      const events = records.flatMap((record) => mapper.map(record));
      add(events.length ? 'ok' : 'fail', `${label} transcript`, `${events.length} session/update events`);
      if (root.context) { contexts += 1; add('ok', `${label} context`, `${root.context.used}/${root.context.size} tokens, ${root.context.breakdown.length} buckets`); }
      else add('warn', `${label} context`, 'protobuf field 5 absent — the context meter will not show for this chat');
    } finally {
      reader.close();
    }
  }
  if (chats.length) {
    add(contexts ? 'ok' : 'warn', 'context coverage', `${contexts}/${chats.length} recent chats expose the /context breakdown`);
    add(subagentChats ? 'ok' : 'warn', 'subagent chats', `${subagentChats} recent chats carry subagentInfo (needed to nest a Task transcript)`);
    add(toolNames.size ? 'ok' : 'warn', 'tool vocabulary', `${toolNames.size} distinct tools: ${[...toolNames].sort().slice(0, 12).join(', ')}`);
  }
}

console.log('');
const icon: Record<Level, string> = { ok: '✔', warn: '!', fail: '✘' };
for (const check of checks) console.log(`  ${icon[check.level]} ${check.name.padEnd(28)} ${check.detail}`);
const failed = checks.filter((check) => check.level === 'fail').length;
console.log('');
console.log(failed ? `${failed} assumption(s) no longer hold — the transcript reader needs updating.` : 'All core assumptions still hold.');
console.log('(references to decodeRoot/workspaceChatsDir are the same ones the server uses, so this validates the real path.)');
process.exitCode = failed ? 1 : 0;
