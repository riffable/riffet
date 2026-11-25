import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDiscussionRequest } from '@riffet/plugin-api/experimental/agent';
import { discussionPrompt, runProcess } from '@riffet/plugin-api/kit';
import type { NativeBackendProfileConfig } from '../types.js';
import { piEnvironment, piLaunchCommand, piSelection } from './models.js';
import { piCustomEndpoint, piProviderExtension } from './provider.js';
import { record, splitModel, str } from './runtime-shared.js';
import { parseNativeModelSelection } from '../shared/model-selection.js';

/** The only extension loaded by this ephemeral CLI is Riffet's provider definition, when the profile needs it. */
export async function streamPiDiscussion(profile: NativeBackendProfileConfig, request: AgentDiscussionRequest): Promise<void> {
  request.signal.throwIfAborted();
  if (!request.model || (!piCustomEndpoint(profile) && !splitModel(parseNativeModelSelection(request.model).model).provider))
    throw new Error('The original pi provider and model are unavailable for this side chat');
  const cwd = await mkdtemp(join(tmpdir(), 'riffet-pi-discussion-'));
  try {
    const selection = await piSelection(profile, request.model, request.signal);
    const provider = await piProviderExtension(profile, cwd, request.signal);
    const launch = piLaunchCommand(profile);
    const systemFile = join(cwd, 'prompt.txt');
    await writeFile(systemFile, request.system, { mode: 0o600 });
    const args = [
      ...launch.args, '--print', '--mode', 'json', '--no-session', '--no-tools', '--no-mcp',
      '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-approve',
      '--system-prompt', systemFile,
      ...(provider ? ['-e', provider.path] : []),
      ...(selection?.provider ? ['--provider', selection.provider] : []),
      ...(selection?.modelId ? ['--model', selection.modelId] : []),
      ...(selection?.thinkingLevel ? ['--thinking', selection.thinkingLevel] : []),
    ];
    let completed = false;
    let emitted = false;
    request.signal.throwIfAborted();
    const result = await runProcess(launch.command, args, {
      cwd, env: { ...piEnvironment(profile), ...provider?.env }, signal: request.signal,
      timeoutMs: null, input: Buffer.from(discussionPrompt(request.messages)),
      onStdoutLine(line) {
        if (!line.trim()) return;
        const frame = record(JSON.parse(line));
        const update = record(frame?.assistantMessageEvent);
        if (frame?.type === 'message_update' && update?.type === 'text_delta' && typeof update.delta === 'string' && update.delta) {
          emitted = true;
          request.onDelta(update.delta);
        }
        const message = record(frame?.message);
        if (frame?.type !== 'message_end' || message?.role !== 'assistant') return;
        if (message.stopReason !== 'stop') throw new Error(str(message.errorMessage) ?? `pi ended the side chat with ${message.stopReason}`);
        if (!emitted && Array.isArray(message.content)) {
          for (const part of message.content) {
            const block = record(part);
            if (block?.type === 'text' && typeof block.text === 'string') request.onDelta(block.text);
          }
        }
        completed = true;
      },
    });
    request.signal.throwIfAborted();
    if (!completed || result.code !== 0 || result.truncated || result.timedOut) {
      throw new Error(result.stderr.trim().slice(-512) || 'pi did not complete the side chat');
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
