/*
 * Ties each registered schema to the interface callers use. The interfaces in `../index.ts` are what the
 * server and the web client are typed against; the schemas here are what the released snapshots, the
 * compatibility check and the Kotlin and Swift fixtures are generated from. Nothing else connects the
 * two, so a field added to one and not the other would leave every check green while the fixtures
 * stopped describing what is sent.
 *
 * Types only: a difference fails `pnpm typecheck`, and the error names the contract and the path, as
 * `Session.goal (interface only)` or `Run.state: paused (not in the schema)`.
 */
import type * as contracts from '../index.js';
import type { PluginAgentId } from '../agent-ids.js';
import type * as devices from './devices.js';
import type { ContractName } from './index.js';
import type * as run from './run.js';
import type * as session from './session.js';
import type * as share from './share.js';
import type * as sync from './sync.js';

type Out<S> = S extends { _zod: { output: infer O } } ? O : never;
type In<S> = S extends { _zod: { input: infer I } } ? I : never;
type Prim = string | number | boolean | bigint | symbol | null | undefined;
type Objs<T> = T extends Prim ? never : T extends readonly unknown[] ? never : T;
type Items<T> = T extends readonly (infer E)[] ? E : never;
/** A union's members are read together: a field counts as present when any member has it. */
type Keys<T> = T extends unknown ? keyof T : never;
type Prop<T, K extends PropertyKey> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;
type Depth = [0, 0, 0, 0, 0, 0, 0, 0];

/** Paths of the fields `A` has and `B` lacks. */
type Missing<A, B, P extends string, Side extends string, D extends unknown[] = []> = D['length'] extends Depth['length'] ? never :
  | ([Items<A>] extends [never] ? never : Missing<Items<A>, Items<B>, `${P}[]`, Side, [...D, 0]>)
  | ([Objs<A>] extends [never] ? never : { [K in Keys<Objs<A>> & string]: K extends Keys<Objs<B>> ? Missing<Prop<Objs<A>, K>, Prop<Objs<B>, K>, `${P}.${K}`, Side, [...D, 0]> : `${P}.${K} (${Side} only)` }[Keys<Objs<A>> & string]);

/**
 * Paths where the interface allows a value the schema would reject. An id of a plugin's Agent
 * (`vendor.name`) is left out: the schemas describe what a client that has not negotiated
 * `plugin-agents` receives, and that client is given a built-in id in its place.
 */
type Wider<I, S, P extends string, D extends unknown[] = []> = D['length'] extends Depth['length'] ? never :
  | ([Exclude<Extract<I, Prim>, PluginAgentId>] extends [Extract<S, Prim> | undefined] ? never
    : `${P}: ${Extract<Exclude<Exclude<Extract<I, Prim>, PluginAgentId>, Extract<S, Prim> | undefined>, string | number | boolean> | (string extends Extract<I, Prim> ? 'any string' : never)} (not in the schema)`)
  | ([Items<I>] extends [never] ? never : Wider<Items<I>, Items<S>, `${P}[]`, [...D, 0]>)
  | ([Objs<I>] extends [never] ? never : { [K in Keys<Objs<I>> & Keys<Objs<S>> & string]: Wider<Prop<Objs<I>, K>, Prop<Objs<S>, K>, `${P}.${K}`, [...D, 0]> }[Keys<Objs<I>> & Keys<Objs<S>> & string]);

type Drift<Name extends string, Interface, Schema> =
  | Missing<Interface, Out<Schema>, Name, 'interface'>
  | Missing<Out<Schema>, Interface, Name, 'schema'>
  | Wider<Interface, In<Schema>, Name>;

/** One line per contract in `CONTRACTS`. */
interface Checked {
  ShareDraftRequest: Drift<'ShareDraftRequest', contracts.ShareDraftRequest, typeof share.ShareDraftRequestSchema>;
  ShareCapability: Drift<'ShareCapability', contracts.ShareCapability, typeof share.ShareCapabilitySchema>;
  SessionShare: Drift<'SessionShare', contracts.SessionShare, typeof share.SessionShareSchema>;
  ShareStatus: Drift<'ShareStatus', contracts.ShareStatus, typeof share.ShareStatusSchema>;
  ShareDraft: Drift<'ShareDraft', contracts.ShareDraft, typeof share.ShareDraftSchema>;
  ShareTurnCatalog: Drift<'ShareTurnCatalog', contracts.ShareTurnCatalog, typeof share.ShareTurnCatalogSchema>;
  ShareDraftEvent: Drift<'ShareDraftEvent', contracts.ShareDraftEvent, typeof share.ShareDraftEventSchema>;
  Session: Drift<'Session', contracts.Session, typeof session.SessionSchema>;
  SessionState: Drift<'SessionState', contracts.SessionState, typeof session.SessionStateSchema>;
  Run: Drift<'Run', contracts.Run, typeof run.RunSchema>;
  RunState: Drift<'RunState', contracts.Run['state'], typeof run.RunStateSchema>;
  NativeRunRecovery: Drift<'NativeRunRecovery', contracts.NativeRunRecovery, typeof run.NativeRunRecoverySchema>;
  NativeStopRequest: Drift<'NativeStopRequest', contracts.NativeStopRequest, typeof run.NativeStopRequestSchema>;
  NativeRuntimeActionRequest: Drift<'NativeRuntimeActionRequest', contracts.NativeRuntimeActionRequest, typeof sync.NativeRuntimeActionRequestSchema>;
  SyncFrame: Drift<'SyncFrame', contracts.SyncFrame, typeof sync.SyncFrameSchema>;
  TimelineRow: Drift<'TimelineRow', contracts.TimelineRow, typeof sync.TimelineRowSchema>;
  TimelinePage: Drift<'TimelinePage', contracts.TimelinePage, typeof sync.TimelinePageSchema>;
  TimelineChanges: Drift<'TimelineChanges', contracts.TimelineChanges, typeof sync.TimelineChangesSchema>;
  LaneFind: Drift<'LaneFind', contracts.LaneFind, typeof sync.LaneFindSchema>;
  DeviceReport: Drift<'DeviceReport', contracts.DeviceReport, typeof devices.DeviceReportSchema>;
  DeviceCallOutcome: Drift<'DeviceCallOutcome', contracts.DeviceCallOutcome, typeof devices.DeviceCallOutcomeSchema>;
  DeviceInfo: Drift<'DeviceInfo', contracts.DeviceInfo, typeof devices.DeviceInfoSchema>;
  DeviceCall: Drift<'DeviceCall', contracts.DeviceCall, typeof devices.DeviceCallSchema>;
  DeviceCallReceipt: Drift<'DeviceCallReceipt', contracts.DeviceCallReceipt, typeof devices.DeviceCallReceiptSchema>;
  DeviceFile: Drift<'DeviceFile', contracts.DeviceFile, typeof devices.DeviceFileSchema>;
  DeviceLease: Drift<'DeviceLease', contracts.DeviceLease, typeof devices.DeviceLeaseSchema>;
  RiffetDeviceAction: Drift<'RiffetDeviceAction', contracts.RiffetDeviceAction, typeof devices.RiffetDeviceActionSchema>;
  DeviceAdbStatus: Drift<'DeviceAdbStatus', contracts.DeviceAdbStatus, typeof devices.DeviceAdbStatusSchema>;
  DeviceAdbGrant: Drift<'DeviceAdbGrant', contracts.DeviceAdbGrant, typeof devices.DeviceAdbGrantSchema>;
}

type Nothing<T extends never> = T;
/** Every difference between an interface and its schema, as one error. */
export type ContractDrift = Nothing<Checked[keyof Checked]>;
/** A contract added to `CONTRACTS` gets its line in `Checked`. */
export type UncheckedContract = Nothing<Exclude<ContractName, keyof Checked>>;
