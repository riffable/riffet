import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';
import { redact } from './terminal-fixture-guards.js';

/**
 * Records terminal streams for the mobile VT engine's parity tests, with tmux as the oracle.
 *
 * Each scenario runs a program in a private tmux server and attaches a tmux client through a PTY,
 * exactly as `apps/server/src/terminal/service.ts` does (TERM=xterm-256color, COLORTERM=truecolor,
 * status off). What that client writes is the byte stream the phone receives over
 * `/api/terminals/:id/ws`. When the program has gone quiet, `capture-pane` reads what tmux itself
 * believes is on the screen; the Kotlin test feeds the recorded stream to the engine and must end
 * on the same screen. tmux is the renderer the stream was produced for, so it is a better judge
 * than hand-written expectations.
 *
 * Output: apps/mobile/terminal/fixtures/tmux/<scenario>/{stream.bin,chunks.json,expected.json}.
 * `chunks.json` keeps the PTY read boundaries and their timing so the stream can also be replayed
 * at its real pace for rendering measurements.
 *
 * Usage: node_modules/.bin/tsx scripts/record-terminal-fixtures.ts [--profile <name>] [scenario…]   (none: all)
 *
 * The `*-turn-*` scenarios run one real agent turn in a throwaway directory, through the Claude
 * profile named by `--profile <name>` (or `RIFFET_FIXTURE_PROFILE`) in Riffet's own settings
 * (`native-backend-profiles.json`), launched the way the server launches a profile
 * (`backends/claude` / `backends/codex`). They are skipped without that profile.
 * The key only ever sits in the temporary directory.
 *
 * Fixtures are checked in, so every recorded string is passed through `redact` before it is
 * written: agent names, documentation URLs, model ids and machine paths become synthetic
 * placeholders. Each placeholder has exactly the same UTF-8 byte length and display width as the
 * text it replaces, which keeps the PTY chunk offsets, the tmux capture and every column aligned.
 * `assertRedacted` fails the recording if a known third-party marker survives, so a newly named
 * product or a new URL has to be added to `redactions` with a same-size placeholder before the
 * fixture can be committed.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = resolve(root, 'apps/mobile/terminal/fixtures/tmux');

type Step =
  | { literal: string }
  | { keys: string[] }
  | { wait: number }
  /** Pasted, then Enter after a pause: an agent CLI swallows an Enter that lands inside the paste. */
  | { prompt: string };

interface Scenario {
  name: string;
  cols: number;
  rows: number;
  command: string[];
  /** Milliseconds to wait for the program's first screen. */
  startup: number;
  steps: Step[];
  /** No output for this long means the screen has settled. */
  quietMs?: number;
  /** Longest wait for that quiet; a model turn needs much longer than a shell command. */
  settleMs?: number;
  /** Extra environment and files for the program, written into its temporary directory. */
  prepare?: (workDir: string) => Record<string, string>;
}

const shell = ['bash', '--norc', '--noprofile', '-i'];
const type = (line: string): Step[] => [{ literal: line }, { keys: ['Enter'] }, { wait: 300 }];

const sampleSource = Array.from({ length: 120 }, (_, i) => i % 10 === 0
  ? `// section ${i / 10}: 中文注释与 emoji 🙂`
  : `export function step${i}(value: number): string { return \`\${value * ${i}}\`; }`).join('\n');

const args = process.argv.slice(2);
const profileArg = args.indexOf('--profile');
const profileName = profileArg >= 0 ? args[profileArg + 1] : process.env.RIFFET_FIXTURE_PROFILE;
const wanted = args.filter((arg, index) => index !== profileArg && index !== profileArg + 1);

/** The Claude profile named [profileName] in Riffet's settings, or undefined when it is not configured. */
function turnProfile(): { endpoint: string; apiKey: string } | undefined {
  const path = join(homedir(), '.local/share/riffet/native-backend-profiles.json');
  if (!existsSync(path)) return undefined;
  const profiles = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Array<{ name?: string; apiEndpoint?: string; apiKey?: string }>>;
  const profile = profiles.claude?.find((item) => item.name === profileName && item.apiEndpoint && item.apiKey);
  return profile ? { endpoint: profile.apiEndpoint!, apiKey: profile.apiKey! } : undefined;
}

const turnModel = 'deepseek-v4.1-flash';
const turnPrompt = '读取 sample.ts 的前 30 行，用中文总结它做了什么，列三个要点，再给一个不超过 8 行的 Kotlin 改写示例。不要修改任何文件。';

/** `backends/claude`: provider settings in a `--settings` file, auto-update off. */
function claudeTurn(cols: number, rows: number): Scenario {
  return {
    name: `claude-turn-${cols}x${rows}`, cols, rows,
    command: ['claude', '--settings', '__DIR__/claude-settings.json', '--model', turnModel],
    startup: 8000, quietMs: 3000, settleMs: 180_000,
    // A fresh directory opens on the folder-trust dialog; Down + Enter trusts it.
    steps: [{ keys: ['Down'] }, { wait: 500 }, { keys: ['Enter'] }, { wait: 6000 }, { prompt: turnPrompt }],
    prepare: (workDir) => {
      const profile = turnProfile()!;
      writeFileSync(join(workDir, 'claude-settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: profile.endpoint, ANTHROPIC_AUTH_TOKEN: profile.apiKey } }), { mode: 0o600 });
      return { DISABLE_AUTOUPDATER: '1' };
    },
  };
}

/** `backends/codex`: a `riffet` model provider on the Responses API, in its own CODEX_HOME. */
function codexTurn(cols: number, rows: number): Scenario {
  return {
    name: `codex-turn-${cols}x${rows}`, cols, rows,
    command: [
      'codex', '-m', turnModel,
      '-c', 'model_provider="riffet"',
      '-c', 'model_providers.riffet.name="Riffet"',
      '-c', `model_providers.riffet.base_url="${turnProfile()?.endpoint ?? ''}/v1"`,
      '-c', 'model_providers.riffet.env_key="RIFFET_CODEX_API_KEY"',
      '-c', 'model_providers.riffet.wire_api="responses"',
      '-c', 'model_providers.riffet.requires_openai_auth=false',
    ],
    startup: 8000, quietMs: 3000, settleMs: 180_000,
    steps: [{ prompt: turnPrompt }],
    prepare: (workDir) => {
      mkdirSync(join(workDir, 'codex-home'), { recursive: true });
      return { CODEX_HOME: join(workDir, 'codex-home'), RIFFET_CODEX_API_KEY: turnProfile()!.apiKey };
    },
  };
}

const scenarios: Scenario[] = [
  {
    name: 'shell-basics',
    cols: 80, rows: 24, command: shell, startup: 500,
    steps: [
      ...type("PS1='$ '; clear"),
      ...type('seq 1 60'),
      ...type(String.raw`printf '\e[31mred\e[0m \e[1;32mbold green\e[0m \e[2mdim\e[0m \e[3mitalic\e[0m \e[4munderline\e[0m \e[7minverse\e[0m \e[9mstrike\e[0m\n'`),
      ...type(String.raw`for i in 16 52 88 124 160 196 202 208 214 220 226; do printf "\e[48;5;$i""m  \e[0m"; done; echo`),
      ...type(String.raw`printf '\e[38;2;255;128;0mtruecolor fg\e[0m \e[48;2;21;21;21m dark panel bg \e[0m\n'`),
      ...type(String.raw`printf '中文宽字符测试｜全角ＡＢＣ｜e\xcc\x81 combining｜🙂👍🏽 emoji\n'`),
      ...type(String.raw`printf '╭──────────╮\n│ box  ✓ ● │\n╰──────────╯\n▁▂▃▄▅▆▇█ ░▒▓\n'`),
      ...type('ls --color=always -d /usr /usr/bin /etc /tmp /dev/null'),
    ],
  },
  {
    // In-place redraws by cursor addressing, the way an agent CLI repaints its status area.
    name: 'redraw',
    cols: 60, rows: 16, command: shell, startup: 500,
    steps: [
      ...type("PS1='$ '; clear"),
      ...type(String.raw`printf '\e[2J\e[H╭─ build ──────────────────────────╮\n│                                  │\n╰──────────────────────────────────╯\n'; for i in $(seq 0 4 100); do bar=''; for j in $(seq 1 $((i*30/100))); do bar="$bar█"; done; printf '\e[2;3H\e[38;5;39m%s\e[0m\e[2;38H%3d%%' "$bar" $i; sleep 0.02; done; printf '\e[5;1H\e[1;32m✓ done\e[0m\n'`),
      { wait: 1200 },
    ],
  },
  {
    name: 'vim',
    cols: 80, rows: 24,
    command: ['vim', '-u', 'NONE', '-N', '-c', 'syntax on', '-c', 'set number', '-c', 'set filetype=typescript', '__SAMPLE__'],
    startup: 800,
    steps: [{ keys: ['C-d'] }, { wait: 300 }, { keys: ['C-d'] }, { wait: 300 }, { literal: '/中文' }, { keys: ['Enter'] }, { wait: 400 }],
  },
  {
    name: 'less',
    cols: 80, rows: 24, command: ['less', '-R', '__SAMPLE__'], startup: 500,
    steps: [{ keys: ['Space'] }, { wait: 300 }, { keys: ['Space'] }, { wait: 300 }, { keys: ['k', 'k', 'k'] }, { wait: 300 }],
  },
  // Claude Code opens on its folder-trust dialog in a fresh directory (an Ink screen with a rounded
  // rule and a highlighted choice). Down only moves the highlight; nothing is confirmed, so the
  // user's Claude config is not touched. The Cursor CLI is not recorded here: outside Riffet's own
  // launch profile it is logged out and any key starts a login.
  { name: 'claude-trust-100x40', cols: 100, rows: 40, command: ['claude'], startup: 8000, steps: [{ keys: ['Down'] }, { wait: 800 }] },
  { name: 'claude-trust-45x30', cols: 45, rows: 30, command: ['claude'], startup: 8000, steps: [{ keys: ['Down'] }, { wait: 800 }] },
  claudeTurn(100, 40),
  claudeTurn(45, 30),
  codexTurn(100, 40),
  codexTurn(45, 30),
];

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The server's `tmuxProcessEnv`: an inherited CURSOR_API_KEY overrides the CLI's own login. */
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'CURSOR_API_KEY'),
);

async function record(scenario: Scenario, workDir: string): Promise<void> {
  const sock = join(workDir, 'tmux.sock');
  const programEnv = { ...env, ...scenario.prepare?.(workDir) };
  const tmux = (args: string[]) => execFileSync('tmux', ['-S', sock, ...args], { encoding: 'utf8', env: programEnv });
  const session = 'fx';
  const command = scenario.command.map((part) => part === '__SAMPLE__' ? join(workDir, 'sample.ts') : part.replace('__DIR__', workDir));
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', session, '-x', String(scenario.cols), '-y', String(scenario.rows), '-c', workDir, ...command]);
  tmux(['set-option', '-t', session, 'status', 'off']);
  // What the server gives the attached client (CLIENT_TERMINAL_FEATURES in terminal/service.ts).
  tmux(['set-option', '-s', 'terminal-features[90]', 'xterm*:RGB:strikethrough:usstyle:overline:sync']);

  const chunks: Array<{ t: number; data: string }> = [];
  const started = Date.now();
  let last = started;
  const client = pty.spawn('tmux', ['-S', sock, 'attach-session', '-t', session], {
    name: 'xterm-256color', cols: scenario.cols, rows: scenario.rows, cwd: workDir,
    env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  client.onData((data) => { last = Date.now(); chunks.push({ t: last - started, data }); });

  await sleep(scenario.startup);
  for (const step of scenario.steps) {
    if ('wait' in step) await sleep(step.wait);
    else if ('literal' in step) tmux(['send-keys', '-t', session, '-l', step.literal]);
    else if ('prompt' in step) {
      tmux(['send-keys', '-t', session, '-l', step.prompt]);
      await sleep(800);
      tmux(['send-keys', '-t', session, 'Enter']);
      // Give the turn time to start before "quiet" can mean "finished".
      await sleep(5000);
    } else tmux(['send-keys', '-t', session, ...step.keys]);
  }
  const quiet = scenario.quietMs ?? 1000;
  const deadline = Date.now() + (scenario.settleMs ?? 15_000);
  while (Date.now() - last < quiet && Date.now() < deadline) await sleep(100);

  const plain = redact(tmux(['capture-pane', '-p', '-t', session]));
  // -N keeps trailing cells, which matter when they carry a background colour.
  const ansi = redact(tmux(['capture-pane', '-p', '-e', '-N', '-t', session]));
  const [cursorX, cursorY, width, height, alternate] = tmux(['display-message', '-p', '-t', session, '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height} #{alternate_on}'])
    .trim().split(' ').map(Number);
  client.kill();
  try { tmux(['kill-server']); } catch { /* already gone */ }

  const out = join(outRoot, scenario.name);
  mkdirSync(out, { recursive: true });
  const lengths = chunks.map((chunk) => Buffer.byteLength(chunk.data, 'utf8'));
  const recorded = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, 'utf8')));
  // Redact the whole stream before slicing it back at the PTY's boundaries, so a token split
  // across two reads is still replaced. Same-size placeholders keep the boundaries valid.
  const stream = Buffer.from(redact(recorded.toString('utf8')), 'utf8');
  if (stream.length !== recorded.length) throw new Error('redaction changed the recorded stream length');
  let cursor = 0;
  const buffers = lengths.map((length) => {
    const slice = stream.subarray(cursor, cursor + length);
    cursor += length;
    return slice;
  });
  // Every byte of the stream must belong to exactly one chunk: the replay tests slice by these
  // boundaries, and an overlap or gap would desynchronize them from the recorded byte positions.
  if (cursor !== stream.length) throw new Error(`chunks cover ${cursor} of ${stream.length} bytes`);
  let covered = 0;
  for (const [index, buffer] of buffers.entries()) {
    if (buffer.length !== lengths[index]) throw new Error(`chunk ${index} is ${buffer.length} bytes, expected ${lengths[index]}`);
    covered += buffer.length;
  }
  if (covered !== stream.length) throw new Error(`chunks cover ${covered} bytes of a ${stream.length}-byte stream`);
  writeFileSync(join(out, 'stream.bin'), stream);
  let offset = 0;
  writeFileSync(join(out, 'chunks.json'), `${JSON.stringify(chunks.map((chunk, index) => {
    const entry = { t: chunk.t, offset, length: buffers[index]!.length };
    offset += buffers[index]!.length;
    return entry;
  }))}\n`);
  const lines = plain.split('\n');
  if (lines.at(-1) === '') lines.pop();
  writeFileSync(join(out, 'expected.json'), `${JSON.stringify({
    tmux: execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim(),
    cols: width, rows: height, cursorX, cursorY, alternate: alternate === 1,
    lines, ansi,
  }, null, 2)}\n`);
  console.log(`${scenario.name}: ${offset} bytes in ${chunks.length} chunks, cursor ${cursorX},${cursorY}`);
}

const selected = wanted.length ? scenarios.filter((scenario) => wanted.includes(scenario.name)) : scenarios;
for (const scenario of selected) {
  if (scenario.prepare && scenario.name.includes('-turn-') && !turnProfile()) {
    console.log(`${scenario.name}: skipped, pass --profile <name> of a Claude profile in Riffet's settings`);
    continue;
  }
  const workDir = mkdtempSync(join(tmpdir(), 'wk-fixture-'));
  writeFileSync(join(workDir, 'sample.ts'), `${sampleSource}\n`);
  try { await record(scenario, workDir); } finally { rmSync(workDir, { recursive: true, force: true }); }
}
