import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../../../packages/contracts/src/index.js';
import type { TerminalService } from '../../terminal/service.js';
import { TerminalDialogObserver } from './terminal-dialogs.js';

/** The Claude workspace-trust screen exactly as the terminal renders it. */
const TRUST_SCREEN = [
  ' Accessing workspace:',
  '',
  ' /srv/home/me/project',
  '',
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

const PLAIN_SCREEN = [
  ' ╭──────────────────────────────╮',
  ' │ > Try "fix the failing test" │',
  ' ╰──────────────────────────────╯',
].join('\n');

function session(patch: Partial<Session> = {}): Session {
  return { id: 'session-a', kind: 'native', backendId: 'claude', terminalId: 'terminal-a', state: 'running', ...patch } as Session;
}

function fakeTerminal(options: { screen?: () => string | undefined; state?: 'running' | 'exited' } = {}) {
  const reads = { count: 0 };
  const terminal = {
    get: async () => ({ id: 'terminal-a', epoch: 1, state: options.state ?? 'running' }),
    screen: async () => { reads.count += 1; return options.screen ? options.screen() : PLAIN_SCREEN; },
    withInteraction: async (_id: string, task: (control: unknown) => Promise<unknown>) => task({
      screen: async () => (options.screen ? options.screen() : PLAIN_SCREEN),
      keys: async () => undefined,
      paste: async () => undefined,
    }),
  } as unknown as TerminalService;
  return { terminal, reads };
}

afterEach(() => { vi.useRealTimers(); });

describe('TerminalDialogObserver', () => {
  it('leaves out a dialog its driver does not endorse', async () => {
    const { terminal } = fakeTerminal({ screen: () => TRUST_SCREEN });
    const observer = new TerminalDialogObserver(terminal, () => false);
    expect(await observer.refresh(session())).toBeUndefined();
    expect(observer.merge(session(), { phase: 'busy' })).toEqual({ phase: 'busy' });
  });

  it('lifts a hint-closed dialog and folds it into a driver status', async () => {
    const { terminal } = fakeTerminal({ screen: () => TRUST_SCREEN });
    const observer = new TerminalDialogObserver(terminal);
    const dialog = await observer.refresh(session());
    expect(dialog).toMatchObject({ kind: 'confirmation', title: 'Accessing workspace:' });
    expect(dialog?.options.map(option => option.label)).toEqual(['No, exit', 'Yes, I trust this folder']);

    const merged = observer.merge(session(), { phase: 'busy', model: 'opus' });
    expect(merged).toMatchObject({ phase: 'attention', model: 'opus', interaction: { id: dialog!.id } });
  });

  it('never overrides a protocol request and re-checks a cached screen against the current policy', async () => {
    const { terminal } = fakeTerminal({ screen: () => TRUST_SCREEN });
    let endorsed = true;
    const observer = new TerminalDialogObserver(terminal, () => endorsed);
    const dialog = await observer.refresh(session());
    expect(observer.merge(session(), { phase: 'busy' }).interaction).toMatchObject({ id: dialog!.id });
    const protocol = { id: 'protocol-1', revision: 'r1', kind: 'permission', title: 'Run command?', options: [], actions: [] } as never;
    expect(observer.merge(session(), { phase: 'attention', interaction: protocol }).interaction).toBe(protocol);

    // The driver connects its app-server after this screen was read: the cached card is no longer
    // wanted, and no later read has run yet.
    endorsed = false;
    expect(observer.current(session())).toBeUndefined();
    expect(observer.merge(session(), { phase: 'busy' }).interaction).toBeUndefined();
    endorsed = true;
    await observer.refresh(session());
    expect(observer.current(session({ terminalId: 'replacement-terminal' }))).toBeUndefined();
  });

  it('keeps the last dialog when the screen cannot be read, and drops it with the terminal', async () => {
    let endorsed = true;
    let readable = true;
    const { terminal } = fakeTerminal({ screen: () => (readable ? TRUST_SCREEN : undefined) });
    const observer = new TerminalDialogObserver(terminal, () => endorsed);
    await observer.refresh(session());
    readable = false;
    expect(await observer.refresh(session())).toMatchObject({ title: 'Accessing workspace:' });

    // The policy can change while the read fails: the cached card is no longer valid.
    endorsed = false;
    expect(await observer.refresh(session())).toBeUndefined();
    expect(observer.current(session())).toBeUndefined();

    // The same check covers a terminal lookup that fails before the screen is read.
    let reachable = true;
    const lookup = {
      get: async () => (reachable ? { id: 'terminal-a', epoch: 1, state: 'running' } : undefined),
      screen: async () => TRUST_SCREEN,
      withInteraction: async () => undefined,
    } as unknown as TerminalService;
    let lookupEndorsed = true;
    const observerLookup = new TerminalDialogObserver(lookup, () => lookupEndorsed);
    await observerLookup.refresh(session());
    reachable = false;
    lookupEndorsed = false;
    expect(await observerLookup.refresh(session())).toBeUndefined();
    expect(observerLookup.current(session())).toBeUndefined();

    let state: 'running' | 'exited' = 'running';
    const live = {
      get: async () => ({ id: 'terminal-a', epoch: 1, state }),
      screen: async () => TRUST_SCREEN,
      withInteraction: async () => undefined,
    } as unknown as TerminalService;
    const observer2 = new TerminalDialogObserver(live);
    await observer2.refresh(session());
    expect(observer2.current(session())).toBeDefined();
    state = 'exited';
    await observer2.refresh(session());
    expect(observer2.current(session())).toBeUndefined();

    const archived = new TerminalDialogObserver(fakeTerminal({ screen: () => TRUST_SCREEN }).terminal);
    await archived.refresh(session({ archivedAt: '2026-01-01' } as Partial<Session>));
    expect(archived.current(session())).toBeUndefined();
  });

  it('reports the dialog appearing and going away while someone watches, and stops on release', async () => {
    vi.useFakeTimers();
    let screen = PLAIN_SCREEN;
    const { terminal, reads } = fakeTerminal({ screen: () => screen });
    const observer = new TerminalDialogObserver(terminal);
    const changes: Array<string | undefined> = [];
    observer.watch('session-a', () => session(), () => changes.push(observer.current(session())?.title));

    await vi.advanceTimersByTimeAsync(1600);
    expect(changes).toEqual([]);

    screen = TRUST_SCREEN;
    await vi.advanceTimersByTimeAsync(1600);
    expect(changes).toEqual(['Accessing workspace:']);

    screen = PLAIN_SCREEN;
    await vi.advanceTimersByTimeAsync(1600);
    expect(changes).toEqual(['Accessing workspace:', undefined]);

    const before = reads.count;
    observer.release('session-a');
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads.count).toBe(before);
  });

  it('answers through the CLI’s own keys, which is a terminal transaction', async () => {
    const { terminal } = fakeTerminal({ screen: () => TRUST_SCREEN });
    const observer = new TerminalDialogObserver(terminal);
    const dialog = await observer.refresh(session());
    // A stale identity still has to reach the terminal responder to be rejected there: that proves
    // the answer is delivered as keys, not handed back to the driver.
    await expect(observer.respond(session(), {
      interactionId: 'someone-elses-dialog', revision: 'r', requestId: 'request-1', action: 'option:option-1',
    })).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_STALE' });
    expect(dialog?.id).not.toBe('someone-elses-dialog');
  });
});
