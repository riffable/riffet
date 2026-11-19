import type { Project, Session } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { codexTrustArgs } from '../shared/cli-trust.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativePtyLaunchSpec } from '../types.js';
import { assertSupportedProfile, executableOf, probeAppServer } from './config.js';
import type { CodexFlavor } from './flavors.js';
import type { CodexSessionRuntime } from './runtime.js';

export interface TerminalLaunchContext {
  readonly flavor: CodexFlavor;
  readonly label: string;
  ensureRuntime(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig, forceEndpointCheck?: boolean): Promise<CodexSessionRuntime>;
}

// What "continue in a terminal" runs: the app-server Riffet already holds when the flavor can share
// it, otherwise a standalone CLI that takes the thread over once the core has stopped the runtime.

export async function terminalLaunch(ctx: TerminalLaunchContext, host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig): Promise<{ spec: NativePtyLaunchSpec; keepsRuntime?: boolean }> {
  const threadId = host.getSession(session.id).nativeSessionId;
  if (!threadId) throw new AppError('NATIVE_SESSION_NOT_STARTED', 'This conversation has not started yet, so there is nothing to continue in a terminal.', 409);
  assertSupportedProfile(profile, ctx.flavor);
  if (ctx.flavor.terminalTransport(await probeAppServer(executableOf(profile, ctx.flavor))) !== 'none') {
    // Riffet keeps the app-server and the loaded thread; only its own TUI is left out, so the terminal is the one client.
    const spec = await host.withSessionLock(session.id, async () => {
      const runtime = await ctx.ensureRuntime(host, session, project, profile, true);
      if (!runtime.connection.canRunWith(project, profile)) return undefined;
      await runtime.openOrResume();
      return await runtime.terminal.tuiLaunchSpec();
    });
    if (spec) return { spec, keepsRuntime: true };
  }
  // No shared transport: a standalone CLI owns the thread and the core stops the runtime first.
  const own: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [name, value] of Object.entries(ctx.flavor.env(profile.config))) (name === 'CODEX_HOME' || name === 'TRAE_HOME' ? own : secret)[name] = value;
  return {
    spec: {
      command: executableOf(profile, ctx.flavor),
      args: [...ctx.flavor.args(profile.config), ...codexTrustArgs(project.cwd), '-c', 'check_for_update_on_startup=false', '--cd', project.cwd, 'resume', threadId],
      env: own,
      ...(Object.keys(secret).length ? { secretEnv: secret } : {}),
      cwd: project.cwd,
      title: ctx.label,
    },
  };
}

export function resumeCommand(ctx: TerminalLaunchContext, session: Session, profile: NativeBackendProfileConfig): { argv: string[]; env: Record<string, string>; credentialsOmitted?: boolean } {
  if (!session.nativeSessionId) throw new AppError('NATIVE_SESSION_NOT_STARTED', 'This conversation has not started yet', 409);
  const command = typeof profile.config.executable === 'string' && profile.config.executable.trim() || ctx.flavor.command;
  const configDir = typeof profile.config.configDir === 'string' && profile.config.configDir.trim();
  const home = ctx.flavor.id === 'traex' ? 'TRAE_HOME' : 'CODEX_HOME';
  // A gateway profile's provider settings carry its credential; the reader's own login is used instead.
  const gateway = ctx.flavor.args(profile.config).length > 0 || Object.keys(ctx.flavor.env(profile.config)).some(name => name !== home);
  return {
    argv: [command, 'resume', session.nativeSessionId],
    env: configDir ? { [home]: configDir } : {},
    ...(gateway ? { credentialsOmitted: true } : {}),
  };
}
