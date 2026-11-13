/** The private agy JSON protocol (1.5.6, re-checked on 1.5.7). Unknown or incomplete shapes never become a complete snapshot. */
export type AgyRecord = Record<string, any>;
export interface AgySnapshot {
  conversationId: string;
  trajectoryId: string;
  steps: AgyRecord[];
  executors: AgyRecord[];
  metadata?: AgyRecord;
  status?: string;
  fullyIdle?: boolean;
}
export const AGY_PROTOCOL_VERSION = '1.5.6';
export const AGY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AGY_STEP_LIMIT = 100_000;
export function agyRecord(value: unknown): value is AgyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function agyConversationId(value: unknown): string {
  if (typeof value !== 'string' || !AGY_ID.test(value)) throw new Error('Invalid Antigravity conversation identity');
  return value;
}
function records(value: unknown, label: string): AgyRecord[] {
  if (!Array.isArray(value) || value.length > AGY_STEP_LIMIT) throw new Error(`Invalid Antigravity ${label}`);
  for (const item of value) if (!agyRecord(item)) throw new Error(`Invalid Antigravity ${label}`);
  return value;
}
function matchesCount(value: unknown, length: number): boolean {
  return (
    value === undefined ||
    ((typeof value === 'number' || (typeof value === 'string' && /^\d{1,6}$/.test(value))) && Number(value) === length)
  );
}
export function agySnapshot(value: unknown, conversationId: string): AgySnapshot {
  agyConversationId(conversationId);
  if (!agyRecord(value) || !agyRecord(value.trajectory)) throw new Error('Antigravity snapshot is unavailable');
  const trajectory = value.trajectory;
  if (trajectory.cascadeId !== conversationId || typeof trajectory.trajectoryId !== 'string' || !AGY_ID.test(trajectory.trajectoryId))
    throw new Error('Antigravity snapshot belongs to another conversation');
  const steps = records(trajectory.steps ?? [], 'steps');
  const executors = records(trajectory.executorMetadatas ?? [], 'executor metadata');
  if (!matchesCount(value.numTotalSteps, steps.length)) throw new Error('Antigravity snapshot is incomplete');
  if (!matchesCount(value.numTotalExecutorMetadata, executors.length)) throw new Error('Antigravity executor snapshot is incomplete');
  return {
    conversationId,
    trajectoryId: trajectory.trajectoryId,
    steps,
    executors,
    ...(agyRecord(trajectory.metadata) ? { metadata: trajectory.metadata } : {}),
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    ...(typeof value.fullyIdle === 'boolean' ? { fullyIdle: value.fullyIdle } : {}),
  };
}
function patchArray(previous: AgyRecord[], raw: unknown, field: string, requireComplete: boolean): AgyRecord[] {
  if (!agyRecord(raw)) throw new Error('Invalid Antigravity indexed update');
  const indices = raw.indices ?? [];
  const values = records(raw[field] ?? [], field);
  const length = raw.totalLength ?? 0;
  if (!Number.isSafeInteger(length) || length < 0 || length > AGY_STEP_LIMIT || !Array.isArray(indices) || indices.length !== values.length)
    throw new Error('Invalid Antigravity update length');
  const next = previous.slice(0, length);
  next.length = length;
  const seen = new Set<number>();
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || seen.has(index))
      throw new Error('Invalid Antigravity update index');
    seen.add(index);
    next[index] = values[i]!;
  }
  // Array#some skips holes. A gap means the reconnect has not supplied its baseline yet.
  for (let i = 0; i < length; i++)
    if (!agyRecord(next[i])) {
      if (requireComplete) throw new Error('Antigravity update has no complete baseline');
      throw new Error('Antigravity update is incomplete');
    }
  return next;
}
/**
 * proto3 JSON drops zero lengths and empty lists, so `{}` is either "unchanged" or "emptied". agy sends empty
 * `…Update` objects for fields it did not change, so on a known trajectory `{}` is read as unchanged. The rewinds
 * observed so far arrive as a new trajectory, with a full baseline.
 */
function touches(raw: unknown, baseline: boolean): boolean {
  if (raw === undefined) return false;
  return baseline || !agyRecord(raw) || Object.keys(raw).length > 0;
}
/**
 * Applies indexed patches without renumbering retained source identities. A trajectory switch requires a full
 * baseline; without one this throws rather than discard the snapshot, and the stream is reopened from a fresh read.
 */
export function applyAgyUpdate(snapshot: AgySnapshot | undefined, value: AgyRecord): AgySnapshot {
  const update = agyRecord(value.update) ? value.update : value;
  const conversationId = agyConversationId(update.conversationId);
  const trajectoryId = agyConversationId(update.trajectoryId);
  if (snapshot && snapshot.conversationId !== conversationId) throw new Error('Antigravity stream changed conversation');
  const changed = !snapshot || snapshot.trajectoryId !== trajectoryId;
  const main = update.mainTrajectoryUpdate;
  if (changed && (!agyRecord(main) || !agyRecord(main.stepsUpdate))) throw new Error('Antigravity trajectory switch has no baseline');
  const next: AgySnapshot = changed
    ? { conversationId, trajectoryId, steps: [], executors: [] }
    : { ...snapshot!, steps: snapshot!.steps, executors: snapshot!.executors };
  if (agyRecord(main)) {
    if (touches(main.stepsUpdate, changed)) next.steps = patchArray(next.steps, main.stepsUpdate, 'steps', changed);
    if (touches(main.executorMetadatasUpdate, changed))
      next.executors = patchArray(next.executors, main.executorMetadatasUpdate, 'executorMetadatas', changed);
    if (agyRecord(main.metadata)) next.metadata = main.metadata;
  }
  if (typeof update.status === 'string') next.status = update.status;
  // Protobuf JSON omits false. Never retain an earlier idle=true when native activity resumes.
  next.fullyIdle = update.fullyIdle === true;
  return next;
}
