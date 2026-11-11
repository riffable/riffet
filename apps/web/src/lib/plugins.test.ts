import { describe, expect, it } from 'vitest';
import type { PluginDescriptor, ModelSourceDescriptor } from '@contracts';
import { modelSourcesFor } from './plugins';

const source = (id: string, patch: Partial<ModelSourceDescriptor>): ModelSourceDescriptor => ({ id, label: id, backends: [], overridable: [], ...patch });
const plugins = [{ id: 'acme.models', enabled: true, actions: [], contributes: { modelSources: [
  source('messages', { backends: ['claude'], protocols: ['anthropic-messages'] }),
  source('responses', { backends: ['codex'], protocols: ['openai-responses'] }),
  source('older', { backends: ['codex'] }),
] } }] as unknown as PluginDescriptor[];
const ids = (backendId: string, consumes?: string[]) => modelSourcesFor(plugins, backendId as never, consumes).map((entry) => entry.source.id);

describe('model sources offered to a backend', () => {
  it('match by gateway protocol, so a plugin Agent gets every source it can consume', () => {
    expect(ids('acme.agent', ['openai-responses'])).toEqual(['responses']);
    expect(ids('claude', ['anthropic-messages'])).toEqual(['messages']);
    expect(ids('acme.agent', [])).toEqual([]);
  });

  it('fall back to backends when the server does not report protocols', () => {
    expect(ids('codex')).toEqual(['responses', 'older']);
    expect(ids('acme.agent')).toEqual([]);
  });
});
