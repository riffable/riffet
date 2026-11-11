#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Node resolves the installed symlink to this source, so any working directory works.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist/cli.js');
// Native CLI hooks and MCP entries are written with absolute paths into dist/, and npm may
// delete its npx cache, which would leave them pointing at nothing.
if (/[\\/]_npx[\\/]/.test(root)) console.error('[riffet] 当前从 npx 缓存运行，缓存可能被清理而使已写入的 Hook 和 MCP 路径失效；建议改用 npm i -g riffet 安装。');
const program = new Command()
  .name('riffet')
  .description('Riffet 快捷命令；直接运行 riffet 会启动服务并打开浏览器')
  .addOption(new Option('--state-dir <path>', '会话数据目录').env('RIFFET_STATE_DIR').default(join(homedir(), '.local/share/riffet')))
  .addOption(new Option('--port <port>', '启动端口').env('RIFFET_PORT').default('4337'))
  .addOption(new Option('--host <host>', '监听地址').env('RIFFET_HOST').default('127.0.0.1'))
  .addOption(new Option('--cli <command>', 'Cursor CLI 入口').env('RIFFET_CLI').default(process.env.RIFFET_CLI ?? 'cursor-agent'))
  .option('--auth', '启用访问令牌登录', false)
  .option('--no-auth', '本机免令牌访问（仅限回环地址）')
  .option('--workspace <path>', '启动时添加指定项目')
  .option('--allow-host <hostname>', '允许的附加域名，可重复指定', (value, values) => [...values, value], [])
  .option('--mdns', '在局域网广播 mDNS（默认开启）')
  .option('--no-mdns', '关闭局域网 mDNS 广播')
  .allowExcessArguments(false);

const stateDir = () => resolve(program.opts().stateDir);
function cliArgs(command) {
  const options = program.opts();
  const args = [command, '--state-dir', stateDir()];
  const saved = existsSync(join(stateDir(), 'server-config.json'));
  const restore = (command === 'restart' && (saved || existsSync(join(stateDir(), 'daemon.json')))) || (command === 'start' && saved);
  if (['start', 'serve', 'restart', 'doctor'].includes(command)) {
    for (const key of ['host', 'port', 'cli']) {
      if (!restore || ['cli', 'env'].includes(program.getOptionValueSource(key))) args.push(`--${key}`, options[key]);
    }
    for (const host of options.allowHost) args.push('--allow-host', host);
    if (options.workspace) args.push('--workspace', resolve(options.workspace));
  }
  if (['start', 'serve', 'restart'].includes(command) && program.getOptionValueSource('mdns') === 'cli') args.push(options.mdns ? '--mdns' : '--no-mdns');
  if (['start', 'serve', 'restart', 'status'].includes(command)) args.push('--no-token');
  if (restore) {
    if (program.getOptionValueSource('auth') === 'cli') args.push(options.auth ? '--auth' : '--no-auth');
    else if (['cli', 'env'].includes(program.getOptionValueSource('host')) && !['127.0.0.1', 'localhost', '::1'].includes(options.host.toLowerCase())) args.push('--auth');
  } else if (['start', 'serve', 'restart'].includes(command)) {
    const explicit = program.getOptionValueSource('auth') === 'cli';
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(options.host.toLowerCase());
    args.push((explicit ? options.auth : !loopback) ? '--auth' : '--no-auth');
  }
  return args;
}
function runCli(command, extra = []) {
  if (!existsSync(entry)) throw new Error(`尚未构建工作台。先在 ${root} 执行 pnpm build。`);
  const result = spawnSync(process.execPath, [entry, ...cliArgs(command), ...extra], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? (result.signal === 'SIGINT' ? 130 : 1);
    return false;
  }
  return true;
}
async function runPlugin(args) {
  if (!existsSync(entry)) throw new Error(`尚未构建工作台。先在 ${root} 执行 pnpm build。`);
  // Sources and --out are relative to the caller, not the Riffet checkout. The host CLI owns all
  // plugin subcommands and options; forwarding them also keeps SDK and installed-app behavior equal.
  const options = [...args];
  if (options[0] && !options[0].startsWith('-') && options[0] !== 'pack' && !options.some(value => value === '--state-dir' || value.startsWith('--state-dir='))) options.push('--state-dir', stateDir());
  const child = spawn(process.execPath, [entry, 'plugin', ...options], { stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); done(); });
    });
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
}
function daemonRecord() {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'daemon.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取服务器地址，请运行 riffet status 检查状态。');
  }
}
function webUrl() {
  const record = daemonRecord();
  let host = record?.host ?? program.opts().host, port = record?.port ?? program.opts().port;
  if (['0.0.0.0', '::'].includes(host)) host = '127.0.0.1';
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
}
function accessToken() {
  const file = join(stateDir(), 'access-token');
  try {
    const value = readFileSync(file, 'utf8').trim();
    if (value) return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`无法读取访问令牌：${file}（${error.message}）`);
  }
  throw new Error(`尚未生成访问令牌：${file}。先运行 riffet start。`);
}
// Only the secret goes to stdout, so `riffet token | pbcopy` copies nothing else.
function printLogin(withUrl) {
  const token = accessToken();
  const record = daemonRecord();
  if (!record) console.error('[riffet] 服务器未运行；令牌在下次启动后仍然有效。');
  else if (record.args?.includes('--no-auth')) console.error('[riffet] 当前服务器为本机免令牌模式，本机浏览器无需令牌；要启用令牌登录请运行 riffet restart --auth。');
  console.log(withUrl ? `${webUrl()}?token=${encodeURIComponent(token)}` : token);
}
function openWeb() {
  if (!runCli('start')) return;
  const url = webUrl();
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (!opener) throw new Error(`服务已启动，请在浏览器打开 ${url}`);
  const result = spawnSync(opener, [url], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`服务已启动，但浏览器未打开。请手动访问 ${url}`);
}
async function logs(options) {
  const file = join(stateDir(), 'server.log');
  if (!existsSync(file)) {
    console.log(`暂无服务日志：${file}`);
    return;
  }
  const args = ['-n', String(options.lines)];
  if (options.follow) args.push('-f');
  args.push(file);
  // Older server logs may contain login links. Redact their token in both modes.
  const child = spawn('tail', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => console.log(line.replace(/([?&]token=)[^&#\s]+/g, '$1[REDACTED]')));
  const interrupt = () => child.kill('SIGINT');
  process.once('SIGINT', interrupt);
  try {
    await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code && signal !== 'SIGINT') process.exitCode = code;
        done();
      });
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    reader.close();
  }
}

program.command('open', { isDefault: true }).description('启动后台服务并打开页面（默认操作）').action(openWeb);
program.command('start').alias('up').description('启动后台服务').action(() => { runCli('start'); });
program.command('status').description('查看运行状态和地址').action(() => { runCli('status'); });
program.command('pair').description('显示局域网地址、一次性配对码和二维码')
  .option('--json', '输出含临时配对码的敏感 JSON，请勿公开分享')
  .option('--url <url>', '客户端访问这台服务器用的地址（VPN 主机名、SSH 隧道或 HTTPS 入口）')
  .action(options => { runCli('pair', [...(options.json ? ['--json'] : []), ...(options.url ? ['--url', options.url] : [])]); });
program.command('stop').alias('down').description('关闭 Web 服务，保留数据及原生终端').action(() => { runCli('stop'); });
program.command('restart').description('按上次启动参数重启服务').action(() => { runCli('restart'); });
program.command('update').description('检查发布版本，或更新当前源码安装（npm 安装只给出升级命令）')
  .option('--check', '只检查更新，不修改源码或重启服务')
  .option('--json', '输出 JSON 检查结果（需 --check）')
  .option('--app', '更新此 clone 构建的 macOS App')
  .option('--configuration <configuration>', '选择要更新的 App：Debug 或 Release（需 --app）')
  .action(options => {
    runCli('update', [...(options.check ? ['--check'] : []), ...(options.json ? ['--json'] : []), ...(options.app ? ['--app'] : []), ...(options.configuration ? ['--configuration', options.configuration] : [])]);
  });
program.command('url').description('显示工作台地址').action(() => console.log(webUrl()));
program.command('token').description('显示访问令牌（登录页输入它）').action(() => printLogin(false));
program.command('login-url').description('显示带令牌的登录链接').action(() => printLogin(true));
program.command('logs').description('查看最近的服务日志')
  .option('-f, --follow', '持续查看；Ctrl+C 退出日志，不关闭服务')
  .option('-n, --lines <count>', '显示多少行', value => {
    const count = Number(value);
    if (!Number.isInteger(count) || count < 1 || count > 10000) throw new InvalidArgumentError('行数必须是 1–10000 的整数');
    return count;
  }, 100)
  .action(logs);
program.command('doctor').description('检查 Node、tmux、各后端 CLI、端口和数据目录')
  .option('--json', '输出完整 JSON 报告')
  .action(options => { runCli('doctor', options.json ? ['--json'] : []); });
program.command('serve').description('前台运行；Ctrl+C 关闭 Web 服务').action(() => { runCli('serve'); });
program.command('plugin [args...]').description('开发、打包与管理插件').allowUnknownOption().helpOption(false).action(runPlugin);
program.addHelpText('after', `
常用示例：
  riffet                         启动并打开页面
  riffet status                  查看状态
  riffet start --host 0.0.0.0    启动带认证的局域网服务
  riffet pair                    显示配对码、二维码和连接地址
  riffet stop                    关闭服务
  riffet restart                 重启服务
  riffet update --check          检查发布版本
  riffet update                  更新源码、构建并恢复服务
  riffet logs -f                 持续查看日志
  riffet start --workspace .     添加当前项目并启动
  riffet token                   显示访问令牌
  riffet login-url               显示带令牌的登录链接
  riffet doctor                  检查运行环境

默认：127.0.0.1:4337，cursor-agent，~/.local/share/riffet，本机免令牌。
需要令牌登录可加 --auth；显式指定局域网监听地址时默认启用认证。登录页要求的令牌用 riffet token 查看。
start / restart 沿用保存的配置；显式局域网地址默认启用认证，--auth / --no-auth 优先。
restart 的显式 --host / --port / --cli 参数覆盖上次配置；配对用 riffet pair，查询状态不会生成配对码。
`);
program.parseAsync(process.argv).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
