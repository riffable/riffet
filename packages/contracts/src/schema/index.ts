/*
 * The contract registry. Every schema named here gets a JSON Schema
 * snapshot in `packages/contracts/schema/released/<version>.json` and generated `max`, `min` and
 * `future` fixtures (`scripts/gen-contracts.ts`).
 *
 * `direction` describes who may add fields without breaking the other side. `openEnums` is true
 * only where the receiving client keeps an unknown value instead of dropping the payload. Newer
 * contracts mark the individual lenient enums instead with `z.enum([...]).meta({ open: true })`;
 * the compatibility check treats both forms as additive for added values.
 */
import type { z } from 'zod/v4';
import * as run from './run.js';
import * as session from './session.js';
import * as sync from './sync.js';
import * as share from './share.js';
import * as devices from './devices.js';

export interface ContractDefinition {
  schema: z.ZodType;
  direction: 'request' | 'response';
  openEnums?: boolean;
  /**
   * How many levels of nested branches/enums get their own fixture. Frame contracts are unions of
   * large branches; enumerating every enum inside every branch multiplies their payload count
   * without adding contract coverage, so they only enumerate the branches and top-level enums.
   */
  choices?: 'deep' | 'shallow';
}

const response = (schema: z.ZodType): ContractDefinition => ({ schema, direction: 'response', openEnums: true });
const request = (schema: z.ZodType): ContractDefinition => ({ schema, direction: 'request' });
/**
 * A response contract whose open enums are declared on the enum node itself
 * (`z.enum([...]).meta({ open: true })`), not on the whole contract.
 */
const frame = (schema: z.ZodType): ContractDefinition => ({ schema, direction: 'response', choices: 'shallow' });
/** A response contract whose open enums are marked on the enum nodes, enumerated in full. */
const marked = (schema: z.ZodType): ContractDefinition => ({ schema, direction: 'response' });

export const CONTRACTS = {
  ShareDraftRequest: request(share.ShareDraftRequestSchema),
  ShareCapability: response(share.ShareCapabilitySchema),
  SessionShare: response(share.SessionShareSchema),
  ShareStatus: response(share.ShareStatusSchema),
  ShareDraft: response(share.ShareDraftSchema),
  ShareTurnCatalog: response(share.ShareTurnCatalogSchema),
  ShareDraftEvent: response(share.ShareDraftEventSchema),

  Session: frame(session.SessionSchema),
  SessionState: frame(session.SessionStateSchema),
  Run: frame(run.RunSchema),
  RunState: frame(run.RunStateSchema),
  NativeRunRecovery: frame(run.NativeRunRecoverySchema),
  NativeStopRequest: request(run.NativeStopRequestSchema),
  NativeRuntimeActionRequest: request(sync.NativeRuntimeActionRequestSchema),
  SyncFrame: frame(sync.SyncFrameSchema),
  TimelineRow: frame(sync.TimelineRowSchema),
  TimelinePage: frame(sync.TimelinePageSchema),
  TimelineChanges: frame(sync.TimelineChangesSchema),

  DeviceReport: request(devices.DeviceReportSchema),
  DeviceCallOutcome: request(devices.DeviceCallOutcomeSchema),
  DeviceInfo: marked(devices.DeviceInfoSchema),
  DeviceCall: marked(devices.DeviceCallSchema),
  DeviceCallReceipt: marked(devices.DeviceCallReceiptSchema),
  DeviceFile: marked(devices.DeviceFileSchema),
  DeviceLease: marked(devices.DeviceLeaseSchema),
  RiffetDeviceAction: marked(devices.RiffetDeviceActionSchema),
  DeviceAdbStatus: marked(devices.DeviceAdbStatusSchema),
  DeviceAdbGrant: marked(devices.DeviceAdbGrantSchema),
} satisfies Record<string, ContractDefinition>;

export type ContractName = keyof typeof CONTRACTS;
