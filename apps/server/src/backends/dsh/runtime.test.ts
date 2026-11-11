import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelInputModalities, Project, Session } from '../../../../../packages/contracts/src/index.js';
import type { UsageRecord } from '../../stats/types.js';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import { canonicalDshModelValue, configAdoption, DSH_PERMISSIONS, DshProfileRuntime, dshPermission, dshProfilePatch } from './runtime.js';

// A DSH permission is a preset — a sandbox mode with an approval policy. The bare `never` recorded
// before presets existed ran under the workspace-write sandbox and rejected every wider action, so it
// settles on the default rather than on Full access.
describe('dshPermission', () => {
  it('passes the profile\'s presets through and settles bare legacy policies on the default', () => {
    for (const preset of Object.keys(DSH_PERMISSIONS)) expect(dshPermission(preset)).toBe(preset);
    expect(dshPermission(undefined)).toBe('workspace-write');
    expect(dshPermission('ask')).toBe('workspace-write');
    expect(dshPermission('never')).toBe('workspace-write');
  });

  it('refuses a preset the profile does not compose', () => {
    expect(() => dshPermission('custom')).toThrow(expect.objectContaining({ code: 'NATIVE_PERMISSION_UNSUPPORTED' }));
  });

  it('pairs each preset with the approval policy an older bridge can still apply', () => {
    expect(DSH_PERMISSIONS).toEqual({ 'workspace-write': 'ask', 'read-only': 'ask', 'danger-full-access': 'never', auto: 'ask' });
  });
});

// The picker sends whatever the catalog exposed, so the model string must survive normalization
// unchanged; if it did not, a chosen effort would be dropped before it ever reached DSH.
describe('canonicalDshModelValue', () => {
  it('preserves an effort carried by a DSH model string', () => {
    expect(canonicalDshModelValue('dsh:deepseek-official:deepseek-v4.1-flash[effort=max]'))
      .toBe('dsh:deepseek-official:deepseek-v4.1-flash[effort=max]');
  });

  it('adds the default provider to a bare gateway id', () => {
    expect(canonicalDshModelValue('deepseek-v4.1-flash')).toBe('dsh:deepseek-official:deepseek-v4.1-flash');
  });

  it('spells the selection without an effort when none is chosen', () => {
    expect(canonicalDshModelValue('dsh:deepseek-official:deepseek-v4.1-flash')).toBe('dsh:deepseek-official:deepseek-v4.1-flash');
  });
});

// DSH's own log is the authority for a conversation's model and approval policy, so a transcript
// read follows it. The exception is a change the workbench has just asked for: the bridge still
// reports the settings it is about to replace, and adopting those back would silently undo the
// user's choice. A read that does adopt owes the record a bumped `configRevision`, which is how a
// client holding the old settings learns they are stale before it submits.
describe('configAdoption', () => {
  const canonical = (value: string | undefined) => canonicalDshModelValue(value, 'deepseek-flash');
  const flash = 'dsh:deepseek-official:deepseek-v4.1-flash';
  const adopt = (options: { reported: { model?: string; approval?: string }; recorded: { model?: string; approval?: string; configRevision?: number }; configuring?: boolean }) =>
    configAdoption({ reported: options.reported, recorded: options.recorded, configuring: options.configuring ?? false, canonical });

  it('adopts the model DSH reports, and moves the revision with the meaning', () => {
    expect(adopt({ reported: { model: `${flash}[effort=max]`, approval: 'ask' }, recorded: { model: flash, approval: 'ask', configRevision: 3 } }))
      .toEqual({ model: `${flash}[effort=max]`, approval: 'ask', patch: { model: `${flash}[effort=max]` }, bump: true });
  });

  it('adopts the approval policy DSH reports, so the next send stops pushing the old one back', () => {
    expect(adopt({ reported: { model: flash, approval: 'never' }, recorded: { model: flash, approval: 'ask', configRevision: 0 } }))
      .toEqual({ model: flash, approval: 'never', patch: { approval: 'never' }, bump: true });
  });

  // `open()` harmonizes a bare id into DSH's spelling without touching the counter; a read must do
  // the same, or every respelling would kill the messages already queued behind it.
  it('harmonizes a spelling DSH normalized without invalidating the queue', () => {
    expect(adopt({ reported: { model: flash, approval: 'ask' }, recorded: { model: 'deepseek-v4.1-flash', approval: 'ask', configRevision: 7 } }))
      .toEqual({ model: flash, approval: 'ask', patch: { model: flash } });
  });

  it('keeps what the user asked for while the change is in flight', () => {
    expect(adopt({
      reported: { model: flash, approval: 'ask' },
      recorded: { model: `${flash}[effort=high]`, approval: 'never', configRevision: 5 },
      configuring: true,
    })).toEqual({ model: `${flash}[effort=high]`, approval: 'never' });
  });

  it('falls back to the record when DSH reported nothing', () => {
    expect(adopt({ reported: { approval: 'ask' }, recorded: { model: `${flash}[effort=max]`, approval: 'ask', configRevision: 1 } }))
      .toEqual({ model: `${flash}[effort=max]`, approval: 'ask' });
  });

  it('falls back to the profile default when neither side named a model', () => {
    expect(adopt({ reported: {}, recorded: {} }))
      .toEqual({ model: 'dsh:deepseek-official:deepseek-flash', patch: { model: 'dsh:deepseek-official:deepseek-flash' } });
  });
});

// DSH resolves a model's input types by exact id against its own catalog and treats an unknown id
// as text-only, replacing every image with a text placeholder before the request leaves. A gateway
// serves ids DSH has never heard of, so the declaration has to be written into the profile's patch.
describe('dshProfilePatch', () => {
  const profileName = 'riffet-dsh-0123456789abcdef';
  const endpoint = 'https://gateway.example.com';
  const declaration: ModelInputModalities = { 'deepseek-v4.1-flash': ['text', 'image'] };

  it('writes only the bridge when nothing is declared', () => {
    const patch = dshProfilePatch({ profileName, apiEndpoint: endpoint, enabledModels: ['deepseek-v4.1-flash'] });
    expect(patch).not.toContain('llm-deepseek');
    expect(patch).toContain("- insert:\n    - id: riffet-dsh-native-bridge\n");
  });

  it('declares the input types of a model DSH cannot catalog', () => {
    const patch = dshProfilePatch({ profileName, apiEndpoint: endpoint, enabledModels: ['deepseek-v4.1-flash'], modelInputModalities: { ...declaration } });
    expect(patch).toContain([
      '- id: llm-deepseek',
      '  config:',
      '    models:',
      '      - id: "deepseek-v4.1-flash"',
      '        name: "deepseek-v4.1-flash"',
      '        inputModalities: [text, image]',
    ].join('\n'));
  });

  // The settings API lists ids as `dsh:<provider>:<model>`, so that is what clients save back.
  it('writes the bare model of ids saved the way the server lists them', () => {
    const patch = dshProfilePatch({
      profileName,
      apiEndpoint: endpoint,
      enabledModels: ['dsh:deepseek-official:deepseek-v4.1-flash[effort=max]', 'dsh:other:model-x'],
      modelInputModalities: { 'dsh:deepseek-official:deepseek-v4.1-flash': ['text', 'image'] },
    });
    expect(patch).toContain('      - id: "deepseek-v4.1-flash"\n        name: "deepseek-v4.1-flash"\n        inputModalities: [text, image]');
    expect(patch).not.toContain('dsh:');
    expect(patch).not.toContain('model-x');
  });

  it('leaves DSH\'s own catalog alone when the profile has no endpoint to list ids from', () => {
    const patch = dshProfilePatch({ profileName, enabledModels: ['deepseek-flash'], modelInputModalities: { ...declaration } });
    expect(patch).not.toContain('llm-deepseek');
  });

  // `models` is a whole-array replacement, so an id the user never answered for still needs a row;
  // its absence would be indistinguishable from an id that accepts nothing.
  it('covers every curated id and defaults the ones without a declaration to text', () => {
    const patch = dshProfilePatch({ profileName, apiEndpoint: endpoint, enabledModels: ['a', 'b'], modelInputModalities: { b: ['image'] } });
    expect(patch).toContain('      - id: "a"\n        name: "a"\n        inputModalities: [text]');
    expect(patch).toContain('      - id: "b"\n        name: "b"\n        inputModalities: [image]');
  });

  it('keeps a declared id that the curated list has not caught up with', () => {
    const patch = dshProfilePatch({ profileName, apiEndpoint: endpoint, enabledModels: [], modelInputModalities: { ...declaration } });
    expect(patch).toContain('      - id: "deepseek-v4.1-flash"');
  });

  // The patch is YAML, and a gateway id is free to contain the characters that end a plain scalar.
  it('quotes an id that would otherwise change the meaning of the document', () => {
    const patch = dshProfilePatch({ profileName, apiEndpoint: endpoint, modelInputModalities: { 'a: b #c': ['text'] } });
    expect(patch).toContain('      - id: "a: b #c"');
  });
});

describe('DSH attempt usage', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('maps provider usage when the attempt ends, and not while it is still streaming', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-usage-'));
    dirs.push(dir);
    const usage: Array<{ sessionId: string; runId: string | undefined; usage: UsageRecord }> = [];
    const session = { id: 'session-dsh', projectId: 'project-dsh', kind: 'native', title: 'DSH', tags: [], state: 'idle', mode: 'agent', nativeSessionId: 'riffet-usage', createdAt: '', updatedAt: '' } as Session;
    const project = { id: 'project-dsh', name: 'Project', cwd: dir, createdAt: '', updatedAt: '' } as Project;
    const profile = { id: 'local', backendId: 'dsh', name: 'DSH', config: { configDir: dir, executable: 'dsh' } } as NativeBackendProfileConfig;
    const host = {
      getSession: () => session,
      updateSession: (_id: string, patch: Partial<Session>) => Object.assign(session, patch),
      stats: {
        recordUsage: (sessionId: string, runId: string | undefined, record: UsageRecord) => { usage.push({ sessionId, runId, usage: record }); },
        observeEvents: () => undefined,
      },
    } as unknown as NativeBackendHost;
    const runtime = new DshProfileRuntime(profile, host);
    const stop = runtime.subscribe(session, project, profile, () => undefined);
    const notify = (assistantStream: Record<string, unknown>) => {
      runtime.handleNotification('agent/assistant-stream', { nativeSessionId: 'riffet-usage', sessionId: session.id, assistantStream });
    };
    notify({ type: 'start', attemptId: 'attempt-1', turn: 3, step: 1 });
    notify({
      type: 'item', attemptId: 'attempt-1',
      chunk: { type: 'usage', usage: { inputTokens: 80, cacheReadTokens: 10, cacheWriteTokens: 5, outputTokens: 40, reasoningTokens: 7, model: 'deepseek-v4' } },
    });
    expect(usage).toEqual([]);
    notify({ type: 'end', attemptId: 'attempt-1' });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      sessionId: 'session-dsh',
      usage: {
        stepId: 'turn:3:step:1',
        model: 'deepseek-v4',
        inputTokens: 80,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        outputTokens: 40,
        reasoningTokens: 7,
        tokenSource: 'provider',
      },
    });
    expect(usage[0]!.runId).toBeUndefined();
    stop();
    return runtime.dispose(session.id);
  });
});
