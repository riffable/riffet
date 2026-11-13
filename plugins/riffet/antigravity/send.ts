import { setTimeout as delay } from 'node:timers/promises';
import { materializeAttachment } from '@riffet/plugin-api/kit';
import { type AgentHost, type AgentSendRequest } from '@riffet/plugin-api/experimental/agent';
import { composerHolds, composerText, emptyComposer } from './composer.js';
import { required } from './lifecycle.js';
import { resync } from './poll.js';
import { mcpReady } from './mcp-scope.js';
import { changed, idle, nativeStatus, owned, userBoundary, type Hub, type Runtime } from './runtime.js';

/** Attachments become `@path` references, except PNG images, which are pasted into the composer as files. */
async function resolveAttachments(host: AgentHost, request: AgentSendRequest) {
  const extras = request.input.context.map(item => `@${item.path}${item.line ? `:${item.line}` : ''}`);
  const images: string[] = [];
  for (const id of request.input.attachmentIds) {
    const { attachment, data } = await host.readAttachment(id);
    const path = await materializeAttachment(attachment, Buffer.from(data), { durable: true });
    if (attachment.mimeType === 'image/png') images.push(path);
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
const imageMarks = (screen: string | undefined) => ((screen ?? '').match(/\d*\s*media attached|image\/png|\[Image[^\]\n]*\]?/gi) ?? []).join('|');

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

async function pasteText(host: AgentHost, control: Control, text: string): Promise<void> {
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

export async function send(hub: Hub, host: AgentHost, request: AgentSendRequest) {
  const runtime = await ready(hub, host, request);
  const { extras, images } = await resolveAttachments(host, request);
  const text = [request.input.text, ...(extras.length ? ['', ...extras] : [])].join('\n');
  // Local commands can replace the native conversation or open a menu. They remain native terminal actions.
  if (/^\s*\//.test(text)) throw host.error('AGY_TERMINAL_COMMAND', 'Run this command in the Antigravity terminal', 409);
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
  if (id) await resync(hub, runtime, id);
  const status = await nativeStatus(runtime);
  if (!idle(runtime, status) || status?.conversation_id !== (id ?? '')) {
    throw host.error('CLI_BUSY', 'Antigravity is waiting for the current operation', 409);
  }
  await mcpReady(runtime);
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
  await control.keys(['Enter']);
}
