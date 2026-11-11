/**
 * Remove ANSI/VT control sequences and OSC/DCS strings from terminal output while
 * keeping printable text (and newlines/tabs). We never interpret the resulting text
 * as state; it is only scanned for id-like tokens.
 */
export function stripTerminalSequences(input: string): string {
  return input
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '') // OSC ... BEL / ST
    .replace(/\u001b[P^_][\s\S]*?\u001b\\/g, '') // DCS / PM / APC ... ST
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\u001b[ -/]*[0-~]/g, '') // other escapes, including charset designators like ESC ( B
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') // control chars, keep \t \n \r
    .replace(/\r/g, '\n');
}
