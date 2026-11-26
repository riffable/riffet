import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod/v4';
import { WORKBENCH_APPEARANCE_BUDGET as budget } from '../../../../packages/contracts/src/budgets.js';
import { WEB_DISPLAY_OPTIONS as displayOptions } from '../../../../packages/contracts/src/theme.js';
import type { Run } from '../../../../packages/contracts/src/run.js';
import type { Auth } from '../auth.js';
import { AppError } from '../errors.js';

const themeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
const mode = z.enum(['system', 'light', 'dark']);
const displayFields = {
  textSize: z.enum(displayOptions.textSize),
  density: z.enum(displayOptions.density),
  terminalFontSize: z.number().min(displayOptions.minTerminalFontSize).max(displayOptions.maxTerminalFontSize),
  terminalPaddingHorizontal: z.number().min(0).max(displayOptions.maxHorizontalPadding),
  terminalPaddingVertical: z.number().min(0).max(displayOptions.maxVerticalPadding),
  codeTheme: z.string().min(1).max(100),
};
const displayState = z.strictObject(displayFields);
const writableDisplay = displayState.extend({
  terminalFontSize: z.literal(displayOptions.terminalFontSize),
  terminalPaddingHorizontal: displayFields.terminalPaddingHorizontal.int(),
  terminalPaddingVertical: displayFields.terminalPaddingVertical.int(),
}).partial();
const workbenchAppearanceChange = writableDisplay.extend({ themeId: themeId.optional(), mode: mode.optional(), undo: z.literal(true).optional() });
export type WorkbenchAppearanceChange = z.infer<typeof workbenchAppearanceChange>;

const readArguments = z.strictObject({});
const writeArguments = workbenchAppearanceChange.refine(args => {
  const keys = Object.keys(args);
  if (args.undo) return keys.length === 1;
  const hasTheme = args.themeId !== undefined || args.mode !== undefined;
  return keys.length > 0 && (!hasTheme || keys.every(key => key === 'themeId' || key === 'mode'));
}, 'Send one kind of change: theme and mode, display settings, or undo.');

/** The same parameter definition is published to the CLI and checked before dispatch. */
export const workbenchAppearanceTools = [
  {
    name: 'workbench_appearance_get',
    description: 'Read the palette, available themes and light/dark preference of the authenticated Riffet Web workbench that sent this turn.',
    args: readArguments,
  },
  {
    name: 'workbench_appearance_set',
    description: 'Change the Riffet Web workbench palette or light/dark preference when the owner clearly requests it. If “this page” could refer to a project preview, plugin or website, ask which page first. Read the workbench first for supported themes, text size, density, terminal layout and code themes. Send theme/mode separately from display changes. Use undo:true alone to undo the last change if it still applies. Report success only after the workbench confirms the change.',
    args: writeArguments,
  },
].map(({ name, description, args }) => ({ definition: { name, description, inputSchema: z.toJSONSchema(args, { target: 'draft-7' }) }, args }));

const options = z.array(z.strictObject({ id: z.string().min(1).max(140), name: z.string().min(1).max(160) })).max(budget.themes);
const range = z.strictObject({ min: z.number(), max: z.number() });
const appearance = z.strictObject({
  undone: z.literal(true).optional(),
  display: displayState.optional(),
  displayOptions: z.strictObject({
    textSize: z.array(displayFields.textSize).max(displayOptions.textSize.length), density: z.array(displayFields.density).max(displayOptions.density.length),
    terminalFontSize: z.array(displayFields.terminalFontSize).max(32), terminalPaddingHorizontal: range,
    terminalPaddingVertical: range, codeThemes: options,
  }).optional(),
  settingsPages: z.array(z.strictObject({id:z.string().max(160),label:z.string().max(160),parent:z.string().max(160).optional()})).max(budget.themes).optional(),
  themeId,
  mode,
  activePaletteId: themeId.optional(),
  themes: z.array(z.strictObject({ id: themeId, name: z.string().min(1).max(100) })).max(budget.themes),
});
type Appearance = z.infer<typeof appearance>;
const receipt = z.union([
  z.strictObject({ callId: z.uuid(), result: appearance }),
  z.strictObject({ callId: z.uuid(), error: z.enum(['unsupported', 'unavailable', 'conflict']) }),
]);

interface Client {
  cookie: string;
  origin: string;
  authorized(): boolean;
  send(command: { callId: string; deadline: string; change: WorkbenchAppearanceChange }): void;
  terminate(): void;
}

interface Connection {
  client: Client;
  runs: Set<string>;
  pending?: {
    id: string;
    runId: string;
    change: WorkbenchAppearanceChange;
    finish(outcome: Appearance | AppError): void;
  };
}

const targetUnavailable = () => new AppError('WORKBENCH_UNAVAILABLE', 'This user message has no connected Riffet Web workbench', 409);
const resultUnknown = () => new AppError('WORKBENCH_RESULT_UNKNOWN', 'The Riffet Web workbench did not confirm the result', 409);

/** Each command goes to the exact authenticated workbench that originated this run. */
export class WorkbenchAppearance {
  private readonly connections = new Map<string, Connection>();
  private readonly bindings = new Map<string, { sessionId: string; connectionId: string }>();

  private readonly nativeSources = new Map<string, { sessionId: string; deviceId: string }>();
  constructor(private readonly auth: Pick<Auth, 'authenticate' | 'device'>) {}

  connect(client: Client): string {
    if (this.connections.size >= budget.connections) throw targetUnavailable();
    const id = randomUUID();
    this.connections.set(id, { client, runs: new Set() });
    return id;
  }

  /** Called on first acceptance, before dispatch. An accepted run is never rebound on retry. */
  bind(request: FastifyRequest, run: Pick<Run, 'id' | 'sessionId'>): void {
    const id = request.headers['x-riffet-workbench'];
    if (this.bindings.has(run.id) || this.nativeSources.has(run.id)) return;
    if (id === undefined && request.headers.authorization && this.nativeSources.size < budget.bindingsPerConnection) {
      let principal;
      try { principal = this.auth.authenticate(request, true); } catch { return; }
      if (principal.kind === 'device' && principal.deviceId) {
        this.nativeSources.set(run.id, { sessionId: run.sessionId, deviceId: principal.deviceId });
      }
      return;
    }
    if (typeof id !== 'string') return;
    const connection = this.connections.get(id);
    if (!connection || request.headers.origin !== connection.client.origin || connection.runs.size >= budget.bindingsPerConnection) return;
    try {
      const caller = this.auth.authenticate(request, true);
      if (caller.kind !== 'cookie' || caller.cookie !== connection.client.cookie || !connection.client.authorized()) return;
    } catch { return; /* an accepted message still runs if its Web authorization expired while it was being prepared */ }
    connection.runs.add(run.id);
    this.bindings.set(run.id, { sessionId: run.sessionId, connectionId: id });
  }

  private sourceConnection(sessionId: string, runId: string) {
    const binding = this.bindings.get(runId);
    if (!binding || binding.sessionId !== sessionId) throw targetUnavailable();
    const connection = this.connections.get(binding.connectionId);
    if (!connection || !connection.client.authorized()) throw targetUnavailable();
    return connection;
  }

  authorizeSetting(sessionId: string, runId: string): void {
    const native = this.nativeSources.get(runId);
    if (native && native.sessionId === sessionId && this.auth.device(native.deviceId)) return;
    this.sourceConnection(sessionId, runId);
  }

  async apply(sessionId: string, runId: string, change: WorkbenchAppearanceChange, signal?: AbortSignal): Promise<Appearance> {
    const connection = this.sourceConnection(sessionId, runId);
    if (signal?.aborted) throw targetUnavailable();
    if (connection.pending) throw new AppError('WORKBENCH_BUSY', 'The Riffet Web workbench is handling another appearance request', 409);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => finish(resultUnknown());
      const finish = (outcome: Appearance | AppError) => {
        if (connection.pending?.id !== id) return;
        connection.pending = undefined;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (outcome instanceof AppError) reject(outcome);
        else resolve(outcome);
      };
      const timer = setTimeout(abort, budget.callMs);
      timer.unref();
      connection.pending = { id, runId, change, finish };
      signal?.addEventListener('abort', abort, { once: true });
      try { connection.client.send({ callId: id, deadline: new Date(Date.now() + budget.callMs).toISOString(), change }); }
      catch { finish(resultUnknown()); }
    });
  }

  receive(connectionId: string, message: unknown): void {
    const connection = this.connections.get(connectionId);
    if (!connection?.pending || !connection.client.authorized()) return;
    const pending = connection.pending;
    const parsed = receipt.safeParse(message);
    if (!parsed.success || parsed.data.callId !== pending.id) return;
    if ('error' in parsed.data && parsed.data.error === 'conflict') {
      pending.finish(new AppError('SETTINGS_CONFLICT', 'The workbench preference changed. Read it before applying another change.', 409));
      return;
    }
    if ('error' in parsed.data && parsed.data.error === 'unsupported') {
      pending.finish(new AppError('WORKBENCH_APPEARANCE_UNSUPPORTED', 'That appearance option is unavailable in the Riffet Web workbench', 409));
      return;
    }
    if (!('result' in parsed.data)) { pending.finish(resultUnknown()); return; }
    const { result } = parsed.data;
    const activePaletteId = result.activePaletteId ?? result.themeId;
    if ((pending.change.themeId !== undefined && (result.themeId !== pending.change.themeId || activePaletteId !== pending.change.themeId))
      || (pending.change.mode !== undefined && result.mode !== pending.change.mode)
      || (Object.keys(displayFields) as Array<keyof typeof displayFields>).some(key => pending.change[key] !== undefined && result.display?.[key] !== pending.change[key])
      || (pending.change.undo && !result.undone)) {
      pending.finish(resultUnknown());
      return;
    }
    pending.finish(result);
  }

  release(runId: string): void {
    this.nativeSources.delete(runId);
    const binding = this.bindings.get(runId);
    if (!binding) return;
    this.bindings.delete(runId);
    const connection = this.connections.get(binding.connectionId);
    connection?.runs.delete(runId);
    if (connection?.pending?.runId === runId) connection.pending.finish(resultUnknown());
  }

  disconnect(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    for (const runId of connection.runs) this.release(runId);
    this.connections.delete(connectionId);
  }

  close(): void {
    this.nativeSources.clear();
    for (const [id, connection] of this.connections) {
      this.disconnect(id);
      connection.client.terminate();
    }
  }
}
