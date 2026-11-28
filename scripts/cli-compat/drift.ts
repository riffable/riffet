import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { compareVersions, parseVersion } from '../../packages/plugin-api/src/kit/cli-version.js';
import { REPO_ROOT } from './manifest.js';

export interface VocabularySnapshot {
  backendId: string;
  baselineVersion?: string;
  jsonRpcMethods: string[];
  itemTypes: string[];
  hookEvents: string[];
  transcriptRowTypes: string[];
  /** Tagged flat vocabulary entries (`rpc:...`, `item:...`, `hook:...`, `row:...`). */
  tokens: string[];
}

export interface VocabularyDiffResult {
  drifted: boolean;
  added: string[];
  missing: string[];
}

export interface ExportedDriftCandidate {
  filePath: string;
  payload: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function latestVersionSubdir(parentDir: string): { version: string; dir: string } | undefined {
  if (!existsSync(parentDir)) return undefined;
  const entries = readdirSync(parentDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
  if (entries.length === 0) return undefined;

  const sorted = entries
    .map(entry => ({
      name: entry.name,
      parsed: parseVersion(entry.name),
    }))
    .sort((a, b) => {
      if (a.parsed && b.parsed) return compareVersions(b.parsed, a.parsed);
      if (a.parsed) return -1;
      if (b.parsed) return 1;
      return b.name.localeCompare(a.name);
    });

  const best = sorted[0]!;
  return { version: best.name, dir: join(parentDir, best.name) };
}

function jsonlFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => join(dir, entry.name))
    .sort();
}

function walkJsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        found.push(full);
      }
    }
  }
  return found.sort();
}

function collectCodexItemTypes(node: unknown, itemTypes: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectCodexItemTypes(child, itemTypes);
    return;
  }
  const rec = node as Record<string, unknown>;
  const item = asRecord(rec.item);
  const itemType = asNonEmptyString(item?.type);
  if (itemType) itemTypes.add(itemType);

  if (Array.isArray(rec.items)) {
    for (const entry of rec.items) {
      const entryType = asNonEmptyString(asRecord(entry)?.type);
      if (entryType) itemTypes.add(entryType);
    }
  }
  if (Array.isArray(rec.data)) {
    for (const entry of rec.data) {
      collectCodexItemTypes(entry, itemTypes);
    }
  }
  if (rec.turn && typeof rec.turn === 'object') {
    collectCodexItemTypes(rec.turn, itemTypes);
  }
}

function scanCodexAppServerFile(
  filePath: string,
  jsonRpcMethods: Set<string>,
  itemTypes: Set<string>,
  hookEvents: Set<string>,
): void {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rec = asRecord(parsed);
    if (!rec) continue;

    const method = asNonEmptyString(rec.method);
    if (method) jsonRpcMethods.add(method);

    if (rec.kind === 'hook') {
      const eventName = asNonEmptyString(asRecord(rec.payload)?.hook_event_name);
      if (eventName) hookEvents.add(eventName);
    }

    collectCodexItemTypes(rec.params, itemTypes);
    collectCodexItemTypes(rec.result, itemTypes);
  }
}

function scanCodexRolloutFile(
  filePath: string,
  itemTypes: Set<string>,
  transcriptRowTypes: Set<string>,
): void {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rec = asRecord(parsed);
    if (!rec) continue;

    const rowType = asNonEmptyString(rec.type);
    const payload = asRecord(rec.payload);
    const payloadType = asNonEmptyString(payload?.type);
    if (rowType) {
      transcriptRowTypes.add(payloadType ? `${rowType}:${payloadType}` : rowType);
    }
    if (payload) {
      collectCodexItemTypes(payload, itemTypes);
    }
  }
}

function collectClaudeTranscriptRecord(
  inner: Record<string, unknown>,
  itemTypes: Set<string>,
  transcriptRowTypes: Set<string>,
): void {
  const type = asNonEmptyString(inner.type);
  const subtype = asNonEmptyString(inner.subtype);
  if (type) {
    transcriptRowTypes.add(subtype ? `${type}:${subtype}` : type);
  }
  const message = asRecord(inner.message);
  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      const blockType = asNonEmptyString(asRecord(block)?.type);
      if (blockType) itemTypes.add(blockType);
    }
  }
}

function scanRawClaudeTranscriptFile(
  filePath: string,
  itemTypes: Set<string>,
  transcriptRowTypes: Set<string>,
): void {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rec = asRecord(parsed);
    if (!rec) continue;
    collectClaudeTranscriptRecord(rec, itemTypes, transcriptRowTypes);
  }
}

function scanGenericRawJsonlFile(
  filePath: string,
  jsonRpcMethods: Set<string>,
  itemTypes: Set<string>,
  hookEvents: Set<string>,
  transcriptRowTypes: Set<string>,
): void {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rec = asRecord(parsed);
    if (!rec) continue;

    const method = asNonEmptyString(rec.method);
    if (method) jsonRpcMethods.add(method);

    const hookName = asNonEmptyString(rec.hook_event_name)
      ?? asNonEmptyString(asRecord(rec.payload)?.hook_event_name);
    if (hookName) hookEvents.add(hookName);

    const type = asNonEmptyString(rec.type);
    const subtype = asNonEmptyString(rec.subtype);
    const payload = asRecord(rec.payload);
    const payloadType = asNonEmptyString(payload?.type);
    if (type) {
      transcriptRowTypes.add(subtype ? `${type}:${subtype}` : payloadType ? `${type}:${payloadType}` : type);
    }
    if (payload) {
      collectCodexItemTypes(payload, itemTypes);
    }
    collectClaudeTranscriptRecord(rec, itemTypes, transcriptRowTypes);
  }
}

function scanClaudeTranscriptHooksFile(
  filePath: string,
  itemTypes: Set<string>,
  hookEvents: Set<string>,
  transcriptRowTypes: Set<string>,
): void {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rec = asRecord(parsed);
    if (!rec) continue;

    if (rec.kind === 'hook') {
      const eventName = asNonEmptyString(asRecord(rec.payload)?.hook_event_name);
      if (eventName) hookEvents.add(eventName);
      continue;
    }

    if (rec.kind === 'transcript' && typeof rec.text === 'string') {
      for (const innerLine of rec.text.split(/\r?\n/)) {
        const innerTrimmed = innerLine.trim();
        if (!innerTrimmed) continue;
        let innerParsed: unknown;
        try {
          innerParsed = JSON.parse(innerTrimmed);
        } catch {
          continue;
        }
        const inner = asRecord(innerParsed);
        if (!inner) continue;
        collectClaudeTranscriptRecord(inner, itemTypes, transcriptRowTypes);
      }
    }
  }
}

export function buildVocabularySnapshot(input: {
  backendId: string;
  baselineVersion?: string;
  jsonRpcMethods?: Iterable<string>;
  itemTypes?: Iterable<string>;
  hookEvents?: Iterable<string>;
  transcriptRowTypes?: Iterable<string>;
}): VocabularySnapshot {
  const jsonRpcMethods = [...new Set(input.jsonRpcMethods ?? [])].sort();
  const itemTypes = [...new Set(input.itemTypes ?? [])].sort();
  const hookEvents = [...new Set(input.hookEvents ?? [])].sort();
  const transcriptRowTypes = [...new Set(input.transcriptRowTypes ?? [])].sort();

  const tokens = [
    ...jsonRpcMethods.map(v => `rpc:${v}`),
    ...itemTypes.map(v => `item:${v}`),
    ...hookEvents.map(v => `hook:${v}`),
    ...transcriptRowTypes.map(v => `row:${v}`),
  ].sort();

  return {
    backendId: input.backendId,
    ...(input.baselineVersion ? { baselineVersion: input.baselineVersion } : {}),
    jsonRpcMethods,
    itemTypes,
    hookEvents,
    transcriptRowTypes,
    tokens,
  };
}

/**
 * Extracts the committed baseline protocol/event vocabulary for `backendId` from the newest
 * versioned recordings in `apps/server/src/backends/{codex,claude}/fixtures/`.
 */
export function extractCommittedVocabulary(
  backendId: string,
  repoRoot = REPO_ROOT,
): VocabularySnapshot {
  const jsonRpcMethods = new Set<string>();
  const itemTypes = new Set<string>();
  const hookEvents = new Set<string>();
  const transcriptRowTypes = new Set<string>();
  let baselineVersion: string | undefined;

  if (backendId === 'codex' || backendId === 'traex') {
    const baseDir = backendId === 'traex'
      ? resolve(repoRoot, 'apps/server/src/backends/codex/fixtures/traex')
      : resolve(repoRoot, 'apps/server/src/backends/codex/fixtures');

    const latestAppServer = latestVersionSubdir(join(baseDir, 'app-server'));
    if (latestAppServer) {
      baselineVersion = latestAppServer.version;
      for (const file of jsonlFilesIn(latestAppServer.dir)) {
        scanCodexAppServerFile(file, jsonRpcMethods, itemTypes, hookEvents);
      }
    }

    const latestRollout = latestVersionSubdir(join(baseDir, 'rollout'));
    if (latestRollout) {
      baselineVersion ??= latestRollout.version;
      for (const file of jsonlFilesIn(latestRollout.dir)) {
        scanCodexRolloutFile(file, itemTypes, transcriptRowTypes);
      }
    }
  } else if (backendId === 'claude') {
    const baseDir = resolve(repoRoot, 'apps/server/src/backends/claude/fixtures/transcript-hooks');
    const latest = latestVersionSubdir(baseDir);
    if (latest) {
      baselineVersion = latest.version;
      for (const file of jsonlFilesIn(latest.dir)) {
        scanClaudeTranscriptHooksFile(file, itemTypes, hookEvents, transcriptRowTypes);
      }
    }
  }

  return buildVocabularySnapshot({
    backendId,
    baselineVersion,
    jsonRpcMethods,
    itemTypes,
    hookEvents,
    transcriptRowTypes,
  });
}

export interface RawVocabularyCollectionOptions {
  baselineVersion?: string;
  extra?: {
    jsonRpcMethods?: Iterable<string>;
    itemTypes?: Iterable<string>;
    hookEvents?: Iterable<string>;
    transcriptRowTypes?: Iterable<string>;
  };
}

/**
 * Scans native CLI files written inside an isolated compat sandbox (Codex/TRAE rollout JSONL,
 * Claude raw transcript JSONL, and other backend JSONL artifacts) plus any captured raw
 * hook/RPC events, producing a `VocabularySnapshot` in the exact same namespace as
 * `extractCommittedVocabulary` (`rpc:*`, `item:*`, `hook:*`, `row:*`).
 */
export function collectObservedRawVocabulary(
  backendId: string,
  sandbox: { readonly cliHome: string; readonly stateDir?: string },
  options: RawVocabularyCollectionOptions = {},
): VocabularySnapshot {
  const jsonRpcMethods = new Set<string>(options.extra?.jsonRpcMethods ?? []);
  const itemTypes = new Set<string>(options.extra?.itemTypes ?? []);
  const hookEvents = new Set<string>(options.extra?.hookEvents ?? []);
  const transcriptRowTypes = new Set<string>(options.extra?.transcriptRowTypes ?? []);

  if (backendId === 'codex') {
    const sessionsDir = join(sandbox.cliHome, 'codex', 'sessions');
    for (const file of walkJsonlFiles(sessionsDir)) {
      scanCodexRolloutFile(file, itemTypes, transcriptRowTypes);
    }
  } else if (backendId === 'traex') {
    for (const dir of [
      join(sandbox.cliHome, 'traex', 'cli', 'sessions'),
      join(sandbox.cliHome, 'traex', 'sessions'),
    ]) {
      for (const file of walkJsonlFiles(dir)) {
        scanCodexRolloutFile(file, itemTypes, transcriptRowTypes);
      }
    }
  } else if (backendId === 'claude') {
    const projectsDir = join(sandbox.cliHome, 'claude', 'projects');
    for (const file of walkJsonlFiles(projectsDir)) {
      scanRawClaudeTranscriptFile(file, itemTypes, transcriptRowTypes);
    }
  } else {
    const backendDir = join(sandbox.cliHome, backendId === 'droid' ? 'factory' : backendId);
    for (const file of walkJsonlFiles(backendDir)) {
      scanGenericRawJsonlFile(file, jsonRpcMethods, itemTypes, hookEvents, transcriptRowTypes);
    }
  }

  return buildVocabularySnapshot({
    backendId,
    baselineVersion: options.baselineVersion,
    jsonRpcMethods,
    itemTypes,
    hookEvents,
    transcriptRowTypes,
  });
}

function toTokenSet(input: VocabularySnapshot | readonly string[]): Set<string> {
  if (Array.isArray(input)) {
    return new Set(input.filter((item): item is string => typeof item === 'string' && item.length > 0));
  }
  return new Set((input as VocabularySnapshot).tokens);
}

/**
 * Compares baseline vs observed vocabulary tokens, returning sorted `added`, `missing`, and `drifted`.
 */
export function compareVocabulary(
  baseline: VocabularySnapshot | readonly string[],
  observed: VocabularySnapshot | readonly string[],
): VocabularyDiffResult {
  const baseSet = toTokenSet(baseline);
  const obsSet = toTokenSet(observed);

  const added = [...obsSet].filter(token => !baseSet.has(token)).sort();
  const missing = [...baseSet].filter(token => !obsSet.has(token)).sort();

  return {
    drifted: added.length > 0 || missing.length > 0,
    added,
    missing,
  };
}

const SENSITIVE_KEY_RE = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|password|secret|credential|bearer|cookie|set-cookie|x-api-key|x-goog-api-key)$/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bwkn_[0-9a-f]{16}_[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{16,}/g,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
];

const HOME_PATH_RE = /(?<![\w.~])\/(?:Users|home)\/[^/\s'"`)\]}>:;,\\]+/g;
const WIN_HOME_PATH_RE = /[A-Za-z]:\\Users\\[^\\\s'"`)\]}>:;,]+/g;
const URL_RE = /\b(https?|wss?):\/\/([^\s'"`)\]}>,;]+)/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const PRIVATE_IP_RE = /(?<![\w.])(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})(?![\w.]*\w)/g;

export function redactString(raw: string, home = homedir()): string {
  let out = raw;
  if (home && home.length > 1) {
    out = out.split(home).join('/home/user');
  }
  out = out.replace(HOME_PATH_RE, '/home/user');
  out = out.replace(WIN_HOME_PATH_RE, 'C:\\Users\\user');

  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }

  out = out.replace(URL_RE, (full, scheme: string, rest: string) => {
    try {
      const parsed = new URL(`${scheme}://${rest}`);
      const host = parsed.hostname.toLowerCase();
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
        return `${parsed.protocol}//127.0.0.1${parsed.port ? ':<port>' : ''}${parsed.pathname}`;
      }
      return `${parsed.protocol}//redacted.example.invalid${parsed.pathname}`;
    } catch {
      return full.replace(/\/\/[^/\s]+/, '//redacted.example.invalid');
    }
  });

  out = out.replace(EMAIL_RE, match => (
    /@(?:[a-z0-9-]+\.)*example\.invalid$/i.test(match) ? match : 'redacted@example.invalid'
  ));

  out = out.replace(PRIVATE_IP_RE, '192.0.2.1');
  return out;
}

export function redactPayload(value: unknown, home = homedir()): unknown {
  if (typeof value === 'string') return redactString(value, home);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => redactPayload(item, home));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redactPayload(entry, home);
    }
  }
  return out;
}

/**
 * Exports a redacted drift candidate JSON file so unexpected CLI protocol changes can be
 * reviewed and selectively promoted to fixtures without leaking local paths, URLs, or secrets.
 */
export function exportRedactedDriftCandidate(
  outDir: string,
  backendId: string,
  version: string,
  payload: unknown,
): ExportedDriftCandidate {
  const safeBackend = backendId.replace(/[^a-zA-Z0-9._-]+/g, '-') || 'backend';
  const safeVersion = (version || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-') || 'unknown';
  mkdirSync(outDir, { recursive: true });

  const redacted = redactPayload({
    backendId,
    version,
    exportedAt: new Date().toISOString(),
    payload,
  });

  const filePath = resolve(outDir, `${safeBackend}-${safeVersion}-drift.json`);
  writeFileSync(filePath, `${JSON.stringify(redacted, null, 2)}\n`, 'utf8');
  return { filePath, payload: redacted };
}
