import type { NativeBackendCapabilities } from '../../../../../packages/contracts/src/index.js';
import { describeSearch, isCliMissing, resolveCliExecutable } from '../shared/cli-resolve.js';
import { modelSourceOf, resolveSource } from '../shared/model-source.js';
import type { NativeBackendAvailability, NativeBackendProfileConfig } from '../types.js';
import { codexNativeSlashItems } from './commands.js';
import { configuredCommand, executableOf, probeAppServer, supportsSteerVersion } from './config.js';
import type { CodexFlavor } from './flavors.js';
import type { NativeRuntimeHooks } from './runtime.js';

interface AvailabilityContext {
  readonly flavor: CodexFlavor;
  readonly runtimeHooks?: NativeRuntimeHooks;
}

export async function capabilitiesOf(ctx: AvailabilityContext, profile: NativeBackendProfileConfig): Promise<NativeBackendCapabilities> {
  // Probe results are shared with availability/TUI discovery and cached per executable. Never
  // test steering by writing to a user's live turn; unrecognized or older builds stay disabled.
  const supportsSteer = supportsSteerVersion((await probeAppServer(executableOf(profile, ctx.flavor))).version, ctx.flavor.id);
  return {
    supportsSessionReferences: true,
    // Consulted by another Agent (docs/AGENT-CALLS.md §5): the read-only sandbox, asking the owner before any write.
    consultPermission: 'read-only',
    backendId: ctx.flavor.id,
    label: ctx.flavor.label,
    modes: ctx.flavor.modes,
    permissions: ctx.flavor.id === 'traex' ? [
      { id: 'on-request', label: 'Workspace Edit' },
      { id: 'auto-review', label: 'Auto Mode' },
      { id: 'danger-full-access', label: 'Full Access' },
      { id: 'read-only', label: 'Read Only' },
    ] : [
      { id: 'on-request', label: 'Default', description: 'Edits the workspace freely; asks before going outside it or onto the network' },
      { id: 'dontAsk', label: 'Deny tools that need permission', shortLabel: 'Deny', description: 'Edits the workspace freely; refuses anything more instead of asking' },
      { id: 'read-only', label: 'Read only', description: 'Reads anything; asks before every edit or command that needs more' },
      { id: 'danger-full-access', label: 'Full access', description: 'No sandbox and never asks: edits and network anywhere' },
    ],
    interactionTransport: 'protocol',
    supportsResume: true,
    supportsInterrupt: true,
    // Both flavors require a verified version and uniquely attributable native input receipts.
    supportsSteer,
    supportsHistory: true,
    supportsModelSelection: true,
    supportsModeSelection: ctx.flavor.modes.length > 0,
    supportsPermissionSelection: true,
    supportsTerminal: true,
    // A plugin's sidecar attaches to a process as it is spawned for its conversation, so none is started ahead.
    supportsPrewarm: !ctx.runtimeHooks?.runtimeHooks(ctx.flavor.id).length,
    slashCommands: ctx.flavor.id === 'codex' ? codexNativeSlashItems() : [], ...(ctx.flavor.id === 'codex' ? { compactCommand: 'compact' } : {}),
    inlineSkills: true,
  };
}

export async function availabilityOf(flavor: CodexFlavor, profile: NativeBackendProfileConfig): Promise<NativeBackendAvailability> {
  const unsupported = flavor.unsupportedProfileSetting(profile.config);
  if (unsupported) return { available: false, reason: unsupported };
  const source = modelSourceOf(profile.config);
  const sourceReason = source && resolveSource(source, profile.config).reason;
  if (sourceReason) return { available: false, reason: sourceReason };
  const resolution = resolveCliExecutable({ command: configuredCommand(profile, flavor) });
  const { executable } = resolution;
  let probe;
  try {
    probe = await probeAppServer(executable);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const detail = resolution.resolved ? ` (${typeof code === 'string' ? code : 'process error'})` : `${describeSearch(resolution)} Set this profile’s executable to an absolute path.`;
    return { available: false, reason: `${flavor.label} could not be started from “${executable}”.${detail}` };
  }
  const reason = flavor.unavailableReason(probe, executable);
  const version = probe.version ? { version: probe.version } : {};
  if (reason) {
    const cliMissing = probe.executableNotFound && isCliMissing(resolution);
    return { available: false, reason, ...version, ...(cliMissing ? { cliMissing: true } : {}) };
  }
  return { available: true, ...version };
}
