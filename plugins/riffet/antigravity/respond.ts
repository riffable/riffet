import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { NativeInteractionResponse, NativeInteractionResult } from '@contracts';
import type { AgentContext, AgentHost } from '@riffet/plugin-api/experimental/agent';
import { readJson, writeJson } from './bridge.js';
import { sha } from './composer.js';
import { answerOf, answered, fingerprint, interactionOf } from './interactions.js';
import { attach, required } from './lifecycle.js';
import type { AgyRecord } from './protocol.js';
import { changed, owned, sessionRoot, type Hub } from './runtime.js';

/**
 * What is waiting for an answer, read from the stream's snapshot. Read-only, so it does not need a ready runtime: a
 * TUI dialog (trust, sign-in) can be up before agy's RPC and status line are, and is answered through `dialogs`.
 * `respond` makes its own fresh read before it answers.
 */
export async function interaction(hub: Hub, host: AgentHost, context: AgentContext) {
  const runtime = await attach(hub, host, context).catch(() => undefined);
  const id = host.view.session(context.session.id)?.nativeSessionId;
  const snapshot = runtime?.snapshot?.conversationId === id ? runtime?.snapshot : undefined;
  return (snapshot && interactionOf(snapshot)?.view) || (await host.dialogs.current(context.session.id)) || undefined;
}

const MAX_RESPONSE_FILES = 20;

async function pruneResponseFiles(dir: string, keepFile: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: Array<{ name: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === keepFile) continue;
    const info = await stat(join(dir, entry.name)).catch(() => undefined);
    files.push({ name: entry.name, mtimeMs: info?.mtimeMs ?? 0 });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of files.slice(MAX_RESPONSE_FILES - 1)) {
    await rm(join(dir, stale.name), { force: true }).catch(() => undefined);
  }
}

export async function respond(
  hub: Hub,
  host: AgentHost,
  context: AgentContext,
  response: NativeInteractionResponse,
): Promise<NativeInteractionResult> {
  if (host.dialogs.owns(response.interactionId)) return host.dialogs.respond(context.session.id, response);
  const hash = fingerprint(response);
  const prior = await host.interactionReceipts.get(context.session.id, response.requestId);
  if (prior) {
    if (prior.fingerprint !== hash) throw host.error('INTERACTION_REQUEST_CONFLICT', 'This response request was already used', 409);
    if (prior.result.status !== 'uncertain') return prior.result;
    const intent = await readJson(join(sessionRoot(hub, context.session.id), 'responses', `${sha(response.requestId)}.json`));
    const runtime = await required(hub, host, context);
    const id = host.view.session(context.session.id)?.nativeSessionId;
    if (intent && id && intent.fingerprint === hash && id === intent.conversationId) {
      const snapshot = await runtime.rpc!.snapshot(id);
      if (answered(snapshot, intent.target, intent.answer) === 'same') {
        const result = { status: 'completed' as const };
        await host.interactionReceipts.save(context.session.id, response.requestId, { ...prior, result });
        return result;
      }
    }
    return prior.result;
  }
  const runtime = await required(hub, host, context);
  const id = host.view.session(context.session.id)?.nativeSessionId;
  if (!id) throw host.error('INTERACTION_STALE', 'The Antigravity interaction is no longer active', 409);
  await owned(runtime);
  const target = interactionOf(await runtime.rpc!.snapshot(id));
  if (!target) throw host.error('INTERACTION_STALE', 'The Antigravity interaction is no longer active', 409);
  let answer: AgyRecord;
  try {
    answer = answerOf(target, response);
  } catch {
    throw host.error('INTERACTION_STALE', 'The Antigravity interaction changed or the answer is unsupported', 409);
  }
  const receipt = {
    fingerprint: hash,
    interactionId: response.interactionId,
    revision: response.revision,
    result: { status: 'uncertain' as const },
    createdAt: new Date().toISOString(),
  };
  const responses = join(runtime.launch.root, 'responses');
  await mkdir(responses, { recursive: true, mode: 0o700 });
  const responseFile = `${sha(response.requestId)}.json`;
  await writeJson(join(responses, responseFile), { fingerprint: hash, conversationId: id, target, answer });
  await pruneResponseFiles(responses, responseFile);
  await host.interactionReceipts.save(context.session.id, response.requestId, receipt);
  try {
    await runtime.rpc!.call('HandleCascadeUserInteraction', { cascadeId: id, interaction: answer });
  } catch {
    /* a lost reply still needs its native receipt, never a second RPC */
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const outcome = answered(await runtime.rpc!.snapshot(id), target, answer);
    if (outcome) {
      const result: NativeInteractionResult =
        outcome === 'same' ? { status: 'completed' } : { status: 'uncertain', message: 'Antigravity accepted a different response' };
      await host.interactionReceipts.save(context.session.id, response.requestId, { ...receipt, result });
      changed(hub, runtime);
      return result;
    }
    await delay(150);
  }
  return receipt.result;
}
