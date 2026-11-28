import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getBackendCompatSpec,
  listBackendCompatSpecs,
  type BackendCompatSpec,
  type BackendProtocol,
} from './backends/index.js';
import {
  compareVocabulary,
  exportRedactedDriftCandidate,
  extractCommittedVocabulary,
} from './drift.js';
import {
  BUILTIN_CLI_BACKENDS,
  checkManifestConsistency,
  loadManifest,
  mergeBackendRun,
  readDeclaredCliVersions,
  saveManifest,
  type ScenarioId,
  type ScenarioVerdict,
} from './manifest.js';
import { runAllActiveCleanups } from './sandbox.js';
import {
  TCK_CATEGORY_LABELS,
  TCK_SCENARIOS,
  runTckSuite,
  type TckCategory,
  type TckSuiteReport,
} from './tck.js';
import { checkUpstreamVersions, formatUpstreamTable } from './upstream.js';

const VALID_PROTOCOLS = new Set<BackendProtocol>([
  'anthropic-messages',
  'openai-responses',
  'openai-chat',
  'google-generative-ai',
  'proprietary',
]);

function printUsage(): void {
  console.log([
    'Riffet Agent CLI Compatibility Toolkit (pnpm cli:compat)',
    '',
    'Usage:',
    '  pnpm cli:compat list',
    '  pnpm cli:compat check-manifest',
    '  pnpm cli:compat upstream [backend|all]',
    '  pnpm cli:compat run <backend|all> [options]',
    '',
    'Run options:',
    '  --scenario <id1,id2>     Comma-separated TCK scenario IDs',
    '  --bin <path>             Candidate CLI executable path',
    '  --prev-bin <path>        Previous CLI executable path (for cross-version-resume)',
    '  --plugin-dir <path>      External plugin directory (for out-of-tree plugin agents)',
    '  --protocol <proto>       Protocol for external plugin (anthropic-messages|openai-responses|openai-chat|google-generative-ai|proprietary)',
    '  --model <id>             Override model ID',
    '  --live                   Run against live account/gateway instead of MockLlmHub',
    '  --keep                   Keep sandbox directory on disk after completion',
    '  --timeout <sec>          Per-scenario timeout in seconds (default: 120)',
    '  --write-manifest         Merge scenario verdicts back into compat-manifest.json',
    '  --export-drift <dir>     Export redacted drift candidate JSON if vocabulary drifts or any scenario fails',
    '  --out <report.json>      Write full JSON report to file',
  ].join('\n'));
}

function cmdList(): void {
  console.log('=== Built-in CLI Backends ===');
  const specs = listBackendCompatSpecs();
  const headers = ['Backend', 'Label', 'Tier', 'Protocol', 'Command', 'Plugin', 'Restart'];
  const rows = specs.map(s => [
    s.id,
    s.label,
    s.tier,
    s.protocol,
    s.defaultCommand,
    s.requiresPlugin ?? '-',
    s.supportsRestartTakeover ? 'yes' : 'no',
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
  const fmt = (cells: readonly string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  console.log(fmt(headers));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(fmt(row));

  console.log('\n=== TCK Scenarios (40 total) ===');
  const byCategory = new Map<TckCategory, typeof TCK_SCENARIOS[number][]>();
  for (const scenario of TCK_SCENARIOS) {
    const list = byCategory.get(scenario.category) ?? [];
    list.push(scenario);
    byCategory.set(scenario.category, list);
  }
  for (const [category, label] of Object.entries(TCK_CATEGORY_LABELS) as Array<[TckCategory, string]>) {
    const list = byCategory.get(category) ?? [];
    console.log(`\n${label} (${list.length})`);
    for (const s of list) {
      console.log(`  - ${s.id.padEnd(30)} ${s.title}`);
    }
  }
}

function cmdCheckManifest(): number {
  const manifest = loadManifest();
  const declared = readDeclaredCliVersions();
  const result = checkManifestConsistency(manifest, declared);
  if (result.ok) {
    console.log(
      `compat-manifest.json is consistent with all ${BUILTIN_CLI_BACKENDS.length} built-in CLI backends (${TCK_SCENARIOS.length} scenarios).`,
    );
    return 0;
  }
  console.error(`compat-manifest.json consistency check failed (${result.errors.length} error(s)):`);
  for (const err of result.errors) {
    console.error(`  - ${err}`);
  }
  return 1;
}

async function cmdUpstream(args: string[]): Promise<number> {
  const target = args.filter(a => !a.startsWith('-'));
  const results = await checkUpstreamVersions({
    ...(target.length ? { backends: target } : {}),
  });
  console.log(formatUpstreamTable(results));
  return 0;
}

interface ParsedRunOptions {
  target: string;
  scenarios?: ScenarioId[];
  bin?: string;
  prevBin?: string;
  pluginDir?: string;
  protocol?: BackendProtocol;
  model?: string;
  live: boolean;
  keep: boolean;
  timeoutSeconds: number;
  writeManifest: boolean;
  exportDriftDir?: string;
  outPath?: string;
}

function parseRunArgs(args: string[]): ParsedRunOptions {
  const target = args[0];
  if (!target || target.startsWith('-')) {
    throw new Error('Missing <backend|all> argument for `run`.');
  }
  let scenarios: ScenarioId[] | undefined;
  let bin: string | undefined;
  let prevBin: string | undefined;
  let pluginDir: string | undefined;
  let protocol: BackendProtocol | undefined;
  let model: string | undefined;
  let live = false;
  let keep = false;
  let timeoutSeconds = 120;
  let writeManifest = false;
  let exportDriftDir: string | undefined;
  let outPath: string | undefined;

  const nextValue = (index: number, flag: string): string => {
    const val = args[index + 1];
    if (!val || val.startsWith('--')) throw new Error(`Flag ${flag} requires a value`);
    return val;
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case '--scenario':
        scenarios = nextValue(i, arg).split(',').map(s => s.trim()).filter(Boolean) as ScenarioId[];
        i += 1;
        break;
      case '--bin':
        bin = nextValue(i, arg);
        i += 1;
        break;
      case '--prev-bin':
        prevBin = nextValue(i, arg);
        i += 1;
        break;
      case '--plugin-dir':
        pluginDir = resolve(nextValue(i, arg));
        i += 1;
        break;
      case '--protocol': {
        const value = nextValue(i, arg) as BackendProtocol;
        if (!VALID_PROTOCOLS.has(value)) {
          throw new Error(`Invalid --protocol "${value}". Expected one of: ${[...VALID_PROTOCOLS].join(', ')}`);
        }
        protocol = value;
        i += 1;
        break;
      }
      case '--model':
        model = nextValue(i, arg);
        i += 1;
        break;
      case '--live':
        live = true;
        break;
      case '--keep':
        keep = true;
        break;
      case '--timeout': {
        const sec = Number(nextValue(i, arg));
        if (!Number.isFinite(sec) || sec <= 0) throw new Error('--timeout must be a positive number');
        timeoutSeconds = sec;
        i += 1;
        break;
      }
      case '--write-manifest':
        writeManifest = true;
        break;
      case '--export-drift':
        exportDriftDir = resolve(nextValue(i, arg));
        i += 1;
        break;
      case '--out':
        outPath = resolve(nextValue(i, arg));
        i += 1;
        break;
      default:
        throw new Error(`Unknown option "${arg}"`);
    }
  }

  if (writeManifest && pluginDir) {
    throw new Error('--write-manifest cannot be used with --plugin-dir (compat-manifest.json tracks built-in CLI backends only).');
  }

  return {
    target,
    scenarios,
    bin,
    prevBin,
    pluginDir,
    protocol,
    model,
    live,
    keep,
    timeoutSeconds,
    writeManifest,
    exportDriftDir,
    outPath,
  };
}

function formatSuiteSummaryTable(report: TckSuiteReport): string {
  const lines: string[] = [
    `\nBackend: ${report.backendId} (Tier ${report.tier}, mode=${report.mode}, version=${report.cliVersion ?? 'unknown'}, leakedTmux=${report.leakedTmux})`,
  ];
  const headers = ['Scenario', 'Status', 'Duration', 'Note'];
  const rows = report.results.map(r => [
    r.id,
    r.verdict.status,
    `${r.durationMs}ms`,
    r.verdict.note ?? '',
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
  const fmt = (cells: readonly string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  lines.push(fmt(headers));
  lines.push(widths.map(w => '-'.repeat(w)).join('  '));
  for (const row of rows) lines.push(fmt(row));
  lines.push(
    `Totals: pass=${report.summary.pass}  fail=${report.summary.fail}  not-applicable=${report.summary['not-applicable']}  not-exercised=${report.summary['not-exercised']}`,
  );
  return lines.join('\n');
}

async function cmdRun(args: string[]): Promise<number> {
  const opts = parseRunArgs(args);
  const specs: BackendCompatSpec[] = opts.target === 'all'
    ? listBackendCompatSpecs()
    : [
      getBackendCompatSpec(
        opts.target,
        opts.pluginDir
          ? {
            pluginDir: opts.pluginDir,
            ...(opts.protocol ? { protocol: opts.protocol } : {}),
            ...(opts.bin ? { command: opts.bin } : {}),
            ...(opts.model ? { model: opts.model } : {}),
          }
          : undefined,
      ),
    ];

  const reports: TckSuiteReport[] = [];
  let hasFailures = false;

  for (const spec of specs) {
    const report = await runTckSuite({
      spec,
      scenarios: opts.scenarios,
      bin: opts.bin,
      prevBin: opts.prevBin,
      model: opts.model,
      live: opts.live,
      keep: opts.keep,
      timeoutSeconds: opts.timeoutSeconds,
    });
    reports.push(report);
    console.log(formatSuiteSummaryTable(report));

    if (report.summary.fail > 0 || report.leakedTmux) {
      hasFailures = true;
    }

    const baseline = extractCommittedVocabulary(spec.id);
    const diff = compareVocabulary(baseline, report.observedVocabulary);
    if (opts.exportDriftDir && (diff.added.length > 0 || report.summary.fail > 0)) {
      const exported = exportRedactedDriftCandidate(
        opts.exportDriftDir,
        spec.id,
        report.cliVersion ?? 'unknown',
        {
          diff,
          failedScenarios: report.results.filter(r => r.verdict.status === 'fail'),
          observedVocabulary: report.observedVocabulary,
        },
      );
      console.log(`Exported redacted drift candidate: ${exported.filePath}`);
    }

    if (opts.writeManifest) {
      if (report.summary.fail > 0 || report.leakedTmux) {
        console.error(
          `Refusing to update compat-manifest.json / testedThrough for "${spec.id}": fail=${report.summary.fail}, leakedTmux=${report.leakedTmux}.`,
        );
      } else {
        const scenariosUpdate: Partial<Record<ScenarioId, ScenarioVerdict>> = {};
        for (const r of report.results) {
          scenariosUpdate[r.id] = r.verdict;
        }
        const current = loadManifest();
        const updated = mergeBackendRun(current, spec.id, {
          tier: report.tier,
          ...(report.cliVersion ? { testedThrough: report.cliVersion } : {}),
          testedAt: new Date().toISOString().slice(0, 10),
          os: report.os,
          mode: report.mode,
          scenarios: scenariosUpdate,
        });
        saveManifest(updated);
        console.log(`Updated compat-manifest.json for "${spec.id}".`);
      }
    }
  }

  if (opts.outPath) {
    writeFileSync(
      opts.outPath,
      `${JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)}\n`,
      'utf8',
    );
    console.log(`Wrote JSON report to ${opts.outPath}`);
  }

  return hasFailures ? 1 : 0;
}

let signalCleanupInstalled = false;
let shuttingDown = false;

function installSignalCleanup(): void {
  if (signalCleanupInstalled) return;
  signalCleanupInstalled = true;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`\nReceived ${signal}; cleaning up active compat sandboxes and mock servers...`);
    void runAllActiveCleanups()
      .catch(() => undefined)
      .finally(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
}

async function main(): Promise<void> {
  installSignalCleanup();
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printUsage();
    process.exit(0);
  }

  let exitCode = 0;
  try {
    switch (subcommand) {
      case 'list':
        cmdList();
        break;
      case 'check-manifest':
        exitCode = cmdCheckManifest();
        break;
      case 'upstream':
        exitCode = await cmdUpstream(argv.slice(1));
        break;
      case 'run':
        exitCode = await cmdRun(argv.slice(1));
        break;
      default:
        console.error(`Unknown subcommand "${subcommand}".`);
        printUsage();
        exitCode = 1;
        break;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  }

  process.exit(exitCode);
}

void main();
