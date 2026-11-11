import type { TerminalInfo } from '../../../../packages/contracts/src/index.js';

/**
 * Whether a terminal is the CLI of an Agent's conversation, as opposed to a shell or a login. Every
 * backend's CLI runs as `native`; `cursor` is the tag Cursor's terminals carried before there were
 * backends and still carry on the wire and in stored rows. Nothing else reads either value.
 */
export function isAgentTerminal(terminal: Pick<TerminalInfo, 'kind'>): boolean {
  return terminal.kind === 'native' || terminal.kind === 'cursor';
}
