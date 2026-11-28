import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { CliVersionRange } from '../../packages/plugin-api/src/kit/cli-version.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_MANIFEST_PATH = resolve(REPO_ROOT, 'apps/server/src/backends/compat-manifest.json');

/** Built-in CLI backends tracked in `apps/server/src/backends/compat-manifest.json`. */
export const BUILTIN_CLI_BACKENDS = [
  'claude',
  'codex',
  'traex',
  'pi',
  'dsh',
  'droid',
  'antigravity',
  'cursor',
] as const;

export type BuiltinCliBackendId = (typeof BUILTIN_CLI_BACKENDS)[number];

export type BackendTier = 'A' | 'B' | 'C';
export type CompatRunMode = 'mock-llm' | 'hybrid' | 'live';
export type ScenarioStatus = 'pass' | 'fail' | 'not-applicable' | 'not-exercised';

/** Standard TCK scenario IDs from `docs/guide/cli-compat.md` §3.2. */
export const TCK_SCENARIO_IDS = [
  // 1. 探测与生命周期
  'probe-basic',
  'probe-timeout-recovery',
  'prewarm-hit-miss',
  // 2. 基础与富对话
  'basic-turn',
  'multi-turn',
  'multiline-boundary',
  'image-attachment',
  'rich-stream',
  // 3. 工具与审批闭环
  'tool-read-bash',
  'tool-parallel-ooo',
  'tool-malformed-recovery',
  'approval-deny',
  'approval-allow',
  'approval-cancel',
  'question-answer',
  'mode-switch',
  // 4. Steer、排队与打断
  'steer-valid',
  'steer-stale',
  'busy-queue',
  'interrupt-before-first-token',
  'interrupt-mid-stream',
  'interrupt-during-tool',
  'interrupt-and-send',
  // 5. Subagent 与后台任务
  'subagent-sync',
  'subagent-bg-unblocked',
  'bg-stop-single-and-multi',
  'bg-shell-stop',
  // 6. 斜杠、压缩与动态配置
  'slash-compact',
  'slash-clear',
  'configure-idle',
  'configure-while-bg',
  // 7. 重启、故障与跨版本
  'restart-idle',
  'restart-mid-turn',
  'cli-sigkill-recovery',
  'stream-disconnect',
  'http-error-recovery',
  'cross-version-resume',
  // 8. 扩展、MCP 与辅助对话
  'skills-discovery',
  'mcp-tools-audit',
  'side-chat',
] as const;

export type ScenarioId = (typeof TCK_SCENARIO_IDS)[number];

/** Core L1 scenarios: every backend entry in the manifest must pass at least one. */
export const CORE_SCENARIO_IDS = ['probe-basic', 'basic-turn'] as const satisfies readonly ScenarioId[];

const VALID_SCENARIO_IDS = new Set<string>(TCK_SCENARIO_IDS);
const VALID_SCENARIO_STATUSES = new Set<string>(['pass', 'fail', 'not-applicable', 'not-exercised']);
const VALID_TIERS = new Set<string>(['A', 'B', 'C']);
const VALID_MODES = new Set<string>(['mock-llm', 'hybrid', 'live']);

export interface ScenarioVerdict {
  status: ScenarioStatus;
  note?: string;
}

export interface BackendCompatRecord {
  tier: BackendTier;
  testedThrough: string;
  minimum?: string;
  testedAt: string;
  os: string;
  mode: CompatRunMode;
  scenarios: Record<ScenarioId, ScenarioVerdict>;
  notes?: string;
}

export interface CompatManifest {
  schemaVersion: 1;
  backends: Record<string, BackendCompatRecord>;
}

export interface BackendRunSummary {
  tier?: BackendTier;
  testedThrough?: string;
  minimum?: string;
  testedAt?: string;
  os?: string;
  mode?: CompatRunMode;
  scenarios: Partial<Record<ScenarioId, ScenarioVerdict>>;
  notes?: string;
}

export interface ManifestConsistencyResult {
  ok: boolean;
  errors: string[];
}

export function loadManifest(filePath = DEFAULT_MANIFEST_PATH): CompatManifest {
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as CompatManifest;
}

export function saveManifest(manifest: CompatManifest, filePath = DEFAULT_MANIFEST_PATH): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function emptyScenarios(): Record<ScenarioId, ScenarioVerdict> {
  const scenarios = {} as Record<ScenarioId, ScenarioVerdict>;
  for (const id of TCK_SCENARIO_IDS) {
    scenarios[id] = { status: 'not-exercised' };
  }
  return scenarios;
}

/**
 * Merges a partial or full TCK run summary for `backendId` into `manifest`, returning a new manifest
 * without mutating the input. When `runSummary.testedThrough` changes from the existing manifest
 * version, any scenario not included in `runSummary.scenarios` is reset to `not-exercised` so prior
 * version passes are never silently inherited by a newer CLI version.
 */
export function mergeBackendRun(
  manifest: CompatManifest,
  backendId: string,
  runSummary: BackendRunSummary,
): CompatManifest {
  const existing = manifest.backends[backendId];
  const versionChanged = Boolean(
    existing
    && runSummary.testedThrough !== undefined
    && runSummary.testedThrough !== existing.testedThrough,
  );
  const mergedScenarios: Record<ScenarioId, ScenarioVerdict> = existing
    ? versionChanged
      ? Object.fromEntries(
        TCK_SCENARIO_IDS.map(id => [
          id,
          { status: 'not-exercised' as const, note: 'reset on version change' },
        ]),
      ) as Record<ScenarioId, ScenarioVerdict>
      : { ...existing.scenarios }
    : emptyScenarios();

  for (const [key, verdict] of Object.entries(runSummary.scenarios)) {
    if (!verdict) continue;
    mergedScenarios[key as ScenarioId] = {
      status: verdict.status,
      ...(verdict.note !== undefined ? { note: verdict.note } : {}),
    };
  }

  const nextMinimum = runSummary.minimum !== undefined ? runSummary.minimum : existing?.minimum;
  const nextNotes = runSummary.notes !== undefined ? runSummary.notes : existing?.notes;

  const nextRecord: BackendCompatRecord = {
    tier: runSummary.tier ?? existing?.tier ?? 'A',
    testedThrough: runSummary.testedThrough ?? existing?.testedThrough ?? '',
    ...(nextMinimum !== undefined ? { minimum: nextMinimum } : {}),
    testedAt: runSummary.testedAt ?? new Date().toISOString().slice(0, 10),
    os: runSummary.os ?? existing?.os ?? process.platform,
    mode: runSummary.mode ?? existing?.mode ?? 'mock-llm',
    scenarios: mergedScenarios,
    ...(nextNotes !== undefined ? { notes: nextNotes } : {}),
  };

  return {
    ...manifest,
    backends: {
      ...manifest.backends,
      [backendId]: nextRecord,
    },
  };
}

interface DeclaredSourceSpec {
  readonly file: string;
  readonly kind: 'variable' | 'object-property' | 'class-property';
  readonly container: string;
  readonly property?: string;
}

const BUILTIN_CLI_VERSION_SOURCES: Record<BuiltinCliBackendId, DeclaredSourceSpec> = {
  claude: { file: 'apps/server/src/backends/claude/launch.ts', kind: 'variable', container: 'CLAUDE_CLI_VERSIONS' },
  codex: { file: 'apps/server/src/backends/codex/flavors.ts', kind: 'object-property', container: 'codexFlavor', property: 'cliVersions' },
  traex: { file: 'apps/server/src/backends/codex/flavors.ts', kind: 'object-property', container: 'traexFlavor', property: 'cliVersions' },
  pi: { file: 'apps/server/src/backends/pi/index.ts', kind: 'variable', container: 'PI_CLI_VERSIONS' },
  dsh: { file: 'apps/server/src/backends/dsh/settings.ts', kind: 'variable', container: 'DSH_CLI_VERSIONS' },
  droid: { file: 'apps/server/src/backends/droid/index.ts', kind: 'variable', container: 'DROID_CLI_VERSIONS' },
  antigravity: { file: 'plugins/riffet/antigravity/backend.ts', kind: 'class-property', container: 'AntigravityBackend', property: 'cliVersions' },
  cursor: { file: 'plugins/riffet/cursor/cli-adapter.ts', kind: 'variable', container: 'CURSOR_CLI_VERSIONS' },
};

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyKeyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function parseSource(fullPath: string): ts.SourceFile {
  return ts.createSourceFile(fullPath, readFileSync(fullPath, 'utf8'), ts.ScriptTarget.Latest, true);
}

function resolveImportPath(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.mjs$/, '.mts'),
    `${base}.ts`,
    resolve(base, 'index.ts'),
  ];
  return candidates.find(candidate => existsSync(candidate));
}

function findVariableInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | undefined {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
        return unwrapExpression(decl.initializer);
      }
    }
  }
  return undefined;
}

function findObjectProperty(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && propertyKeyName(prop.name) === key) {
      return unwrapExpression(prop.initializer);
    }
  }
  return undefined;
}

function findClassProperty(sourceFile: ts.SourceFile, className: string, propName: string): ts.Expression | undefined {
  for (const stmt of sourceFile.statements) {
    if (!ts.isClassDeclaration(stmt) || stmt.name?.text !== className) continue;
    for (const member of stmt.members) {
      if (ts.isPropertyDeclaration(member) && propertyKeyName(member.name) === propName && member.initializer) {
        return unwrapExpression(member.initializer);
      }
    }
  }
  return undefined;
}

function resolveStringExpression(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  fullPath: string,
  visited = new Set<string>(),
): string | undefined {
  const unwrapped = unwrapExpression(expr);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text;
  }
  if (!ts.isIdentifier(unwrapped)) return undefined;
  const name = unwrapped.text;
  const visitKey = `${fullPath}#${name}`;
  if (visited.has(visitKey)) return undefined;
  visited.add(visitKey);

  const localInit = findVariableInitializer(sourceFile, name);
  if (localInit) return resolveStringExpression(localInit, sourceFile, fullPath, visited);

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.name.text !== name) continue;
      const exportedName = element.propertyName?.text ?? element.name.text;
      const targetPath = resolveImportPath(fullPath, stmt.moduleSpecifier.text);
      if (!targetPath) return undefined;
      const targetSource = parseSource(targetPath);
      const targetInit = findVariableInitializer(targetSource, exportedName);
      if (!targetInit) return undefined;
      return resolveStringExpression(targetInit, targetSource, targetPath, visited);
    }
  }
  return undefined;
}

function extractCliVersionRange(repoRoot: string, backendId: BuiltinCliBackendId, spec: DeclaredSourceSpec): CliVersionRange {
  const fullPath = resolve(repoRoot, spec.file);
  if (!existsSync(fullPath)) {
    throw new Error(`Cannot read declared cliVersions for "${backendId}": ${spec.file} does not exist`);
  }
  const sourceFile = parseSource(fullPath);
  let targetExpr: ts.Expression | undefined;
  if (spec.kind === 'variable') {
    targetExpr = findVariableInitializer(sourceFile, spec.container);
  } else if (spec.kind === 'object-property' && spec.property) {
    const containerExpr = findVariableInitializer(sourceFile, spec.container);
    if (containerExpr && ts.isObjectLiteralExpression(containerExpr)) {
      targetExpr = findObjectProperty(containerExpr, spec.property);
    }
  } else if (spec.kind === 'class-property' && spec.property) {
    targetExpr = findClassProperty(sourceFile, spec.container, spec.property);
  }

  if (!targetExpr || !ts.isObjectLiteralExpression(targetExpr)) {
    throw new Error(`Could not locate cliVersions object literal for "${backendId}" in ${spec.file}`);
  }

  const minExpr = findObjectProperty(targetExpr, 'minimum');
  const testedExpr = findObjectProperty(targetExpr, 'testedThrough');
  const minimum = minExpr ? resolveStringExpression(minExpr, sourceFile, fullPath) : undefined;
  const testedThrough = testedExpr ? resolveStringExpression(testedExpr, sourceFile, fullPath) : undefined;

  if (minExpr && !minimum) {
    throw new Error(`Could not statically resolve cliVersions.minimum for "${backendId}" in ${spec.file}`);
  }
  if (testedExpr && !testedThrough) {
    throw new Error(`Could not statically resolve cliVersions.testedThrough for "${backendId}" in ${spec.file}`);
  }

  return {
    ...(minimum ? { minimum } : {}),
    ...(testedThrough ? { testedThrough } : {}),
  };
}

/**
 * Statically extracts the declared `CliVersionRange` for all 8 built-in CLI backends directly from
 * their source files, without importing server/plugin modules or triggering runtime side effects.
 */
export function readDeclaredCliVersions(repoRoot = REPO_ROOT): Record<BuiltinCliBackendId, CliVersionRange> {
  const result = {} as Record<BuiltinCliBackendId, CliVersionRange>;
  for (const backendId of BUILTIN_CLI_BACKENDS) {
    result[backendId] = extractCliVersionRange(repoRoot, backendId, BUILTIN_CLI_VERSION_SOURCES[backendId]);
  }
  return result;
}

/**
 * Validates `compat-manifest.json` against the source code's declared `cliVersions`:
 * 1. All 8 built-in CLI backends are present in `manifest.backends`;
 * 2. Each backend's `testedThrough` matches `declared[id].testedThrough`;
 * 3. Each backend's `minimum` matches `declared[id].minimum` when declared (and is not drifted);
 * 4. No scenario has status `'fail'`;
 * 5. At least one core scenario (`probe-basic` or `basic-turn`) has status `'pass'`;
 * 6. Every scenario key belongs to `TCK_SCENARIO_IDS` and has a valid status.
 */
export function checkManifestConsistency(
  manifest: CompatManifest,
  declared: Partial<Record<string, CliVersionRange>>,
): ManifestConsistencyResult {
  const errors: string[] = [];

  if (manifest.schemaVersion !== 1) {
    errors.push(`Unsupported compat-manifest schemaVersion: ${String(manifest.schemaVersion)} (expected 1)`);
  }
  if (!manifest.backends || typeof manifest.backends !== 'object') {
    return { ok: false, errors: [...errors, 'manifest.backends must be an object'] };
  }

  for (const backendId of BUILTIN_CLI_BACKENDS) {
    if (!(backendId in manifest.backends)) {
      errors.push(`Missing built-in CLI backend "${backendId}" in compat-manifest.json`);
    }
  }

  for (const [backendId, record] of Object.entries(manifest.backends)) {
    if (!record || typeof record !== 'object') {
      errors.push(`${backendId}: backend entry must be an object`);
      continue;
    }

    if (!VALID_TIERS.has(record.tier)) {
      errors.push(`${backendId}: invalid tier "${String(record.tier)}" (expected A, B, or C)`);
    }
    if (!VALID_MODES.has(record.mode)) {
      errors.push(`${backendId}: invalid mode "${String(record.mode)}" (expected mock-llm, hybrid, or live)`);
    }
    if (typeof record.testedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(record.testedAt)) {
      errors.push(`${backendId}: testedAt must be an ISO date string (got "${String(record.testedAt)}")`);
    }
    if (typeof record.os !== 'string' || !record.os.trim()) {
      errors.push(`${backendId}: os must be a non-empty string`);
    }

    const sourceRange = declared[backendId];
    if (sourceRange) {
      if (!sourceRange.testedThrough) {
        errors.push(`${backendId}: source declaration is missing cliVersions.testedThrough`);
      } else if (record.testedThrough !== sourceRange.testedThrough) {
        errors.push(
          `${backendId}: testedThrough mismatch — manifest has "${record.testedThrough}", source declares "${sourceRange.testedThrough}"`,
        );
      }

      if (sourceRange.minimum !== undefined && record.minimum !== sourceRange.minimum) {
        errors.push(
          `${backendId}: minimum mismatch — manifest has "${record.minimum ?? '(unset)'}", source declares "${sourceRange.minimum}"`,
        );
      } else if (sourceRange.minimum === undefined && record.minimum !== undefined) {
        errors.push(
          `${backendId}: minimum mismatch — manifest sets "${record.minimum}", but source declares no minimum`,
        );
      }
    } else if ((BUILTIN_CLI_BACKENDS as readonly string[]).includes(backendId)) {
      errors.push(`${backendId}: missing declared cliVersions for built-in backend`);
    }

    const scenarios = record.scenarios;
    if (!scenarios || typeof scenarios !== 'object') {
      errors.push(`${backendId}: scenarios must be an object`);
      continue;
    }

    let hasCorePass = false;
    for (const [scenarioId, verdict] of Object.entries(scenarios)) {
      if (!VALID_SCENARIO_IDS.has(scenarioId)) {
        errors.push(`${backendId}: unknown scenario id "${scenarioId}"`);
        continue;
      }
      if (!verdict || typeof verdict !== 'object' || !VALID_SCENARIO_STATUSES.has(verdict.status)) {
        errors.push(`${backendId}.${scenarioId}: invalid verdict status "${String(verdict?.status)}"`);
        continue;
      }
      if (verdict.status === 'fail') {
        errors.push(`${backendId}.${scenarioId}: scenario is in "fail" state${verdict.note ? ` (${verdict.note})` : ''}`);
      }
      if (verdict.status === 'pass' && (CORE_SCENARIO_IDS as readonly string[]).includes(scenarioId)) {
        hasCorePass = true;
      }
    }

    if (!hasCorePass) {
      errors.push(`${backendId}: at least one core scenario (${CORE_SCENARIO_IDS.join(' or ')}) must have status "pass"`);
    }
  }

  return { ok: errors.length === 0, errors };
}
