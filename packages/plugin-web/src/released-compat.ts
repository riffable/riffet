// The isolated-view bridge protocol (`bridge.ts`) against its released baseline, inside the ordinary `tsc --noEmit`.
// See `packages/plugin-api/src/released-compat.ts` for the policy and `scripts/gen-plugin-api-released.ts` for the baseline.
// Only the bridge is promised. The in-app React surface of this package (`UiKit`, `PluginHost`, hooks) is experimental and
// for built-in entries, so it is not compared.
//
// A view bundles a released client, so the host must keep accepting its calls and answering what it expects:
// - `BridgeMethods`: per method, released params are assignable to current params and the current result to the released result;
//   no released method may disappear.
// - `BridgeEvents`: each current payload is assignable to the released one; no released event may disappear.
// - `BRIDGE_VERSION` is a literal type here, so a change fails below.

import type * as Current from './bridge.js';
import type * as Released from '../released/1.0.0/bridge.js';

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;

type MethodsKept = {
  [K in keyof Released.BridgeMethods]: K extends keyof Current.BridgeMethods
    ? [Extends<Released.BridgeMethods[K]['params'], Current.BridgeMethods[K]['params']>, Extends<Current.BridgeMethods[K]['result'], Released.BridgeMethods[K]['result']>] extends [true, true]
      ? true
      : false
    : false;
};
type EventsKept = {
  [K in keyof Released.BridgeEvents]: K extends keyof Current.BridgeEvents ? Extends<Current.BridgeEvents[K], Released.BridgeEvents[K]> : false;
};
type AllTrue<T extends Record<string, boolean>> = Extends<T[keyof T], true>;

export type BridgeCompat = [
  Assert<AllTrue<MethodsKept>>,
  Assert<AllTrue<EventsKept>>,
  Assert<Extends<typeof Current.BRIDGE_VERSION, typeof Released.BRIDGE_VERSION>>,
];
