/**
 * What one argument of an Agent CLI's launch may be. The whole `tmux new-session` command, the
 * session environment included, travels to the tmux server as one message that tmux caps at 16 KiB,
 * so an argument is measured in UTF-8 bytes and leaves room for the rest. Line breaks are fine: tmux
 * hands a multi-argument command to the process as argv, without a shell.
 */
export const LAUNCH_ARG_MAX_BYTES = 8 * 1024;

export function launchArgAccepted(arg: unknown): arg is string {
  return typeof arg === 'string' && !arg.includes('\0') && Buffer.byteLength(arg, 'utf8') <= LAUNCH_ARG_MAX_BYTES;
}

/** tmux ends a command at an argument ending in `;`; `\;` keeps the semicolon as text. */
export function tmuxArgument(arg: string): string {
  return arg.endsWith(';') ? `${arg.slice(0, -1)}\\;` : arg;
}
