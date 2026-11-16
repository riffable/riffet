import { afterEach, describe, expect, it } from 'vitest';
import type { AgentLaunchSpec, AgentSessionView } from '@riffet/plugin-api/experimental/agent';
import { cursorPort } from '../host-port.js';
import { FakeHost } from '../testing/fake-host.js';
import { NativeRuntimeManager } from './runtime.js';

/**
 * The second half of "a change takes effect": when the CLI is not running, the record keeps the intent
 * and the *next* launch has to carry it.
 *
 * Cursor is the backend whose model and permission only exist as launch flags, so this pins the whole
 * chain — a record written with no terminal, then `ensure`, which re-reads the session and builds the
 * argv from it (`buildArgs`). A regression here would look exactly like the bug this work started
 * from: the picker shows the new value and the CLI runs the old one.
 */

/** The flags of a launch, without the `--resume <chat>` the runtime puts first: what these tests pin. */
const flagsOf = (spec: AgentLaunchSpec): string[] => { const args = spec.args; return args[0] === '--resume' ? args.slice(2) : args; };

const project = { id: 'project-a', name: 'project', cwd: '/srv/home/me/project' };

function session(patch: Partial<AgentSessionView> = {}): AgentSessionView {
  return { id: 'session-a', projectId: 'project-a', title: 'conversation', state: 'idle', mode: 'agent', model: 'gpt-5.6-luna', approval: 'allowlist', ...patch };
}

const runtimes: NativeRuntimeManager[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined); });

function harness(patch: Partial<AgentSessionView> = {}) {
  const host = new FakeHost({ sessions: [session(patch)], projects: [project] });
  host.onLaunch = () => ({ id: 'terminal-1' });
  const runtime = new NativeRuntimeManager({
    port: cursorPort(host),
    prepareModel: async model => model,
    cliPath: 'cursor-agent',
    createChatId: async () => '29846c62-123d-4c49-bddc-7da93361b97a',
  });
  runtimes.push(runtime);
  return { runtime, created: host.launched, current: () => host.sessions.get('session-a')! };
}

describe('NativeRuntimeManager.ensure launch flags', () => {
  it('launches with the model and permission the record holds now', async () => {
    const { runtime, created, current } = harness({ model: 'claude-opus-5-5-high', approval: 'unrestricted', configPending: true });

    const { terminal: info } = await runtime.ensure(current());

    expect(created).toHaveLength(1);
    expect(flagsOf(created[0]!.spec)).toEqual(['--trust', '--force', '--model', 'claude-opus-5-5-high']);
    expect(info.id).toBe('terminal-1');
    expect(current().terminalId).toBe('terminal-1');
    // This launch read the record, so a switch that was waiting for a relaunch is settled: leaving the
    // flag set would make the workbench restart a CLI that already runs the current settings.
    expect(current().configPending).toBe(false);
  });

  it('carries a mode as its own flag and omits what the record does not name', async () => {
    const { runtime, created, current } = harness({ mode: 'plan', approval: undefined, model: undefined });

    await runtime.ensure(current());

    // `plan` is a launch flag like the rest, and a record with no model must not invent one.
    expect(flagsOf(created[0]!.spec)).toEqual(['--trust', '--mode', 'plan']);
  });
});
