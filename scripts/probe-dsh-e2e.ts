/**
 * Manual real-CLI probe of the DSH backend through the in-process server, read over sync v3.
 *
 *   node --import tsx scripts/probe-dsh-e2e.ts [--profile <name>] [--model <id>] [--prompt <text>]... [--timeout <seconds>] [--keep] [--out report.json]
 *
 * A short conversation with the CLI's default configuration, then the checks of scripts/probe-sync-e2e-lib.ts:
 * seq contiguous and unique per lane, the last answer of every turn delivered, seq unchanged after a
 * server restart, and runs, status and outline consistent with the CLI. Exits 2 when the CLI is missing, or
 * when its default route has no provider key (an environment skip, not a sync failure).
 */
import { probeArgs, requireCli, runConversationProbe } from './probe-sync-e2e-lib.js';

const args = probeArgs();
const executable = process.env.DSH_CLI?.trim() || 'dsh';
requireCli(executable, 'DSH', 'Install the DSH CLI and sign in, or set DSH_CLI.');
await runConversationProbe({
  backend: 'dsh', label: 'DSH', args,
  // DSH's default route needs a provider key of its own; without one every turn fails before the model is asked.
  environment: async (_server, _sessionId, run) => /no API key for provider route/i.test(run?.error ?? '') ? run!.error : undefined,
  prompts: args.prompts ?? [
    'Isolated integration test. Do not use tools. Reply only FIRST_OK.',
    'Run the shell command `ls -a` in the current directory, then reply with how many entries it printed.',
    'Do not use tools. Reply only LAST_OK.',
  ],
});
