import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeInteraction, Session, TerminalInfo } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import type { NativeBackendDriver, NativeBackendProfileConfig as ProfileConfig, NativeBackendTraits, NativeControlMessage } from './types.js';
import type { TerminalService } from '../terminal/service.js';
import { NativeBackendService } from './service.js';
import { CLAUDE_TRAITS } from './claude/index.js';

/** The traits the Cursor plugin declares (`plugins/riffet/cursor/backend.ts`); the service reads traits, never a backend id. */
const CURSOR_TRAITS: NativeBackendTraits = { settlesSlashOnSubmit: true, untaggedEcho: true, reportsTurnOutcome: true, ownsSessionObservation: true, resumesByNativeId: true, terminalName: 'Cursor' };

/**
 * These tests pin the seam that makes a Claude Code or Codex startup screen reach the web: the
 * driver owns the conversation and reports nothing, the terminal is showing a blocking dialog, and
 * the service has to put the two together — without ever shadowing a real protocol request.
 */

const TRUST_SCREEN = [
  ' Accessing workspace:',
  '',
  ' /srv/home/me/project',
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

const project = { id: 'project-a', cwd: '/srv/home/me/project', name: 'project' };
const terminalInfo = { id: 'terminal-a', epoch: 1, state: 'running', kind: 'native', sessionId: 'session-a', projectId: 'project-a' } as unknown as TerminalInfo;

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 'session-a', projectId: 'project-a', kind: 'native', backendId: 'claude', terminalId: 'terminal-a',
    state: 'running', title: 'session', tags: [],
    ...patch,
  } as Session;
}

interface Harness { service: NativeBackendService; emit: (message: NativeControlMessage) => void; driverResponds: NativeInteraction[]; terminalWrites: string[][]; attach: () => void; }

function harness(options: { backendId?: 'claude' | 'cursor'; screen?: string; protocolInteraction?: NativeInteraction; deferTerminal?: boolean; endorsed?: boolean; beforeOperation?: () => void; beforeControl?: () => void; afterKey?: (keys: string[]) => void; afterEnterScreen?: string } = {}): Harness {
  let current = session({ backendId: options.backendId ?? 'claude', ...(options.deferTerminal ? { terminalId: undefined } : {}) });
  const terminalWrites: string[][] = [];
  const driverResponds: NativeInteraction[] = [];
  let emit: (message: NativeControlMessage) => void = () => undefined;

  const driver = {
    id: options.backendId ?? 'claude',
    traits: options.backendId === 'cursor' ? CURSOR_TRAITS : CLAUDE_TRAITS,
    label: 'Test backend',
    profiles: () => [{ id: 'local', backendId: options.backendId ?? 'claude', name: 'Local', isDefault: true, config: {} }] as ProfileConfig[],
    capabilities: () => ({ backendId: options.backendId ?? 'claude', label: 'Test backend', modes: [], permissions: [], interactionTransport: 'protocol', supportsResume: true, supportsInterrupt: true, supportsHistory: true, supportsModelSelection: true, supportsModeSelection: false, supportsPermissionSelection: false }),
    // A faithful driver reports its own pending request in its status; that is what the service
    // must never shadow with a screen dialog.
    status: () => (options.protocolInteraction
      ? { phase: 'attention' as const, interaction: options.protocolInteraction }
      : { phase: 'busy' as const }),
    interaction: () => options.protocolInteraction,
    endorsesScreenDialog: () => options.endorsed ?? true,
    respond: async (_host: unknown, _session: Session, _profile: ProfileConfig, response: { interactionId: string }) => {
      driverResponds.push(response as unknown as NativeInteraction);
      return { status: 'completed' as const };
    },
    subscribe: (_host: unknown, _session: Session, _profile: ProfileConfig, listener: (message: NativeControlMessage) => void) => {
      emit = listener;
      return () => undefined;
    },
  } as unknown as NativeBackendDriver;

  const store = {
    getSession: () => current,
    updateSession: (_id: string, patch: Partial<Session>) => (current = { ...current, ...patch }),
    appendEvent: () => undefined,
    listTerminals: () => [terminalInfo],
    getProject: () => project,
  } as unknown as Store;

  const terminal = {
    get: async () => terminalInfo,
    screen: async () => options.screen ?? TRUST_SCREEN,
    withInteraction: async (_id: string, task: (control: unknown) => Promise<unknown>) => {
      options.beforeControl?.();
      return task({
        screen: async () => options.screen ?? TRUST_SCREEN,
        keys: async (keys: string[]) => {
          terminalWrites.push(keys);
          if (keys.includes('Enter') && options.afterEnterScreen) options.screen = options.afterEnterScreen;
          options.afterKey?.(keys);
        },
        paste: async () => undefined,
      });
    },
  } as unknown as TerminalService;

  const service = new NativeBackendService({
    store,
    workspace: {} as never,
    terminal,
    runtime: { withSession: async <T>(_id: string, operation: () => Promise<T> | T) => { options.beforeOperation?.(); return await operation(); } } as never,
    registry: { require: () => driver } as never,
  });
  return { service, emit: message => emit(message), driverResponds, terminalWrites, attach: () => { current = { ...current, terminalId: 'terminal-a' }; } };
}

const services: NativeBackendService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const service of services.splice(0)) await service.closeAll().catch(() => undefined);
});

function build(options: Parameters<typeof harness>[0] = {}): Harness {
  const built = harness(options);
  services.push(built.service);
  return built;
}

describe('terminal dialogs in the backend service', () => {
  it('serves a screen dialog when the driver has no protocol request open', async () => {
    const { service } = build();
    const dialog = await service.interaction(session());
    expect(dialog).toMatchObject({ kind: 'confirmation', title: 'Accessing workspace:' });
    expect(dialog?.options.map(option => option.label)).toEqual(['No, exit', 'Yes, I trust this folder']);
  });

  it('prefers the driver’s own interaction and never shadows it', async () => {
    const protocol = { id: 'protocol-1', revision: 'r1', kind: 'permission', title: 'Run command?', options: [], actions: [] } as unknown as NativeInteraction;
    const { service, emit } = build({ protocolInteraction: protocol });
    expect(await service.interaction(session())).toBe(protocol);
    const received: NativeControlMessage[] = [];
    service.watchControl('session-a', message => received.push(message));
    await new Promise(resolve => setTimeout(resolve, 5));
    emit({ type: 'status', status: { phase: 'attention', interaction: protocol } });
    // Every status this session publishes carries the driver's request, never the screen dialog.
    const statuses = received.filter((message): message is Extract<NativeControlMessage, { type: 'status' }> => message.type === 'status');
    expect(statuses.length).toBeGreaterThan(0);
    for (const message of statuses) {
      if (message.status.interaction) expect(message.status.interaction).toBe(protocol);
    }
    expect(statuses.some(message => message.status.interaction === protocol)).toBe(true);
  });

  it('merges the dialog into the status a reader receives', async () => {
    const { service, emit } = build();
    const received: NativeControlMessage[] = [];
    service.watchControl('session-a', message => received.push(message));
    await service.interaction(session());
    emit({ type: 'status', status: { phase: 'busy' } });
    const status = received.filter((message): message is Extract<NativeControlMessage, { type: 'status' }> => message.type === 'status')
      .map(message => message.status).find(item => item.interaction);
    expect(status).toMatchObject({ phase: 'attention', interaction: { title: 'Accessing workspace:' } });
  });

  it('answers a screen dialog with the CLI’s own keys, and a protocol one through the driver', async () => {
    const { service, driverResponds } = build();
    const dialog = await service.interaction(session());
    // A stale revision reaches the terminal responder and is rejected there, which is what proves
    // the answer is driven as keys rather than handed back to the driver.
    await expect(service.respondInteraction(session(), {
      interactionId: dialog!.id, revision: 'not-the-current-screen', requestId: 'request-1', action: 'option:option-1',
    })).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_STALE' });
    expect(driverResponds).toHaveLength(0);

    const protocol = { id: 'protocol-1', revision: 'r1', kind: 'permission', title: 'Run command?', options: [], actions: [] } as unknown as NativeInteraction;
    const routed = build({ protocolInteraction: protocol });
    await routed.service.respondInteraction(session(), { interactionId: 'protocol-1', revision: 'r1', requestId: 'request-2', action: 'option:option-0' });
    expect(routed.driverResponds).toHaveLength(1);
  });

  it('does not answer a cached screen superseded by protocol or policy inside the session fence', async () => {
    const protocol = { id: 'protocol-new', revision: 'r1', kind: 'permission', title: 'Run command?', options: [], actions: [] } as unknown as NativeInteraction;
    for (const supersededBy of ['protocol', 'policy'] as const) {
      const options: Parameters<typeof harness>[0] = {};
      const { service, terminalWrites, driverResponds } = build(options);
      const dialog = await service.interaction(session());
      options.beforeOperation = () => {
        if (supersededBy === 'protocol') options.protocolInteraction = protocol;
        else options.endorsed = false;
      };
      const result = await service.respondInteraction(session(), {
        interactionId: dialog!.id, revision: dialog!.revision, requestId: `stale-${supersededBy}`, action: 'option:option-0',
      });
      expect(result.status).toBe('uncertain');
      expect(result.interaction).toBe(supersededBy === 'protocol' ? protocol : undefined);
      expect(terminalWrites).toEqual([]);
      expect(driverResponds).toEqual([]);
    }
  });

  it('rechecks protocol and policy after acquiring terminal control and before later keys', async () => {
    const protocol = { id: 'protocol-new', revision: 'r1', kind: 'permission', title: 'Run command?', options: [], actions: [] } as unknown as NativeInteraction;
    for (const supersededBy of ['protocol', 'policy'] as const) {
      const options: Parameters<typeof harness>[0] = {};
      const { service, terminalWrites, driverResponds } = build(options);
      const dialog = await service.interaction(session());
      const revoke = () => {
        if (supersededBy === 'protocol') options.protocolInteraction = protocol;
        else options.endorsed = false;
      };
      options.beforeControl = revoke;
      const response = { interactionId: dialog!.id, revision: dialog!.revision, requestId: `control-${supersededBy}`, action: 'option:option-0' };
      await expect(service.respondInteraction(session(), response)).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_STALE' });
      expect(terminalWrites).toEqual([]);
      expect(driverResponds).toEqual([]);

      // An already started selection must stop before confirmation if policy changes midway.
      options.beforeControl = undefined;
      options.protocolInteraction = undefined;
      options.endorsed = true;
      options.afterKey = keys => {
        if (!keys.includes('Down')) return;
        options.screen = TRUST_SCREEN.replace(' ❯ No, exit', '   No, exit').replace('   Yes, I trust this folder', ' ❯ Yes, I trust this folder');
        revoke();
      };
      const result = await service.respondInteraction(session(), { ...response, requestId: `midway-${supersededBy}`, action: 'option:option-1' });
      expect(result.status).toBe('uncertain');
      expect(terminalWrites).toEqual([['Down']]);
      expect(await service.respondInteraction(session(), { ...response, requestId: `midway-${supersededBy}`, action: 'option:option-1' })).toEqual(result);
      expect(terminalWrites).toEqual([['Down']]);
    }
  });

  it('replays a terminal receipt after its screen disappears without a second side effect', async () => {
    vi.useFakeTimers();
    const options: Parameters<typeof harness>[0] = { afterEnterScreen: 'Ready for a new request' };
    const { service, terminalWrites, driverResponds } = build(options);
    const dialog = await service.interaction(session());
    const received: NativeControlMessage[] = [];
    const watcher = service.watchControl('session-a', message => received.push(message));
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.status().interaction?.id).toBe(dialog!.id);
    const response = { interactionId: dialog!.id, revision: dialog!.revision, requestId: 'terminal-retry', action: 'option:option-0' };
    const first = service.respondInteraction(session(), response);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toEqual({ status: 'completed' });
    const statuses = received.filter((message): message is Extract<NativeControlMessage, { type: 'status' }> => message.type === 'status');
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.at(-1)?.status.interaction).toBeUndefined();
    expect(await service.interaction(session())).toBeUndefined();
    options.protocolInteraction = { id: 'protocol-new', revision: 'r1', kind: 'permission', options: [], actions: [] } as unknown as NativeInteraction;
    expect(await service.respondInteraction(session(), response)).toEqual({ status: 'completed' });
    await expect(service.respondInteraction(session(), { ...response, action: 'option:option-1' })).rejects.toMatchObject({ code: 'INTERACTION_REQUEST_REUSED' });
    expect(terminalWrites).toEqual([['Enter']]);
    expect(driverResponds).toEqual([]);
  });

  it('starts reading a terminal that appears after the page already attached', async () => {
    vi.useFakeTimers();
    const { service, attach } = build({ deferTerminal: true });
    const received: NativeControlMessage[] = [];
    service.watchControl('session-a', message => received.push(message));
    await vi.advanceTimersByTimeAsync(2 * 1500);
    expect(received.some(message => message.type === 'status' && message.status.interaction)).toBe(false);

    // The CLI launches after the stream was opened; the pump has to notice, not give up.
    attach();
    await vi.advanceTimersByTimeAsync(2 * 1500);
    expect(received.some(message => message.type === 'status' && message.status.interaction?.title === 'Accessing workspace:')).toBe(true);
  });

  it('leaves Cursor sessions alone: its driver already parses its own screen', async () => {
    const { service, emit } = build({ backendId: 'cursor' });
    expect(await service.interaction(session({ backendId: 'cursor' }))).toBeUndefined();
    const received: NativeControlMessage[] = [];
    service.watchControl('session-a', message => received.push(message));
    await new Promise(resolve => setTimeout(resolve, 5));
    emit({ type: 'status', status: { phase: 'busy' } });
    expect(received.some(message => message.type === 'status' && message.status.interaction)).toBe(false);
  });
});
