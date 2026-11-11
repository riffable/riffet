/**
 * macOS `ps` exposes argv as a display string. Parse shell-style quoting without evaluating any
 * expansions so arguments containing spaces can still be compared to the expected project path.
 */
export function parsePsCommandLine(commandLine: string): string[] | undefined {
  const argv: string[] = [];
  let token = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;

  for (const char of commandLine.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        argv.push(token);
        token = '';
        started = false;
      }
    } else {
      token += char;
      started = true;
    }
  }
  if (escaped || quote) return undefined;
  if (started) argv.push(token);
  return argv.length ? argv : undefined;
}
