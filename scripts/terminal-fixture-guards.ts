import { readFileSync } from 'node:fs';

/**
 * Redactions shared by the terminal fixture recorder and the test that scans checked-in fixtures.
 *
 * Recordings are committed, so third-party names, private domains, documentation URLs, model ids
 * and machine paths become synthetic text. Replacements MUST keep the UTF-8 byte length and the
 * displayed column count of the original: chunk offsets index the recorded stream in bytes, and
 * tmux laid the screen out at the original widths.
 */

/**
 * Names that identify an organisation or a private route, kept out of version control: a JSON array
 * of `[from, to]` pairs in the file named by `RIFFET_FIXTURE_REDACTIONS_FILE`. They are applied
 * before the rules below (longer hosts before the shorter names they contain), obey the same
 * length rules, and every `from` also counts as forbidden text.
 */
function loadLocalRedactions(): ReadonlyArray<readonly [string, string]> {
  const file = process.env.RIFFET_FIXTURE_REDACTIONS_FILE;
  if (!file) return [];
  const pairs = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(pairs) || pairs.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(part => typeof part !== 'string' || !part))) {
    throw new Error(`${file} must hold a JSON array of [from, to] string pairs`);
  }
  return pairs as Array<[string, string]>;
}
export const localRedactions = loadLocalRedactions();

const builtinRedactions: ReadonlyArray<readonly [string, string]> = [
  ['ANTHROPIC', 'SYNTHETIC'],
  ['Anthropic', 'Synthetic'],
  ['anthropic', 'synthetic'],
  ['CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT', 'AURORA_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT'],
  ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'AURORA_CODE_MAX_CONTEXT_TOKENS'],
  ['code.claude.com', 'doc.example.com'],
  ['Claude', 'Aurora'],
  ['deepseek-v4.1-flash', 'synthetic-model-001'],
  ['OpenAI', 'AcmeAI'],
  ['Codex', 'Nexus'],
  ['codex_home', 'agent_home'],
  ['codex-home', 'agent-home'],
  ['v2.1.292', 'v0.0.000'],
  ['v0.160.1', 'v0.0.000'],
  ['Forty-two is an answer.', 'Sample output is ready.'],
  // The trust dialog and footer are written as cursor-positioned tokens, so both the visible
  // sentence (capture-pane) and the token sequence with its erase+forward pair (the stream) match.
  ['Yes, I trust this folder', 'Yes, I allow this folder'],
  ['Yes,\u001b[CI\u001b[Ctrust', 'Yes,\u001b[CI\u001b[Callow'],
  ['Quick safety check', 'Local folder check'],
  ['Quick\u001b[Csafety\u001b[Ccheck', 'Local\u001b[Cfolder\u001b[Ccheck'],
  ['Security guide', 'Guidance notes'],
  ['Security\u001b[Cguide', 'Guidance\u001b[Cnotes'],
  ['auto mode on (shift+tab to cycle)', 'edit mode on (alt+shift to cycle)'],
  ['auto\u001b[1X\u001b[Cmode\u001b[1X\u001b[Con\u001b[1X\u001b[C(shift+tab\u001b[1X\u001b[Cto\u001b[1X\u001b[Ccycle)', 'edit\u001b[1X\u001b[Cmode\u001b[1X\u001b[Con\u001b[1X\u001b[C(alt+shift\u001b[1X\u001b[Cto\u001b[1X\u001b[Ccycle)'],
  ['API Usage Billing', 'App usage details'],
  ['API\u001b[1X\u001b[CUsage\u001b[1X\u001b[CBilling', 'App\u001b[1X\u001b[Cusage\u001b[1X\u001b[Cdetails'],
  // Claude Code's whimsical spinner verbs. Bréwing keeps the original's 8 UTF-8 bytes (7 columns).
  ['Slithering', 'Processing'],
  ['Enchant', 'Working'],
  ['Unfurling', 'Gathering'],
  ['Bunning', 'Running'],
  ['Sautéed', 'Bréwing'],
];

export const redactions: ReadonlyArray<readonly [string, string]> = [...localRedactions, ...builtinRedactions];

/**
 * Third-party markers, product copy and machine-specific paths that must not reach a checked-in
 * fixture, plus the names in `RIFFET_FIXTURE_REDACTIONS_FILE`. The rules are phrases, not single words: `guide` or `safety` also occur in
 * ordinary prose the recording is meant to keep.
 */
export const forbidden: readonly RegExp[] = [
  /claude/i, /anthropic/i, /openai/i, /codex/i, /deepseek/i, /gemini/i,
  /Quick safety check/, /Quick(?:\u001b\[[0-9;]*[A-Za-z])+safety/,
  /Security guide/, /Security(?:\u001b\[[0-9;]*[A-Za-z])+guide/,
  /Yes, I trust/, /shift\+tab/, /API Usage/,
  /Sautéed/, /Slithering/, /Enchant/, /Unfurling/, /Bunning/,
  /\/Users\//, /\/home\/[^/\s]+\//, /\/var\/folders\//,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  ...localRedactions.map(([from]) => new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')),
];

const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
const ZERO_WIDTH = /^[̀-ͯ​-‏︀-️]$/;
const WIDE = /^[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]$/u;

/** Terminal display columns, after dropping CSI/OSC sequences and counting East Asian wide glyphs as two. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text.replace(ANSI, '')) {
    if (ZERO_WIDTH.test(char)) continue;
    width += WIDE.test(char) ? 2 : 1;
  }
  return width;
}

function assertLayout(from: string, to: string): void {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) throw new Error(`redaction changes byte length: ${from} -> ${to}`);
  if (displayWidth(from) !== displayWidth(to)) throw new Error(`redaction changes display width: ${from} -> ${to}`);
}

export function redact(text: string): string {
  let out = text;
  for (const [from, to] of redactions) {
    assertLayout(from, to);
    out = out.split(from).join(to);
  }
  // Temporary recording directories carry a random suffix; make it deterministic too. Record
  // with TMPDIR=/tmp so the prefix is the fixed `/tmp/` seen in the fixtures rather than a
  // machine-specific `/var/folders/…`.
  out = out.replace(/wk-fixture-[A-Za-z0-9]{6}/g, 'wk-fixture-000000');
  assertRedacted(out);
  return out;
}

export function assertRedacted(text: string): void {
  const leftover = forbidden.find((pattern) => pattern.test(text));
  if (leftover) throw new Error(`recording still contains third-party text or a machine path matching ${leftover}; add a same-length placeholder to redactions (or record with TMPDIR=/tmp)`);
}
