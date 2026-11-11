/**
 * Manual real-CLI probe of the Cursor backend through the in-process server, read over sync v3.
 *
 *   node --import tsx scripts/probe-cursor-e2e.ts [--cursor-cli <cursor-cli.json>] [--model <id>] [--prompt <text>]... [--timeout <seconds>] [--keep] [--out report.json]
 *
 * `--cursor-cli` copies a service's Cursor settings (its gateway and key) into the temp state dir; without
 * them a CLI that is not logged in waits at its login screen and no run ends.
 *
 * A short conversation with the CLI's default configuration, then the checks of scripts/probe-sync-e2e-lib.ts:
 * seq contiguous and unique per lane, the last answer of every turn delivered, seq unchanged after a
 * server restart, and runs, status and outline consistent with the CLI. Exits 2 when the CLI is missing.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { probeArgs, requireCli, runConversationProbe } from './probe-sync-e2e-lib.js';

const args = probeArgs();
const executable = process.env.RIFFET_CLI?.trim() || 'cursor-agent';
const settings = args.option('--cursor-cli');
requireCli(executable, 'Cursor', "Install Cursor's CLI (`curl https://cursor.com/install -fsS | bash`) and run `cursor-agent login`, or set RIFFET_CLI.");
await runConversationProbe({
  backend: 'cursor', label: 'Cursor', args, cliPath: executable,
  ...(settings ? { seed: async (stateDir: string) => { await mkdir(stateDir, { recursive: true }); await copyFile(settings, join(stateDir, 'cursor-cli.json')); } } : {}),
  // A CLI that is not logged in to the route it was given waits at its login screen.
  environment: async (server, sessionId) => {
    const terminalId = server.services.store.getSession(sessionId).terminalId;
    const screen = terminalId ? await server.services.terminal.screen(terminalId).catch(() => undefined) : undefined;
    return screen && /Press any key to log in/i.test(screen) ? 'cursor-agent is not logged in (pass --cursor-cli with the service\'s cursor-cli.json, or run `cursor-agent login`)' : undefined;
  },
  prompts: args.prompts ?? [
    'Isolated integration test. Do not use tools. Reply only FIRST_OK.',
    'Run the shell command `ls -a` in the current directory, then reply with how many entries it printed.',
    'Do not use tools. Reply only LAST_OK.',
  ],
});
