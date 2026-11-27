import { setTimeout as delay } from 'node:timers/promises';
import { materializeAttachment } from '@riffet/plugin-api/kit';
import { type AgentDelivery, type AgentHost, type AgentSendRequest } from '@riffet/plugin-api/experimental/agent';
import { composerHolds, composerText, emptyComposer } from './composer.js';
import { required } from './lifecycle.js';
import { COMMANDS } from './metadata.js';
import { resync } from './poll.js';
import { mcpReady } from './mcp-scope.js';
import { changed, detach, idle, nativeStatus, owned, userBoundary, type Hub, type Runtime } from './runtime.js';

const SUPPORTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const BLOCKED_TERMINAL_COMMANDS = new Set(COMMANDS);
const MAX_PREVIOUS_NATIVE_SESSIONS = 50;

/** Attachments become `@path` references, except supported images, which are pasted into the composer as files. */
async function resolveAttachments(host: AgentHost, request: AgentSendRequest) {
  const extras = request.input.context.map(item => `@${item.path}${item.line ? `:${item.line}` : ''}`);
  const images: string[] = [];
  for (const id of request.input.attachmentIds) {
    const { attachment, data } = await host.readAttachment(id);
    const path = await materializeAttachment(attachment, Buffer.from(data), { durable: true });
    if (SUPPORTED_IMAGE_MIMES.has(attachment.mimeType.toLowerCase())) images.push(path);
    else if (/^(?:image|audio|video)\//.test(attachment.mimeType)) {
      throw host.error('AGY_MEDIA_UNSUPPORTED', 'This Antigravity media type is not supported', 400);
    } else extras.push(path);
  }
  return { extras, images };
}

type Control = Parameters<Parameters<AgentHost['terminals']['interact']>[1]>[0];

/**
 * The image markers on screen, with their counts ("2 media attached"). Earlier ones can sit in the history above
 * the composer, so a paste is confirmed by a change in them, not by their presence.
 */
const imageMarks = (screen: string | undefined) =>
  ((screen ?? '').match(/\d*\s*media attached|image\/(?:png|jpeg|jpg|webp|gif)|\[Image[^\]\n]*\]?/gi) ?? []).join('|');

async function pasteImages(host: AgentHost, control: Control, images: string[]): Promise<void> {
  for (const path of images) {
    const before = imageMarks(await control.screen());
    await control.paste(path, false);
    let attached = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await delay(100);
      const screen = await control.screen();
      if (!composerText(screen).includes(path) && imageMarks(screen) && imageMarks(screen) !== before) {
        attached = true;
        break;
      }
    }
    if (!attached) throw host.error('AGY_INPUT_UNCONFIRMED', 'Antigravity has not confirmed the image attachment', 409);
  }
}

const SUBMIT_RECHECK_MS = 200;
const SUBMIT_RESEND_POLL_MS = 1_500;
const SUBMIT_RESEND_WINDOW_MS = 10_000;
const SUBMIT_RESEND_LIMIT = 3;

async function pasteText(host: AgentHost, control: Control, text: string): Promise<void> {
  if (!text) return;
  await control.paste(text, false);
  let observed = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(100);
    if (composerHolds(composerText(await control.screen()), text)) {
      observed = true;
      break;
    }
  }
  if (!observed) throw host.error('AGY_INPUT_UNCONFIRMED', 'Antigravity has not confirmed the pasted input', 409);
}

/** Press Enter and re-press within a bounded window if the composer still holds our unsubmitted prompt. */
async function submitComposer(host: AgentHost, control: Control, text: string, hasImages: boolean): Promise<void> {
  await control.keys(['Enter']);
  const stillHeld = (screen: string): boolean => {
    if (text) return !emptyComposer(screen) && composerHolds(composerText(screen), text);
    return hasImages && /\d+\s*media attached/i.test(screen);
  };
  const deadline = Date.now() + SUBMIT_RESEND_WINDOW_MS;
  let presses = 0;
  let wait = SUBMIT_RECHECK_MS;
  for (;;) {
    await delay(wait);
    wait = SUBMIT_RESEND_POLL_MS;
    const final = Date.now() >= deadline;
    const screen = await control.screen().catch(() => undefined);
    if (screen !== undefined) {
      if (stillHeld(screen)) {
        if (presses >= SUBMIT_RESEND_LIMIT) {
          throw host.error('AGY_INPUT_UNCONFIRMED', 'Antigravity kept the prompt in the composer after submitting', 409);
        }
        presses += 1;
        await control.keys(['Enter']);
        if (final) {
          await delay(SUBMIT_RECHECK_MS);
          const after = await control.screen().catch(() => undefined);
          if (after !== undefined && stillHeld(after)) {
            throw host.error('AGY_INPUT_UNCONFIRMED', 'Antigravity kept the prompt in the composer after submitting', 409);
          }
          return;
        }
      } else {
        return;
      }
    } else if (final) {
      return;
    }
  }
}

/** How long a send waits for a TUI that is still starting or reconnecting before handing the message back to the queue. */
const READY_WAIT_MS = 45_000;

/**
 * The runtime once agy is at its prompt. A TUI that is still starting (the first message of a conversation
 * launches it) or reconnecting is waited for here: refusing at once has the dispatcher requeue the message
 * and try again every 1.5 s, which flips it between queued and sending until agy is up. Work in progress,
 * a dialog or a pending relaunch is not waited for: the queue holds the message on those itself.
 */
async function ready(hub: Hub, host: AgentHost, request: AgentSendRequest): Promise<Runtime> {
  const deadline = Date.now() + READY_WAIT_MS;
  for (;;) {
    let runtime: Runtime | undefined;
    try {
      runtime = await required(hub, host, request.context);
    } catch (error) {
      const starting = (error as { code?: unknown }).code === 'CLI_BUSY' && !hub.runtimes.get(request.context.session.id)?.failure;
      if (!starting || Date.now() >= deadline) throw error;
    }
    if (runtime) {
      const session = host.view.session(request.context.session.id);
      if (session?.configPending && session.configRevision !== runtime.launch.configRevision) {
        throw host.error('CLI_BUSY', 'Antigravity is applying its configuration', 409);
      }
      if (runtime.status.phase === 'idle') return runtime;
      if (runtime.status.phase !== 'starting' || Date.now() >= deadline) {
        throw host.error('CLI_BUSY', 'Antigravity is waiting for the current operation', 409);
      }
    }
    await delay(250);
  }
}

/** Starts a fresh topic in a standing member's main conversation, archiving the previous native conversation id. */
async function newTopic(hub: Hub, host: AgentHost, request: AgentSendRequest): Promise<AgentDelivery> {
  if (request.input.attachmentIds.length || request.input.context.length || request.input.references?.length) {
    throw host.error('NATIVE_COMMAND_ARGUMENTS', 'Remove attachments and context references before running this command.', 400);
  }
  const sessionId = request.context.session.id;
  return await host.withSessionLock(sessionId, async () => {
    const session = await host.session(sessionId);
    if (session.terminalHold) {
      throw host.error('TERMINAL_HELD', 'This conversation is open in a terminal; return it first.', 409);
    }
    const previous = session.nativeSessionId;
    if (!previous) {
      await host.commitDispatchFence(request.runId, { slashCommand: true, renderedText: request.input.text });
      return { state: 'settled' as const };
    }
    await host.commitDispatchFence(request.runId, { slashCommand: true, renderedText: request.input.text, nativeSessionId: previous });
    if (session.terminalId) {
      await host.terminals.stop(session.terminalId).catch(() => undefined);
    }
    detach(hub, sessionId);
    const archived = [...(session.previousNativeSessionIds ?? []).filter(id => id !== previous), previous].slice(-MAX_PREVIOUS_NATIVE_SESSIONS);
    await host.updateSession(sessionId, { previousNativeSessionIds: archived, terminalId: undefined });
    await host.setNativeSessionId(sessionId, undefined);
    return { state: 'settled' as const };
  });
}

export async function send(hub: Hub, host: AgentHost, request: AgentSendRequest): Promise<AgentDelivery> {
  const sourceText = request.sourceText ?? request.input.text;
  if (host.standing?.newTopic?.(request.context.session.id, sourceText)) {
    return await newTopic(hub, host, request);
  }
  const runtime = await ready(hub, host, request);
  const { extras, images } = await resolveAttachments(host, request);
  const text = [request.input.text, ...(extras.length ? ['', ...extras] : [])].join('\n');
  // Local TUI panel commands can replace the native conversation or open a menu; allow skills (`/<skillName>`).
  const slashMatch = /^\s*\/([A-Za-z0-9_-]+)/.exec(text);
  if (slashMatch && BLOCKED_TERMINAL_COMMANDS.has(slashMatch[1]!.toLowerCase())) {
    throw host.error('AGY_TERMINAL_COMMAND', 'Run this command in the Antigravity terminal', 409);
  }
  await host.terminals.interact(runtime.launch.terminalId, async control => {
    await dispatch(hub, host, runtime, control, request, text, images);
  });
  runtime.status = { ...runtime.status, phase: 'busy' };
  changed(hub, runtime);
  return { state: 'submitted' as const };
}

/** Under the terminal's interaction lock: verify an idle empty composer, commit the dispatch fence, then type and submit. */
async function dispatch(
  hub: Hub,
  host: AgentHost,
  runtime: Runtime,
  control: Control,
  request: AgentSendRequest,
  text: string,
  images: string[],
): Promise<void> {
  await owned(runtime);
  const screen = await control.screen();
  if (!emptyComposer(screen)) throw host.error('CLI_INTERACTION_REQUIRED', 'The Antigravity terminal has a draft or an open dialog', 409);
  const id = host.view.session(request.context.session.id)?.nativeSessionId;
  const freshIdleSnapshot =
    Boolean(id) &&
    runtime.snapshot?.conversationId === id &&
    runtime.snapshot?.status === 'CASCADE_RUN_STATUS_IDLE' &&
    Boolean(runtime.stream && !runtime.stream.signal.aborted) &&
    Date.now() - (runtime.frameAt ?? 0) < 5000;
  if (id && !freshIdleSnapshot) await resync(hub, runtime, id);
  const status = await nativeStatus(runtime);
  if (!idle(runtime, status) || (status?.conversation_id ?? '') !== (id ?? '')) {
    throw host.error('CLI_BUSY', 'Antigravity is waiting for the current operation', 409);
  }
  await mcpReady(runtime, control);
  const terminal = await host.terminals.get(runtime.launch.terminalId);
  await host.commitDispatchFence(request.runId, {
    nativeSessionId: id,
    terminal: { id: terminal.id, epoch: terminal.epoch },
    renderedText: text,
    nativeInputBoundary: JSON.stringify({
      version: 1,
      root: runtime.launch.geminiDir,
      nonce: runtime.launch.nonce,
      id,
      trajectoryId: runtime.snapshot?.trajectoryId,
      users: userBoundary(runtime.snapshot),
    }),
    resolvedConfig: {
      ...request.config,
      ...(runtime.status.model ? { model: runtime.status.model } : {}),
      ...(runtime.status.approval ? { approval: runtime.status.approval } : {}),
    },
  });
  // No fallback send: any error after the fence is reconciled from native USER_INPUT records.
  await pasteImages(host, control, images);
  await pasteText(host, control, text);
  await submitComposer(host, control, text, images.length > 0);
}
