import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Session } from '../../../../../packages/contracts/src/index.js';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';

// The adapter's orchestration is what this file pins: DSH installs a selection on a live agent, so a
// conversation it does not hold is resumed first — the order DSH's own session controller uses
// (`resolveAgent` before `selectModel`). The bridge side is exercised against a real profile.
const mocks = vi.hoisted(() => ({
  runtime: {
    open: vi.fn(),
    configure: vi.fn(),
    isOpen: vi.fn(),
    setConfiguring: vi.fn(),
  },
}));
vi.mock('./runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtime.js')>()),
  getDshProfileRuntime: () => mocks.runtime,
}));

const { DshBackendAdapter } = await import('./index.js');

const adapter = new DshBackendAdapter();
const session = {
  id: 'session-1', projectId: 'project-1', kind: 'native', title: 'DSH', tags: [], state: 'idle',
  backendId: 'dsh', mode: 'agent', model: 'dsh:deepseek-official:deepseek-v4.1-flash[effort=max]', approval: 'ask',
  nativeSessionId: 'riffet-1', createdAt: '', updatedAt: '',
} as Session;
const project = { id: 'project-1', name: 'Project', cwd: '/tmp/project', createdAt: '', updatedAt: '' } as Project;
const profile = { id: 'local', backendId: 'dsh', name: 'DeepSeek Harness', config: {} } as NativeBackendProfileConfig;
const switched = 'dsh:deepseek-official:deepseek-v4.1-flash[effort=high]';

function hostWith() {
  const setNativeSessionId = vi.fn(() => session);
  const host = {
    getProject: () => project,
    setNativeSessionId,
    withSessionLock: async (_sessionId: string, operation: () => Promise<unknown>) => await operation(),
  } as unknown as NativeBackendHost;
  return { host, setNativeSessionId };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtime.isOpen.mockReturnValue(true);
  mocks.runtime.open.mockResolvedValue({ nativeSessionId: 'riffet-1', status: { phase: 'idle' } });
  mocks.runtime.configure.mockResolvedValue({ nativeSessionId: 'riffet-1' });
});

describe('DshBackendAdapter.configure', () => {
  it('resumes a conversation the runtime does not hold before installing the change', async () => {
    mocks.runtime.isOpen.mockReturnValue(false);
    const { host, setNativeSessionId } = hostWith();

    const result = await adapter.configure(host, session, profile, { model: switched });

    // The resume carries the record as it stands: the change is installed by `session/configure`
    // after the bridge validated it, so a refused model cannot leave the approval policy applied.
    expect(mocks.runtime.open).toHaveBeenCalledWith(session, project, profile);
    expect(setNativeSessionId).toHaveBeenCalledWith('session-1', 'riffet-1');
    expect(mocks.runtime.configure).toHaveBeenCalledWith(session, { model: switched });
    expect(mocks.runtime.open.mock.invocationCallOrder[0]).toBeLessThan(mocks.runtime.configure.mock.invocationCallOrder[0]!);
    expect(result).toMatchObject({ model: switched, nativeSessionId: 'riffet-1' });
  });

  it('installs the change directly when the conversation is already open', async () => {
    const { host, setNativeSessionId } = hostWith();

    await adapter.configure(host, session, profile, { model: switched });

    expect(mocks.runtime.open).not.toHaveBeenCalled();
    expect(setNativeSessionId).not.toHaveBeenCalled();
    expect(mocks.runtime.configure).toHaveBeenCalledWith(session, { model: switched });
  });

  // The mark is what keeps a transcript read from adopting back the model DSH is about to replace.
  it('marks the conversation while the change is in flight and clears it afterwards', async () => {
    const { host } = hostWith();

    await adapter.configure(host, session, profile, { model: switched });

    expect(mocks.runtime.setConfiguring.mock.calls).toEqual([['session-1', true], ['session-1', false]]);
  });

  it('turns a model this profile cannot serve into a client-visible error', async () => {
    mocks.runtime.configure.mockResolvedValue({ failure: { reason: 'model-unavailable', message: 'unknown model: nope' } });
    const { host } = hostWith();

    await expect(adapter.configure(host, session, profile, { model: 'nope' }))
      .rejects.toMatchObject({ code: 'INVALID_MODEL', message: 'unknown model: nope' });
    expect(mocks.runtime.setConfiguring).toHaveBeenLastCalledWith('session-1', false);
  });

  it('reports a conversation DSH stopped holding instead of claiming the change landed', async () => {
    mocks.runtime.configure.mockResolvedValue({ failure: { reason: 'session-not-open' } });
    const { host } = hostWith();

    await expect(adapter.configure(host, session, profile, { model: switched }))
      .rejects.toMatchObject({ code: 'NATIVE_SESSION_NOT_OPEN' });
  });

  it('records the DSH preset a permission runs as, settling bare legacy policies on the default', async () => {
    const { host } = hostWith();

    await expect(adapter.configure(host, session, profile, { approval: 'danger-full-access' })).resolves.toMatchObject({ approval: 'danger-full-access' });
    await expect(adapter.configure(host, session, profile, { approval: 'auto' })).resolves.toMatchObject({ approval: 'auto' });
    await expect(adapter.configure(host, session, profile, { approval: 'never' })).resolves.toMatchObject({ approval: 'workspace-write' });
  });

  it('turns a preset the profile does not offer or admit into a client-visible error', async () => {
    mocks.runtime.configure.mockResolvedValue({ failure: { reason: 'permission-unavailable', message: 'permission: unknown preset "auto"' } });
    const { host } = hostWith();

    await expect(adapter.configure(host, session, profile, { approval: 'auto' }))
      .rejects.toMatchObject({ code: 'INVALID_APPROVAL_MODE', message: 'permission: unknown preset "auto"' });
  });

  it('advertises the profile\'s presets with the default first', () => {
    const { host } = hostWith();
    expect(adapter.capabilities(host, profile).permissions.map(item => item.id))
      .toEqual(['workspace-write', 'read-only', 'danger-full-access', 'auto']);
  });

  it('clears the in-flight mark when the change itself fails', async () => {
    mocks.runtime.configure.mockRejectedValue(new Error('DeepSeek Harness bridge is offline'));
    const { host } = hostWith();

    await expect(adapter.configure(host, session, profile, { model: switched })).rejects.toThrow('bridge is offline');
    expect(mocks.runtime.setConfiguring).toHaveBeenLastCalledWith('session-1', false);
  });
});
