import { Command, CommanderError, Option } from 'commander';
import { applyProcessEnvironment } from '../environment.js';
import { unsupportedNodeMessage } from '../doctor.js';
import { restoreBackup } from '../system.js';
import { SERVER_VERSION } from '../version.js';
import { packSource, type ArchiveFormat } from '../../../../packages/plugin-api/src/tooling.js';
import { DEFAULT_STATE_DIR, accessToken, active, readDaemon, serverUrl, stateDir } from './context.js';
import { complete, completion } from './completion.js';
import { doctor } from './doctor.js';
import { configure, open, resolveLaunchOptions, restart, savedLaunchArgs, serve, start, stop, type LaunchOptions } from './launch.js';
import { logs } from './logs.js';
import { pair } from './pair.js';
import { linkInvite, linkJoin, linkList, linkRemove, linkRename, linkSelfName, linkSsh, linkStdio } from './link.js';
import { sshList, sshRun } from './ssh.js';
import { buildPluginIndex, deletePluginData, developPlugin, inspectPlugin, installPlugin, listPlugins, manageSources, readPluginLogs, recoverPlugins, selectPlugin, uninstallPlugin, unlinkDevelopmentPlugin, updatePlugins, type PluginCliContext } from './plugins.js';
import { installService, serviceStatus, uninstallService } from './service.js';
import { list, resume } from './sessions.js';
import { status } from './status.js';
import { update } from './update.js';
import { promptForUpdate, refreshUpdateCheck, relaunchAfterUpdate } from './update-notice.js';
import { Cancelled, CliError, UsageError, err, interactive, out, printError, printLines, success, suggest, warning } from './ui.js';

// Captured before the environment is normalized: `update` fetches with the user's own Git agent.
const updateSshAuthSocket = process.env.SSH_AUTH_SOCK;

class UpdateRelaunched extends Error {
  constructor(readonly exitCode: number) { super('Updated'); }
}

type Global = { stateDir: string };
/** The global options merged into a command's own. */
const options = <T>(command: Command): T & Global => command.optsWithGlobals() as T & Global;
const launchOptions = (command: Command) => options<LaunchOptions>(command);

/** What `doctor` and `service install` launch with: the saved launch, or the defaults. */
function savedOrDefaults(command: Command): LaunchOptions {
  const defaults = configure(new Command()).parse([], { from: 'user' }).opts() as LaunchOptions;
  const own = options<Partial<LaunchOptions>>(command);
  const merged = { ...defaults, ...Object.fromEntries(Object.entries(own).filter(([, value]) => value !== undefined)), stateDir: own.stateDir } as LaunchOptions;
  return resolveLaunchOptions(merged, command, savedLaunchArgs(stateDir(merged.stateDir)));
}

const EXAMPLES = (lines: Array<[string, string]>) => () => {
  const width = Math.max(...lines.map(([command]) => command.length));
  return `\n${out.bold('Examples:')}\n${lines.map(([command, text]) => `  ${out.cmd(command.padEnd(width))}  ${out.dim(text)}`).join('\n')}\n`;
};

export function buildProgram(relaunchArgs?: string[]): Command {
  const program = new Command()
    .name('riffet')
    .description('Run Riffet, the workbench for Cursor, Codex, Claude Code and other agent CLIs')
    .version(SERVER_VERSION, '-v, --version', 'print the version')
    .helpOption('-h, --help', 'show help')
    .addOption(new Option('--state-dir <path>', 'where conversations and settings live').env('RIFFET_STATE_DIR').default(DEFAULT_STATE_DIR, '~/.local/share/riffet'))
    .option('--no-color', 'plain output without colors')
    .showSuggestionAfterError(true)
    .helpCommand(false)
    .configureHelp({
      sortSubcommands: false,
      // `start, up <arg>`: aliases read as words, and `[options]` after every name is noise.
      subcommandTerm: command => [command.name(), ...command.aliases()].join(', ') + command.registeredArguments.map(argument => ` ${argument.required ? `<${argument.name()}${argument.variadic ? '...' : ''}>` : `[${argument.name()}${argument.variadic ? '...' : ''}]`}`).join(''),
      showGlobalOptions: true,
      styleTitle: text => out.bold(text),
      styleCommandText: text => out.bold(text),
      styleSubcommandText: text => out.accent(text),
      styleOptionText: text => text,
      styleArgumentText: text => out.dim(text),
      styleDescriptionText: text => text,
    })
    .configureOutput({
      outputError: (text, write) => write(text.replace(/^error: /, `${err.fail('✗')} `).replace(/^\(Did you mean (.+)\?\)$/m, (_line, word: string) => `  ${err.dim('→')} Did you mean ${err.cmd(word)}?`)),
    })
    .exitOverride();
  program.hook('preAction', async (_root, action) => {
    const dir = (action.optsWithGlobals() as Global).stateDir;
    // One environment for every entry point; the state directory caches the last good PATH.
    await applyProcessEnvironment(dir ? { stateDir: stateDir(dir) } : {});
    if (action.name() === 'update' && updateSshAuthSocket) process.env.SSH_AUTH_SOCK = updateSshAuthSocket;
    const name = action.name();
    if (relaunchArgs && (name === 'start' || name === 'resume' || (name === 'open' && !action.args[0]))) {
      const resolved = stateDir(dir);
      if (await promptForUpdate(resolved, { requireActive: name === 'resume' })) {
        if (updateSshAuthSocket) process.env.SSH_AUTH_SOCK = updateSshAuthSocket;
        await update({ stateDir: resolved });
        throw new UpdateRelaunched(relaunchAfterUpdate(relaunchArgs));
      }
    }
  });

  // ---- Server
  program.commandsGroup('Server:');
  const openCommand = configure(program.command('open', { isDefault: true }).description('start if needed and open in the browser (default)'))
    .allowExcessArguments()
    .action(async (_opts, command: Command) => {
      // `riffet stauts` lands here as the default command's argument: it is a mistyped command.
      const stray = command.args[0];
      if (stray) {
        const guess = suggest(stray, program.commands.filter(item => !(item as unknown as { _hidden?: boolean })._hidden).flatMap(item => [item.name(), ...item.aliases()]));
        throw new UsageError(`Unknown command ${stray}`, guess ? [`Did you mean \`riffet ${guess}\`?`] : ['riffet --help']);
      }
      await open(launchOptions(command), command);
    });
  void openCommand;
  configure(program.command('start').alias('up').description('start in the background'))
    .addHelpText('after', EXAMPLES([['riffet start', 'this computer only, no token'], ['riffet start --host 0.0.0.0', 'reachable from your network, token required'], ['riffet start --workspace .', 'also add this directory as a project']]))
    .action(async (_opts, command: Command) => { const opts = launchOptions(command); await start(resolveLaunchOptions(opts, command, savedLaunchArgs(stateDir(opts.stateDir)))); });
  program.command('stop').alias('down').description('stop the server; terminals and agent sessions keep running')
    .action(async (_opts, command: Command) => { await stop(options(command)); });
  configure(program.command('restart').description('restart with the last launch settings'))
    .option('--wait-idle <seconds>', 'wait this long for running turns to finish (default 180)')
    .option('--force', 'restart now, interrupting running turns')
    .addHelpText('after', EXAMPLES([['riffet restart', 'same address and settings as before'], ['riffet restart --host 0.0.0.0', 'open it to your network'], ['riffet restart --force', 'do not wait for running turns']]))
    .action(async (_opts, command: Command) => { await restart(options(command), command); });
  program.command('status').description('show whether Riffet runs, where, and what it is doing')
    .option('--json', 'machine-readable output')
    .addOption(new Option('--no-token').hideHelp())
    .action(async (_opts, command: Command) => { await status(options(command)); });
  program.command('logs').description('show the server log')
    .option('-f, --follow', 'keep printing new lines')
    .option('-n, --lines <count>', 'how many lines to show (default 100)')
    .option('--since <time>', 'only lines after 10m, 2h, 1d or a date')
    .option('--scope <names>', 'only these comma-separated scopes, such as codex,claude')
    .option('--json', 'one JSON object per line')
    .addHelpText('after', EXAMPLES([['riffet logs -f', 'follow the log'], ['riffet logs --since 1h --scope codex', 'the last hour of one scope']]))
    .action(async (_opts, command: Command) => { await logs(options(command)); });
  configure(program.command('serve').description('run in the foreground; Ctrl+C stops it'))
    .action(async (_opts, command: Command) => { await serve(resolveLaunchOptions(launchOptions(command), command)); });

  // ---- Connect
  program.commandsGroup('Connect:');
  program.command('pair').description('show a QR code and a one-time code for a phone or another computer')
    .option('--url <url>', 'the address devices reach this server by (VPN, tunnel or HTTPS proxy)')
    .option('--json', 'machine-readable output, including the code')
    .action(async (_opts, command: Command) => { await pair(options(command)); });
  const link = program.command('link').description('link with another Riffet server, so either one\'s workbench shows both');
  link.command('invite').description('make a one-time link string for another server to join')
    .option('--url <url>', 'the address the other server reaches this one by')
    .option('--allow-in', 'let the other server operate this one')
    .option('--json', 'machine-readable output')
    .action(async (_opts, command: Command) => { await linkInvite(options(command)); });
  link.command('join <link>').description('join the server that made a link string')
    .option('--allow-in', 'let the other server operate this one')
    .option('--json', 'machine-readable output')
    .action(async (value: string, _opts, command: Command) => { await linkJoin({ ...options(command), link: value }); });
  link.command('ssh <destination>').description('link with Riffet on a machine you reach over SSH; the tunnel runs over SSH too')
    .option('--allow-in', 'let the other server operate this one')
    .option('--remote-command <path>', 'how to run riffet on the other machine (default: riffet)')
    .option('--json', 'machine-readable output')
    .action(async (destination: string, _opts, command: Command) => { await linkSsh({ ...options(command), host: destination }); });
  link.command('list').description('linked servers and their state')
    .option('--json', 'machine-readable output')
    .action(async (_opts, command: Command) => { await linkList(options(command)); });
  link.command('remove <server>').description('end a link on both servers')
    .action(async (server: string, _opts, command: Command) => { await linkRemove({ ...options(command), server }); });
  link.command('rename <server>').description('set a linked server\'s local display name, alias or note')
    .option('--name <text>', 'local display name (empty restores the peer\'s own name)')
    .option('--alias <alias>', 'short unique alias (lowercase letters, digits, . _ -)')
    .option('--note <text>', 'short local note describing what this server is for')
    .option('--json', 'machine-readable output')
    .action(async (server: string, _opts, command: Command) => { await linkRename({ ...options(command), server }); });
  link.command('self-name <name>').description('set this server\'s own name as shown to linked servers')
    .option('--json', 'machine-readable output')
    .action(async (name: string, _opts, command: Command) => { await linkSelfName({ ...options(command), name }); });
  link.command('stdio', { hidden: true }).option('--role <role>').option('--join <invite>')
    .action(async (_opts, command: Command) => { await linkStdio(options(command)); });
  program.command('ssh <target> [command...]').description('open a shell or run a command on a linked server through its tunnel (use `riffet ssh ls` to list servers)')
    .option('--cwd <path>', 'working directory on the target server')
    .option('--timeout <seconds>', 'command timeout in seconds (non-interactive only)')
    .option('--json', 'machine-readable output')
    .addHelpText('after', EXAMPLES([['riffet ssh ls', 'list linked servers and their aliases'], ['riffet ssh mac', 'open an interactive shell on mac'], ['riffet ssh mac -- uname -a', 'run one command on mac']]))
    .action(async (target: string, commandArgs: string[], _opts, command: Command) => {
      const opts = options<{ cwd?: string; timeout?: string; json?: boolean }>(command);
      if ((target === 'ls' || target === 'list') && commandArgs.length === 0) { await sshList(opts); return; }
      process.exitCode = await sshRun({ ...opts, target, command: commandArgs });
    });
  program.command('url').description('print the address of the workbench')
    .option('--login', 'include the access token, for signing in once')
    .action((_opts, command: Command) => {
      const { stateDir: dir, login } = options<{ login?: boolean }>(command);
      const resolved = stateDir(dir);
      const record = readDaemon(resolved);
      const address = serverUrl(record ?? { host: savedOrDefaults(command).host, port: Number(savedOrDefaults(command).port) }) + '/';
      // Only the address goes to stdout, so `riffet url | pbcopy` copies nothing else.
      process.stdout.write((login ? `${address}?token=${encodeURIComponent(accessToken(resolved))}` : address) + '\n');
      if (login && process.stdout.isTTY) warning('This link signs anyone in; share it only with yourself');
    });
  program.command('token').description('print the access token')
    .action(async (_opts, command: Command) => {
      const dir = stateDir(options(command).stateDir);
      process.stdout.write(accessToken(dir) + '\n');
      const record = await active(dir);
      if (!record) warning('Riffet is not running; the token works once it starts');
      else if (record.args.includes('--no-auth') && process.stderr.isTTY) process.stderr.write(`${err.dim('·')} This computer needs no token; other devices sign in with it after ${err.cmd('riffet restart --host 0.0.0.0')}\n`);
    });

  // ---- Conversations
  program.commandsGroup('Conversations:');
  program.command('ls').description('list conversations, this directory\'s project first')
    .option('-a, --all', 'every project')
    .option('-n, --limit <count>', 'how many to show (default 20)')
    .option('--json', 'machine-readable output')
    .action(async (_opts, command: Command) => { await list(options(command)); });
  program.command('resume [conversation]').description('continue a conversation in this terminal; Riffet follows it until the CLI exits')
    .option('-a, --all', 'choose among every project')
    .addHelpText('after', EXAMPLES([['riffet resume', 'pick from this project'], ['riffet resume 3f9c2a1b', 'by id'], ['riffet resume "login bug"', 'by title']]))
    .action(async (target: string | undefined, _opts, command: Command) => { process.exitCode = await resume(options(command), target); });

  // ---- Maintenance
  program.commandsGroup('Maintenance:');
  program.command('doctor').description('check Node, tmux, every agent CLI, the port and the state directory')
    .option('--json', 'the full environment and capability report')
    .option('--compact', 'compact databases and deduplicate checkpoints; Riffet must be stopped')
    .action(async (_opts, command: Command) => { const launch = savedOrDefaults(command); await doctor({ ...options<{ json?: boolean; compact?: boolean }>(command), host: launch.host, port: launch.port, cli: launch.cli }); });
  program.command('update').description('check for and install a newer release')
    .option('--check', 'only check; change nothing')
    .option('--json', 'machine-readable check result (with --check)')
    .option('--app', 'update the macOS App built from this checkout')
    .option('--configuration <name>', 'which App to update: Debug or Release (with --app)')
    .option('--wait-idle <seconds>', 'wait this long for running turns to finish (default 180)')
    .option('--force', 'restart now, interrupting running turns')
    .action(async (_opts, command: Command) => { await update(options(command)); });
  const service = program.command('service').description('run Riffet at login (launchd on macOS, systemd on Linux)');
  configure(service.command('install').description('install and start the login service'))
    .option('--refresh-environment', 'take a new snapshot of PATH and the toolchain variables')
    .action(async (_opts, command: Command) => { await installService({ ...savedOrDefaults(command), refreshEnvironment: options<{ refreshEnvironment?: boolean }>(command).refreshEnvironment }); });
  service.command('uninstall').description('remove the login service; data is kept').action(async () => { await uninstallService(); });
  service.command('status').description('show whether the login service is installed and running').action(async (_opts, command: Command) => { await serviceStatus(options(command)); });
  program.command('restore').description('restore a verified backup into an empty state directory')
    .requiredOption('--backup <path>', 'backup directory')
    .addHelpText('after', EXAMPLES([['riffet restore --backup ~/Backups/riffet-2026-11-01 --state-dir ~/riffet-restored', 'the destination must be empty']]))
    .action(async (_opts, command: Command) => {
      const { backup, stateDir: dir } = options<{ backup: string }>(command);
      const result = await restoreBackup(backup, dir);
      success(`Restored ${result.files} files to ${result.path}`);
    });

  // ---- Plugins
  program.commandsGroup('Plugins:');
  plugins(program);

  // ---- Shell
  program.commandsGroup('Shell:');
  program.command('completion [shell]').description('tab completion for zsh, bash or fish')
    .action((shell: string | undefined) => completion(shell));
  program.command('__complete', { hidden: true }).argument('[words...]').allowUnknownOption().helpOption(false)
    .action(async (words: string[], _opts, command: Command) => { await complete(program, words, stateDir(options(command).stateDir)); });
  program.command('__update-check', { hidden: true }).action(async (_opts, command: Command) => { await refreshUpdateCheck(stateDir(options(command).stateDir)); });

  program.addHelpText('after', EXAMPLES([
    ['riffet', 'start if needed and open the browser'],
    ['riffet status', 'address, access and running conversations'],
    ['riffet pair', 'connect a phone'],
    ['riffet resume', 'continue a conversation in this terminal'],
    ['riffet logs -f', 'follow the server log'],
  ]));
  return program;
}

function plugins(program: Command): void {
  const plugin = program.command('plugin').description('build, install and manage plugin packages');
  const context = async (command: Command): Promise<PluginCliContext> => {
    const dir = stateDir(options(command).stateDir);
    const daemon = await active(dir);
    return { stateDir: dir, ...(daemon ? { daemon } : {}), token: () => accessToken(dir) };
  };
  const collect = (value: string, previous: string[]) => [...previous, value];
  // Asked in a terminal; elsewhere --yes or --grant decides.
  const confirm = async (id: string, version: string, capabilities: string[]) => {
    if (!interactive()) return false;
    const { confirm: ask, isCancel } = await import('@clack/prompts');
    const answer = await ask({ message: `${id} ${version} asks for ${capabilities.join(', ') || 'nothing'}. Grant it?`, initialValue: false, output: process.stderr });
    if (isCancel(answer)) throw new Cancelled();
    return answer === true;
  };
  plugin.commandsGroup('Develop:');
  plugin.command('dev [directory]').description('build, link and rebuild a local plugin on every change')
    .option('--entry <name=source>', 'an additional server entry; repeatable', collect, [])
    .action(async (directory = '.', opts: { entry: string[] }, command: Command) => {
      const watcher = await developPlugin(() => context(command), directory, message => process.stdout.write(`${out.dim('·')} ${message}\n`), { entries: opts.entry });
      process.stderr.write(`${err.dim('Watching for changes · Ctrl+C stops')}\n`);
      await new Promise<void>(done => {
        const close = () => { process.off('SIGINT', close); process.off('SIGTERM', close); watcher.close(); done(); };
        process.once('SIGINT', close); process.once('SIGTERM', close);
      });
    });
  plugin.command('pack [directory]').description('build, validate and archive a plugin')
    .option('--format <format>', 'tgz, tar.gz, zip or tar')
    .option('--out <path>', 'archive path')
    .option('--entry <name=source>', 'an additional server entry; repeatable', collect, [])
    .action(async (directory = '.', opts: { format?: string; out?: string; entry: string[] }) => {
      if (opts.format && !['tgz', 'tar.gz', 'zip', 'tar'].includes(opts.format)) throw new UsageError('--format takes tgz, tar.gz, zip or tar');
      const packed = await packSource(directory, { format: (opts.format === 'tar.gz' ? 'tgz' : opts.format) as ArchiveFormat | undefined, out: opts.out, entries: opts.entry });
      for (const message of packed.warnings) warning(message);
      // The path and integrity on stdout, for scripts.
      printLines([packed.file, packed.integrity]);
    });
  plugin.command('unlink <id>').description('stop a development plugin and remove its link')
    .action(async (id: string, _opts, command: Command) => printLines(await unlinkDevelopmentPlugin(await context(command), id)));
  plugin.command('index').description('publish plugins').command('build <registry-dir>').description('build an index others can add as a source')
    .requiredOption('--out <dir>', 'output directory')
    .option('--name <text>', 'the name the index shows')
    .option('--published <url>', 'the index already published there (https URL or "none"); its releases are kept')
    .action(async (registry: string, opts: { out: string; name?: string; published?: string }) => printLines(await buildPluginIndex(registry, opts)));

  plugin.commandsGroup('Install:');
  const grantOptions = (command: Command) => command
    .option('--grant <capabilities>', 'comma-separated capabilities to grant; must equal what the package asks for')
    .option('-y, --yes', 'grant what the package asks for')
    .option('--trusted', 'run its server code with Riffet\'s full permissions');
  grantOptions(plugin.command('install <path|id>').description('install an archive, a directory or <id>[@version] from a source'))
    .option('--from <source>', 'the source to install <id> from')
    .action(async (target: string, opts: { grant?: string; yes?: boolean; trusted?: boolean; from?: string }, command: Command) => printLines(await installPlugin(await context(command), target, { ...opts, confirm })));
  grantOptions(plugin.command('update [ids...]').description('install the newest compatible release from each package\'s source'))
    .action(async (ids: string[], opts: { grant?: string; yes?: boolean; trusted?: boolean }, command: Command) => printLines(await updatePlugins(await context(command), ids, { ...opts, confirm })));
  plugin.command('uninstall <id> [version]').description('remove a plugin or one version; settings and data are kept')
    .option('--source <source>', 'installed or development, when both have this id')
    .option('--path <path>', 'the development package directory')
    .action(async (id: string, version: string | undefined, opts: { source?: 'installed' | 'development'; path?: string }, command: Command) => printLines(await uninstallPlugin(await context(command), id, version, opts)));
  plugin.command('select <id> <version>').description('run another installed version')
    .action(async (id: string, version: string, _opts, command: Command) => printLines(await selectPlugin(await context(command), id, version)));
  const sources = plugin.command('source').description('the plugin indexes this server reads');
  sources.command('list').description('list sources').action(async (_opts, command: Command) => printLines(await manageSources(await context(command), 'list')));
  sources.command('add <url>').description('add an index by its address').action(async (url: string, _opts, command: Command) => printLines(await manageSources(await context(command), 'add', url)));
  sources.command('remove <id|url>').description('remove a source; installed packages are kept').action(async (id: string, _opts, command: Command) => printLines(await manageSources(await context(command), 'remove', id)));
  sources.command('enable <id>').description('turn a source on').action(async (id: string, _opts, command: Command) => printLines(await manageSources(await context(command), 'enable', id)));
  sources.command('disable <id>').description('turn a source off').action(async (id: string, _opts, command: Command) => printLines(await manageSources(await context(command), 'disable', id)));

  plugin.commandsGroup('Inspect:');
  plugin.command('list').description('installed packages and their versions')
    .action(async (_opts, command: Command) => printLines(await listPlugins(await context(command))));
  plugin.command('logs <id>').description('recent logs, without starting the plugin')
    .option('-n, --limit <count>', 'entries to show, 1–256 (default 100)', '100')
    .action(async (id: string, opts: { limit: string }, command: Command) => printLines(await readPluginLogs(await context(command), id, { limit: Number(opts.limit) })));
  plugin.command('diagnostics <id>').description('run a plugin\'s diagnostics')
    .action(async (id: string, _opts, command: Command) => printLines(await inspectPlugin(await context(command), id, 'diagnostics')));
  plugin.command('reload <id>').description('reload one plugin')
    .action(async (id: string, _opts, command: Command) => printLines(await inspectPlugin(await context(command), id, 'reload')));
  plugin.command('recovery <on|off>').description('pause every external plugin, or undo that')
    .action(async (mode: string, _opts, command: Command) => printLines(await recoverPlugins(await context(command), mode)));
  plugin.command('delete-data <id>').description('delete a package\'s data and backups; cannot be undone')
    .action(async (id: string, _opts, command: Command) => printLines(await deletePluginData(await context(command), id)));
}

export async function main(argv = process.argv): Promise<void> {
  if (argv.includes('--no-color')) { process.env.NO_COLOR = '1'; delete process.env.FORCE_COLOR; }
  // `riffet logs | head` closes the pipe early; that is the reader being done, not an error.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', error => { if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0); throw error; });
  const unsupported = unsupportedNodeMessage();
  if (unsupported) {
    process.stderr.write(`✗ ${unsupported.message}\n  → ${unsupported.hint}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    await buildProgram(argv.slice(2)).parseAsync(argv);
  } catch (error) {
    if (error instanceof UpdateRelaunched) {
      process.exitCode = error.exitCode;
      return;
    }
    if (error instanceof CommanderError) {
      // Help and version end here too, with their own code.
      process.exitCode = error.exitCode === 0 ? 0 : 2;
      return;
    }
    process.exitCode = printError(error);
  }
}
