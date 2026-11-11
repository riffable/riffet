/**
 * Manual real-CLI probe of the Codex backend through the in-process server, read over sync v3.
 *
 *   node --import tsx scripts/probe-codex-e2e.ts [--model <id>] [--prompt <text>]... [--timeout <seconds>] [--keep] [--out report.json]
 *
 * A short conversation with the CLI's default configuration, then the checks of scripts/probe-sync-e2e-lib.ts:
 * seq contiguous and unique per lane, the last answer of every turn delivered, seq unchanged after a
 * server restart, and runs, status and outline consistent with the CLI. Exits 2 when the CLI is missing.
 */
import { probeArgs, requireCli, runConversationProbe } from './probe-sync-e2e-lib.js';

const args = probeArgs();
const executable = process.env.CODEX_CLI?.trim() || 'codex';
requireCli(executable, 'Codex', 'Install the Codex CLI (`npm i -g @openai/codex`) and sign in, or set CODEX_CLI.');
await runConversationProbe({
  backend: 'codex', label: 'Codex', args,
  prompts: args.prompts ?? [
    'Isolated integration test. Do not use tools. Reply only FIRST_OK.',
    'Run the shell command `ls -a` in the current directory, then reply with how many entries it printed.',
    'Do not use tools. Reply only LAST_OK.',
  ],
});
