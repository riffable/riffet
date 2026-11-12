import type { NativeInteraction, NativeStatus } from '../../../../../packages/contracts/src/index.js';
import type { RpcThread } from './types.js';

/**
 * What a thread status change publishes, or undefined when it publishes nothing. `phase` is the
 * one derived from the runtime's own turn and interaction state; `foregroundEnded` says a confirmed
 * foreground end wins over an aggregate-active thread.
 */
export function threadStatusUpdate(
  status: RpcThread['status'], current: NativeStatus, noticeFromThread: boolean,
  interaction: NativeInteraction | undefined, phase: NativeStatus['phase'], foregroundEnded: boolean, online: boolean,
): NativeStatus | undefined {
  const base = {
    ...(current.model ? { model: current.model } : {}),
    ...(!noticeFromThread && current.notice ? { notice: current.notice, noticeLevel: current.noticeLevel } : {}),
  };
  if (status?.type === 'active') return { ...base, phase: interaction ? 'attention' : foregroundEnded ? 'idle' : 'busy', ...(interaction ? { interaction } : {}) };
  else if (status?.type === 'systemError') return { ...(current.model ? { model: current.model } : {}), phase: online ? phase : 'offline', ...(interaction ? { interaction } : {}) };
  else if (status?.type === 'idle') return { ...base, phase, ...(interaction ? { interaction } : {}) };
  return undefined;
}
