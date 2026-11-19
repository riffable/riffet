import { describe, expect, it, vi } from 'vitest';
import { probeAuxiliaryModel } from './probe.js';
import type { AuxiliaryCallRecord } from './telemetry.js';

describe('probeAuxiliaryModel', () => {
  it('measures auth, TTFT, decode speed and detects leaked thinking on stream presets', async () => {
    const recorded: AuxiliaryCallRecord[] = [];
    const profiles = () => [{
      id: 'gw', name: 'Gateway',
      config: { apiEndpoint: 'https://probe.example', apiKey: 'k' },
    }] as never;
    const chunks = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"第一段"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"第二段"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":24}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
          await new Promise(resolve => setTimeout(resolve, 120));
        }
        controller.close();
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const result = await probeAuxiliaryModel(
        { backendId: 'claude', profileId: 'gw', model: 'claude-fast' },
        'stream',
        profiles,
        { record: entry => recorded.push(entry) },
      );
      expect(result).toMatchObject({
        backendId: 'claude',
        profileId: 'gw',
        profileName: 'Gateway',
        model: 'claude-fast',
        preset: 'stream',
        transport: 'http',
        ok: true,
        thinkingDetected: true,
        streamingSupported: true,
        outputTokens: 24,
        previewText: '第一段第二段',
      });
      expect(result.ttftMs).toBeTypeOf('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(result.ttftMs!);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        kind: 'probe',
        preset: 'stream',
        source: 'probe',
        ok: true,
        thinkingDetected: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns structured failure and records failed probes when the gateway errors', async () => {
    const recorded: AuxiliaryCallRecord[] = [];
    const profiles = () => [{
      id: 'gw', name: 'Gateway',
      config: { apiEndpoint: 'https://probe.example/v1', apiKey: 'k' },
    }] as never;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 }));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const result = await probeAuxiliaryModel(
        { backendId: 'dsh', profileId: 'gw', model: 'ds-fast' },
        'short',
        profiles,
        { record: entry => recorded.push(entry) },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('HTTP 401');
      expect(recorded[0]).toMatchObject({ kind: 'probe', preset: 'short', source: 'probe', ok: false, errorCode: 'HTTP_401' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
