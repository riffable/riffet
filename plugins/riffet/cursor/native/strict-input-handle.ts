import { AppError } from '@riffet/plugin-api/kit';
import { type AgentTerminalControl } from '@riffet/plugin-api/experimental/agent';

/**
 * Wraps a `AgentTerminalControl` so that submission-boundary primitives (`keys`, `paste`)
 * surface backend rejections as thrown errors rather than silent falsy returns.
 *
 * The current backend (tmux via `execFile`) already throws `TMUX_COMMAND_FAILED` on non-zero
 * exit, so this wrapper is a near-identity for Phase 1 — its purpose is to establish the
 * invariant: *every submit-time write either succeeds or throws*. When Phase 2 introduces the
 * declarative adapter layer (`apps/server/src/adapters/cli/`), raw PTY backends that may silently
 * drop writes get wrapped here instead of in the adapter.
 *
 * Scope is deliberately narrow: only `keys` and `paste`. Navigation keystrokes used during
 * startup detection or picker interaction are intentionally best-effort and should not throw on
 * transient failures — those still go through the raw control.
 *
 * See plans/replicated-gathering-hammock.md (Phase 1) and
 * github.com/deepcoldy/botmux/blob/master/src/adapters/cli/strict-input-handle.ts.
 */
const wrappers = new WeakMap<AgentTerminalControl, AgentTerminalControl>();

export function strictInputHandle(control: AgentTerminalControl): AgentTerminalControl {
  const cached = wrappers.get(control);
  if (cached) return cached;
  const guard = async <T>(method: 'keys' | 'paste', task: () => Promise<T>): Promise<T> => {
    const result = await task();
    // The current tmux-backed control resolves `void`; `false` would indicate a backend that
    // chose to swallow a submission failure. Convert to an exception so callers never silently
    // promote a dropped write to success.
    if ((result as unknown) === false) throw new AppError('CLI_INPUT_REJECTED', `The CLI rejected the ${method} write`, 503, undefined, { method });
    return result;
  };
  const wrapped: AgentTerminalControl = {
    screen: control.screen.bind(control),
    keys: keys => guard('keys', () => control.keys(keys)),
    paste: (text, submit) => guard('paste', () => control.paste(text, submit)),
  };
  wrappers.set(control, wrapped);
  return wrapped;
}
