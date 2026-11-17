import { fileURLToPath } from 'node:url';
import type { DiagnosticsContext, TaskDiagnostic } from '@riffet/plugin-api';

// What a Gradle build prints about its failures, read from the end of the log. Each format is one
// tool's own: the Kotlin compiler (`e:` / `w:`), javac, AAPT2 and Gradle's summary of what went wrong.

const MAX_DIAGNOSTICS = 200;
const MAX_SUMMARY_LINES = 12;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** `e: file:///abs/Foo.kt:12:5 message` (Kotlin 1.9 and later). */
const KOTLIN_URL = /^([ew]): (file:\/\/\S+?):(\d+):(\d+)\s+(.*)$/;
/** `e: /abs/Foo.kt: (12, 5): message` (older Kotlin). */
const KOTLIN_PAREN = /^([ew]): (\/.+?): \((\d+), (\d+)\): (.*)$/;
/** `e: message`, with no location. */
const KOTLIN_BARE = /^([ew]): (\S.*)$/;
/** `/abs/Foo.java:12: error: message`; javac prints the column only as a caret line below. */
const JAVAC = /^(\S.*?\.java):(\d+): (error|warning): (.*)$/;
/** `ERROR: /abs/res/layout/a.xml:14: AAPT: error: message`, or a bare `ERROR: message`. */
const AAPT = /^ERROR: (?:(\/.+?):(\d+): )?(?:AAPT2?: (?:error: )?)?(.+)$/;

function located(context: DiagnosticsContext, path: string): string | undefined {
  try {
    const absolute = path.startsWith('file://') ? fileURLToPath(path) : path;
    return context.relativize(absolute);
  } catch { return undefined; }
}

/**
 * The errors and warnings in a Gradle log. A path is given relative to the project; one outside it
 * (a generated source, another build) keeps its message and loses its location.
 */
export function parseGradleLog(log: string, context: DiagnosticsContext): TaskDiagnostic[] {
  const found = new Map<string, TaskDiagnostic>();
  const lines = log.replace(ANSI, '').split(/\r?\n/);
  const add = (severity: TaskDiagnostic['severity'], message: string, path?: string, line?: string, column?: string): void => {
    if (found.size >= MAX_DIAGNOSTICS) return;
    const text = message.trim();
    if (!text) return;
    const file = path === undefined ? undefined : located(context, path);
    const diagnostic: TaskDiagnostic = { severity, message: text, ...(file ? { file, ...(line ? { line: Number(line) } : {}), ...(column ? { column: Number(column) } : {}) } : {}) };
    found.set(`${severity}|${diagnostic.file ?? ''}|${diagnostic.line ?? ''}|${diagnostic.column ?? ''}|${text}`, diagnostic);
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    let match: RegExpMatchArray | null;
    if ((match = KOTLIN_URL.exec(line)) ?? (match = KOTLIN_PAREN.exec(line))) add(match[1] === 'e' ? 'error' : 'warning', match[5]!, match[2], match[3], match[4]);
    else if ((match = KOTLIN_BARE.exec(line))) add(match[1] === 'e' ? 'error' : 'warning', match[2]!);
    else if ((match = JAVAC.exec(line))) add(match[3] === 'error' ? 'error' : 'warning', match[4]!, match[1], match[2]);
    else if ((match = AAPT.exec(line))) add('error', match[3]!, match[1], match[2]);
    else if (line === '* What went wrong:') {
      const block: string[] = [];
      for (index++; index < lines.length && block.length < MAX_SUMMARY_LINES; index++) {
        const next = lines[index]!;
        if (next.startsWith('* ') || next.startsWith('BUILD ')) { index--; break; }
        block.push(next.trimEnd());
      }
      add('error', block.join('\n'));
    }
  }
  return [...found.values()];
}

// What the device side prints: crashes in logcat's `threadtime` format, adb's own errors, failed
// unit tests and lint findings. The scripts in `scripts.ts` add where the stack frames are in the
// project (`riffet-android frame …`), since the log names only a class and a file name.

/** `11-10 12:00:00.123  1234  1250 E AndroidRuntime: message`. */
const LOGCAT_LINE = /^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\d+)\s+\d+\s+[VDIWEFA]\s+(.+?)\s*: ?(.*)$/;
const FRAME = /[A-Za-z_][A-Za-z0-9_$.]*\([A-Za-z0-9_]+\.(?:kt|java):\d+\)|at [A-Za-z0-9_]+\.(?:kt|java):\d+$/;
const RESOLVED = /^riffet-android frame (.+)\t(.+):(\d+)$/;
const PACKAGE = /^riffet-android package (\S*)$/;
const ADB_ERROR = /^(?:adb: )?(?:error: )(.+)$|^(adb: .+)$|\b(INSTALL_(?:FAILED|PARSE_FAILED)_[A-Z_]+.*)$/;
/** `/abs/Foo.kt:12: Error: message [Id]`, lint's text output. */
const LINT = /^(\S.*?\.(?:kt|java|xml|kts|gradle|toml)):(\d+): (Error|Warning): (.+)$/;
/** `com.example.FooTest > adds FAILED`. */
const TEST_FAILED = /^(\S+) > (.+) FAILED$/;

interface Crash { pid: string; process?: string; lines: string[] }

export function parseAndroidLog(log: string, context: DiagnosticsContext): TaskDiagnostic[] {
  const lines = log.replace(ANSI, '').split(/\r?\n/);
  const where = new Map<string, { file: string; line: number }>();
  let pkg: string | undefined;
  for (const line of lines) {
    let match: RegExpExecArray | null;
    if ((match = RESOLVED.exec(line))) {
      const file = located(context, match[2]!);
      if (file) where.set(match[1]!, { file, line: Number(match[3]) });
    } else if ((match = PACKAGE.exec(line))) pkg = match[1] || undefined;
  }
  const at = (text: string) => { const frame = FRAME.exec(text)?.[0]; return frame ? where.get(frame) : undefined; };

  const found: TaskDiagnostic[] = [];
  const add = (diagnostic: TaskDiagnostic) => { if (found.length < MAX_DIAGNOSTICS) found.push(diagnostic); };
  const crashes: Crash[] = [];
  let open: Crash | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    let match: RegExpExecArray | null;
    if ((match = LOGCAT_LINE.exec(line))) {
      const [, pid, tag, message] = match as unknown as [string, string, string, string];
      if (tag === 'AndroidRuntime' && message.startsWith('FATAL EXCEPTION')) crashes.push(open = { pid, lines: [] });
      else if (open && tag === 'AndroidRuntime' && pid === open.pid) {
        const process = /^Process: ([^,\s]+)/.exec(message);
        if (process) open.process = process[1];
        else if (message.trim()) open.lines.push(message.trim());
      } else if (open && pid === open.pid) open = undefined;
    } else if ((match = TEST_FAILED.exec(line))) {
      const detail = lines[index + 1]?.startsWith(' ') ? lines[index + 1]!.trim() : '';
      const place = at(detail);
      const name = `${match[1]!.split('.').pop()} > ${match[2]}`;
      add({ severity: 'error', message: detail ? `${name}\n${detail.replace(/ at [A-Za-z0-9_]+\.(?:kt|java):\d+$/, '')}` : name, ...(place ?? {}) });
    } else if ((match = LINT.exec(line))) {
      const file = located(context, match[1]!);
      add({ severity: match[3] === 'Error' ? 'error' : 'warning', message: match[4]!, ...(file ? { file, line: Number(match[2]) } : {}) });
    } else if (!RESOLVED.test(line) && (match = ADB_ERROR.exec(line.trim()))) {
      add({ severity: 'error', message: (match[1] ?? match[2] ?? match[3])! });
    }
  }

  // The newest crash of the app first; its frames that are in the project follow it, so the stack
  // can be walked from the panel.
  const ours = crashes.filter(crash => !pkg || !crash.process || crash.process === pkg || crash.process.startsWith(`${pkg}:`)).reverse();
  ours.forEach((crash, order) => {
    const causes = crash.lines.map((text, index) => ({ text, index })).filter(({ text }) => !text.startsWith('at ') && !/^\.\.\. \d+ more/.test(text));
    const root = causes.filter(({ text }) => text.startsWith('Caused by: ')).pop() ?? causes[0];
    const frames = crash.lines.flatMap(text => { const place = text.startsWith('at ') ? at(text) : undefined; return place ? [{ text, place }] : []; });
    const rootFrame = root ? crash.lines.slice(root.index).map(text => (text.startsWith('at ') ? at(text) : undefined)).find(Boolean) : undefined;
    const message = [causes[0]?.text, root && root !== causes[0] ? root.text : undefined].filter(Boolean).join('\n') || 'FATAL EXCEPTION';
    add({ severity: 'error', message, ...(rootFrame ?? frames[0]?.place ?? {}) });
    if (order === 0) for (const frame of frames) add({ severity: 'warning', message: frame.text, ...frame.place });
  });

  // Lint and Gradle print a finding again in their summaries: one entry each.
  const seen = new Set<string>();
  return [...parseGradleLog(log, context), ...found].filter(item => {
    const key = `${item.severity}|${item.file ?? ''}|${item.line ?? ''}|${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_DIAGNOSTICS);
}
