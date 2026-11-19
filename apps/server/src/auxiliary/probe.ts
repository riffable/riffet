import type { AuxiliaryModelRef, ModelProbePreset, ModelProbeResult } from '../../../../packages/contracts/src/index.js';
import { streamComplete, type CompletionMetrics } from './gateway.js';
import { auxiliaryEndpoint, type GatewayProfiles } from './models.js';
import type { AuxiliaryCallRecorder } from './telemetry.js';

const PRESET_PROMPTS: Record<ModelProbePreset, { system: string; content: string; maxOutputTokens: number; timeoutMs: number }> = {
  short: {
    system: 'Generate a concise session title of at most 12 words. Reply with the title alone.',
    content: '<user_message>\nOptimize the statistics page layout and add model latency rankings by task type.\n</user_message>\n\nTitle:',
    maxOutputTokens: 128,
    timeoutMs: 25_000,
  },
  stream: {
    system: 'Translate the following technical paragraph into Simplified Chinese. Keep Markdown and inline code unchanged. Output the translation alone.',
    content: 'The auxiliary model fast path disables hidden reasoning across `anthropic`, `chat`, and `responses` protocols, caches command-minted credentials for 60 seconds, and streams partial text over Server-Sent Events so users see the first tokens within one second.',
    maxOutputTokens: 512,
    timeoutMs: 35_000,
  },
  long: {
    system: 'Summarize the key decisions and open follow-ups from this engineering log in 3 short bullet points. Output the bullets alone.',
    content: Array.from({ length: 18 }, (_, index) =>
      `Turn ${index + 1}: Reviewed module ${index + 1} latency breakdown. Endpoint preparation took ${12 + (index % 5) * 4}ms; gateway TTFT averaged ${280 + index * 15}ms. Confirmed zero-thinking mode reduced output stalls and avoided reasoning token waste across HTTP providers.`
    ).join('\n\n'),
    maxOutputTokens: 512,
    timeoutMs: 45_000,
  },
};

export async function probeAuxiliaryModel(
  ref: AuxiliaryModelRef,
  preset: ModelProbePreset,
  gatewayProfiles: GatewayProfiles,
  options: {
    signal?: AbortSignal;
    record?: AuxiliaryCallRecorder;
    streamComplete?: typeof streamComplete;
  } = {},
): Promise<ModelProbeResult> {
  const prompt = PRESET_PROMPTS[preset];
  const authStartedAt = Date.now();
  let endpoint: Awaited<ReturnType<typeof auxiliaryEndpoint>>;
  try {
    endpoint = await auxiliaryEndpoint(ref, gatewayProfiles, options.signal, { bypassAuthCache: true });
  } catch (error) {
    const authMs = Math.max(0, Date.now() - authStartedAt);
    const message = error instanceof Error ? error.message : String(error);
    options.record?.({
      kind: 'probe',
      preset,
      source: 'probe',
      backendId: ref.backendId,
      profileId: ref.profileId,
      model: ref.model,
      transport: 'http',
      ok: false,
      authMs,
      ttftMs: null,
      durationMs: authMs,
      reasoningChars: 0,
      thinkingDetected: false,
      streaming: false,
      errorCode: 'ENDPOINT_UNAVAILABLE',
    });
    return {
      backendId: ref.backendId,
      profileId: ref.profileId,
      profileName: ref.profileId,
      model: ref.model,
      preset,
      transport: 'http',
      ok: false,
      error: message,
      authMs,
      ttftMs: null,
      durationMs: authMs,
      outputTokens: null,
      reasoningTokens: null,
      reasoningChars: 0,
      thinkingDetected: false,
      streamingSupported: false,
      outputTokensPerSecond: null,
    };
  }

  const authMs = Math.max(0, Date.now() - authStartedAt);
  const transport = (endpoint.executeComplete || endpoint.executeStreamChat) ? 'cli-process' : 'http';
  let metrics: CompletionMetrics | undefined;
  let chunkCount = 0;
  const runStream = options.streamComplete ?? streamComplete;
  const callStartedAt = Date.now();

  try {
    const raw = await runStream({
      ...endpoint,
      system: prompt.system,
      content: prompt.content,
      maxOutputTokens: prompt.maxOutputTokens,
      timeoutMs: prompt.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      onDelta: delta => { if (delta) chunkCount += 1; },
      onMetrics: recorded => { metrics = recorded; },
    });
    const text = raw.trim();
    const durationMs = metrics?.durationMs ?? Math.max(0, Date.now() - callStartedAt);
    const ttftMs = metrics?.ttftMs ?? null;
    const outputTokens = metrics?.outputTokens ?? null;
    const reasoningTokens = metrics?.reasoningTokens ?? null;
    const reasoningChars = metrics?.reasoningChars ?? 0;
    const thinkingDetected = metrics?.thinkingDetected ?? false;
    const outputTokensPerSecond = metrics?.outputTokensPerSecond ?? null;
    const streamingSupported = Boolean(metrics?.streaming && (chunkCount > 1 || ttftMs !== null));
    options.record?.({
      kind: 'probe',
      preset,
      source: 'probe',
      backendId: ref.backendId,
      profileId: ref.profileId,
      model: ref.model,
      transport,
      protocol: endpoint.protocol,
      ok: Boolean(text),
      authMs,
      ttftMs,
      durationMs,
      inputTokens: metrics?.inputTokens ?? null,
      outputTokens,
      reasoningTokens,
      reasoningChars,
      thinkingDetected,
      streaming: streamingSupported,
      ...(text ? {} : { errorCode: 'EMPTY_OUTPUT' }),
    });
    return {
      backendId: ref.backendId,
      profileId: ref.profileId,
      profileName: endpoint.profileName,
      model: ref.model,
      preset,
      transport,
      ok: Boolean(text),
      ...(text ? {} : { error: 'The model returned no output' }),
      authMs,
      ttftMs,
      durationMs,
      outputTokens,
      reasoningTokens,
      reasoningChars,
      thinkingDetected,
      streamingSupported,
      outputTokensPerSecond,
      ...(text ? { previewText: text.slice(0, 240) } : {}),
    };
  } catch (error) {
    const durationMs = metrics?.durationMs ?? Math.max(0, Date.now() - callStartedAt);
    const message = error instanceof Error ? error.message : String(error);
    options.record?.({
      kind: 'probe',
      preset,
      source: 'probe',
      backendId: ref.backendId,
      profileId: ref.profileId,
      model: ref.model,
      transport,
      protocol: endpoint.protocol,
      ok: false,
      authMs,
      ttftMs: metrics?.ttftMs ?? null,
      durationMs,
      inputTokens: metrics?.inputTokens ?? null,
      outputTokens: metrics?.outputTokens ?? null,
      reasoningTokens: metrics?.reasoningTokens ?? null,
      reasoningChars: metrics?.reasoningChars ?? 0,
      thinkingDetected: metrics?.thinkingDetected ?? false,
      streaming: chunkCount > 1,
      errorCode: metrics?.errorCode ?? 'ERROR',
    });
    return {
      backendId: ref.backendId,
      profileId: ref.profileId,
      profileName: endpoint.profileName,
      model: ref.model,
      preset,
      transport,
      ok: false,
      error: message,
      authMs,
      ttftMs: metrics?.ttftMs ?? null,
      durationMs,
      outputTokens: metrics?.outputTokens ?? null,
      reasoningTokens: metrics?.reasoningTokens ?? null,
      reasoningChars: metrics?.reasoningChars ?? 0,
      thinkingDetected: metrics?.thinkingDetected ?? false,
      streamingSupported: chunkCount > 1,
      outputTokensPerSecond: metrics?.outputTokensPerSecond ?? null,
    };
  }
}
