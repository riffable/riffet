import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BuildInfo, ReleaseTag } from '@contracts';
import { runProcess } from './git/exec.js';
import { satisfiesMinimum } from './doctor.js';
import { checkForUpdates, compareReleaseTags, fetchRelease, gitEnvironment, readSourceInfo } from './update.js';

export interface UpdateLifecycle {
  /** Runs after all remote/toolchain checks, before changing dependencies or source. */
  stop(): Promise<void>;
  /** Restores the original launcher and verifies the new running build. */
  restore(release: ReleaseTag): Promise<void>;
  recoveryCommand: string;
}

interface AppInstallation {
  path: string;
  configuration: 'Debug' | 'Release';
  build: BuildInfo;
}

/** Shell quoting is only for the human-readable recovery instructions, never process execution. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function readAppInstallation(root: string, selected?: string): AppInstallation {
  if (selected !== undefined && selected !== 'Debug' && selected !== 'Release') throw new Error('--configuration 只接受 Debug 或 Release。');
  const installed: AppInstallation[] = [];
  for (const configuration of ['Release', 'Debug'] as const) {
    if (selected && selected !== configuration) continue;
    const path = join(root, 'apps/macos/build', configuration, 'Riffet.app');
    try {
      const info = JSON.parse(readFileSync(join(path, 'Contents/Resources/RiffetBuildInfo.json'), 'utf8')) as { build?: BuildInfo; sourceRoot?: string; buildConfiguration?: string };
      if (info.sourceRoot && realpathSync(info.sourceRoot) === realpathSync(root) && info.build && info.buildConfiguration === configuration) {
        installed.push({ path, configuration, build: info.build });
      }
    } catch { /* An old app must be rebuilt once to record its source and version. */ }
  }
  if (installed.length === 1) return installed[0];
  if (installed.length > 1) throw new Error('此 clone 有 Debug 和 Release 两个 App，请用 --configuration Debug 或 Release 选择要更新的 App。');
  throw new Error('未找到此 clone 构建的 App 版本记录。请先在 apps/macos 执行 ./scripts/build.sh debug 或 release 构建一次。');
}

async function assertAppStopped(root: string, app: AppInstallation): Promise<void> {
  const result = await runProcess('ps', ['-axo', 'pid=,command='], { cwd: root, maxOutputBytes: 4 * 1024 * 1024 });
  if (result.code !== 0 || result.timedOut || result.truncated) throw new Error('无法检查 App 进程，尚未修改源码。');
  const target = realpathSync(app.path);
  const usesApp = result.stdout.split('\n').some(line => {
    if (line.includes(join(app.path, 'Contents/MacOS/Riffet')) || line.includes(join(app.path, 'Contents/Resources/server/'))) return true;
    // ps preserves argv aliases and does not retain argument boundaries. Try each absolute path
    // boundary before the bundle suffix, including paths with spaces and symlinked clone roots.
    for (const marker of line.matchAll(/\/Contents\/(?:MacOS\/Riffet(?=\s|$)|Resources\/server\/)/g)) {
      const prefix = line.slice(0, marker.index);
      for (const start of prefix.matchAll(/(?:^|\s|["'])(\/)/g)) {
        const candidate = prefix.slice(start.index + start[0].length - 1);
        try { if (realpathSync(candidate) === target) return true; } catch { /* Not an argv path. */ }
      }
    }
    return false;
  });
  if (usesApp) {
    throw new Error('请先在 App 的服务设置中停止托管服务，再退出此 App，随后重新执行 riffet update --app。');
  }
}

/** One checkout is shared by its source, dependencies and build products. */
export function claimUpdate(root: string): () => void {
  const directory = join(root, '.riffet');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'update.lock');
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return () => { try { if (readFileSync(path, 'utf8').split('\n')[0] === String(process.pid)) unlinkSync(path); } catch {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Never unlink a stale lock here: a competing updater may already have replaced it.
    throw new Error(`此 clone 已有更新进程或遗留更新锁。请先确认没有更新进程运行，再手动检查 ${path}。`);
  }
}

/** A completed build may be started while its updater still holds the checkout lock. */
export function assertSourceStartAllowed(root: string): void {
  try {
    const lock = readFileSync(join(root, '.riffet/update.lock'), 'utf8');
    const ready = /^([1-9]\d*)\nready$/.exec(lock);
    if (ready && Number.isSafeInteger(Number(ready[1]))) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('此 clone 正在更新源码或构建，暂时不能启动服务；请等待更新完成。');
}

/** Catch a server using this clone even when it uses a different state directory. */
async function assertSourceProcessesStopped(root: string, allowedPid?: number): Promise<void> {
  const result = await runProcess('ps', ['-axo', 'pid=,command='], { cwd: root, maxOutputBytes: 4 * 1024 * 1024 });
  if (result.code !== 0 || result.timedOut || result.truncated) throw new Error('无法核对同一 clone 的运行进程，尚未修改源码。');
  const entries = [join(root, 'dist/cli.js'), join(root, 'apps/server/src/cli.ts')];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || pid === allowedPid) continue;
    const command = match[2];
    let usesSource = entries.some(entry => command.includes(entry));
    if (!usesSource && /(?:dist\/cli\.js|apps\/server\/src\/cli\.ts)(?:\s|$)/.test(command)) {
      // ps does not expose argv boundaries portably; inspect cwd for relative CLI invocations.
      const relative = /(?:^|\s)([^\s]*(?:dist\/cli\.js|apps\/server\/src\/cli\.ts))(?=\s|$)/.exec(command)?.[1];
      if (relative) {
        let cwd: string | undefined;
        try {
          if (relative.startsWith('/')) cwd = '/';
          else if (process.platform === 'linux') cwd = realpathSync(`/proc/${pid}/cwd`);
          else if (process.platform === 'darwin') {
            const files = await runProcess('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { cwd: root });
            cwd = files.stdout.split('\n').find(value => value.startsWith('n'))?.slice(1);
          }
          if (!cwd) throw new Error('missing cwd');
          usesSource = entries.includes(realpathSync(resolve(cwd, relative)));
        } catch { throw new Error(`无法核对 CLI 进程 ${pid} 的源码位置，请先停止相关 Riffet 实例。`); }
      }
    }
    if (usesSource) throw new Error(`同一 clone 仍被进程 ${pid} 使用，请先停止其它状态目录的服务或 App，再更新。`);
  }
}

function cleanOutput(value: string): string {
  return value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|access_token|private_token)=)[^\s&]+/gi, '$1[redacted]');
}

/** Called by a local CLI, so it can outlive the server being stopped and rebuilt. */
export async function runSourceUpdate(options: {
  root: string;
  current: BuildInfo;
  app?: boolean;
  configuration?: string;
  runningPid?: number;
  lifecycle: UpdateLifecycle;
}): Promise<void> {
  const { current, lifecycle } = options;
  const root = realpathSync(options.root);
  const releaseLock = claimUpdate(root);
  const allowStart = () => {
    const path = join(root, '.riffet/update.lock');
    if (readFileSync(path, 'utf8') !== String(process.pid)) throw new Error('更新锁已变化，尚未启动新版本。');
    // No source, dependency or build mutations are allowed after this phase transition.
    writeFileSync(path, `${process.pid}\nready`, { mode: 0o600 });
  };
  const logPath = join(root, '.riffet/update.log');
  const log = (line: string) => {
    const safe = cleanOutput(line);
    appendFileSync(logPath, `${new Date().toISOString()} ${safe}\n`, { mode: 0o600 });
    console.log(safe);
  };
  let step = '预检';
  let changed = false;
  let originalCommit: string | null = null;
  const command = async (file: string, args: string[], timeoutMs = 30_000, env = gitEnvironment()) => {
    log(`执行 ${file} ${args.map(shellQuote).join(' ')}`);
    const heartbeat = setInterval(() => console.log(`  ${step}进行中…`), 15_000);
    let result;
    try { result = await runProcess(file, args, { cwd: root, env: file === 'git' ? gitEnvironment() : env, timeoutMs, maxOutputBytes: 16 * 1024 * 1024 }); }
    finally { clearInterval(heartbeat); }
    if (result.stdout) log(result.stdout.trimEnd());
    if (result.stderr) log(result.stderr.trimEnd());
    if (result.code !== 0 || result.timedOut || result.truncated) {
      throw new Error(`${file} 失败${result.timedOut ? '（超时）' : result.truncated ? '（输出过大）' : `（退出码 ${result.code}）`}，详见 ${logPath}。`);
    }
    return result.stdout.trim();
  };
  try {
    const source = await readSourceInfo(root);
    originalCommit = source.commit;
    if (source.dirty || !source.tag || !source.commit) throw new Error('自动更新要求干净的发布 tag checkout。请先处理本地修改或开发提交，再切到发布 tag。');
    await assertSourceProcessesStopped(root, options.runningPid);
    const branch = await runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, env: gitEnvironment() });
    log(`更新前：${source.tag} · ${source.commit} · ${branch.code === 0 ? branch.stdout.trim() : 'detached HEAD'}`);
    const check = await checkForUpdates({ root, current });
    if (!check.latest || check.status === 'conflict' || check.status === 'unavailable' || check.status === 'ahead') {
      throw new Error(check.message ?? '没有可用的新发布版本。');
    }
    const target = check.latest;
    if (source.tag !== target.tag && compareReleaseTags(source.tag, target.tag) > 0) {
      throw new Error('本地源码比远端最新发布版本更新，不自动降级。');
    }
    const app = options.app ? readAppInstallation(root, options.configuration) : undefined;
    if (options.app && process.platform !== 'darwin') throw new Error('--app 仅支持 macOS。');
    if (app) await assertAppStopped(root, app);
    if (source.commit === target.commit && current.tag === target.tag && current.commit === target.commit && !current.dirty) {
      log(`当前已是最新发布版本 ${target.tag}，无需更新。`);
      return;
    }
    await command('pnpm', ['--version']);
    step = '获取目标 tag';
    log(`获取 ${target.tag}，原服务继续运行。`);
    const manifest = await fetchRelease(root, target);
    if (manifest.engines?.node && satisfiesMinimum(process.version, manifest.engines.node) !== true) {
      throw new Error(`目标版本要求 Node.js ${manifest.engines.node}，当前为 ${process.version}；请先调整工具链。`);
    }
    if (manifest.engines?.pnpm !== undefined) {
      const pnpmVersion = await command('pnpm', ['--version']);
      if (typeof manifest.engines.pnpm !== 'string' || satisfiesMinimum(pnpmVersion, manifest.engines.pnpm) !== true) throw new Error('目标版本的 pnpm 要求不满足或无法识别，请先在终端确认工具链。');
    }
    if (manifest.packageManager) {
      const required = /^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(manifest.packageManager)?.[1];
      if (!required || await command('pnpm', ['--version']) !== required) throw new Error(`目标版本使用 ${manifest.packageManager}，请先选择对应 pnpm。`);
    }
    const unchanged = async () => {
      const latest = await readSourceInfo(root);
      if (latest.dirty || latest.commit !== source.commit || latest.tag !== source.tag) throw new Error('预检后源码发生变化，停止更新；请处理本地变更后重试。');
    };
    await unchanged();
    if (app) await assertAppStopped(root, app);
    step = '停止原服务';
    log('进入更新阶段；依赖安装和构建期间服务将停止。');
    await lifecycle.stop();
    await assertSourceProcessesStopped(root);
    await unchanged();
    changed = true;
    step = '切换源码';
    await command('git', ['-c', 'core.hooksPath=/dev/null', 'switch', '--detach', target.commit]);
    step = '安装依赖';
    await command('pnpm', ['install', '--frozen-lockfile'], 15 * 60_000);
    step = '核对版本';
    await command('pnpm', ['version:check']);
    step = '构建 Server / Web';
    // Do not inherit an unrelated build's pinned metadata from an Xcode/agent caller.
    const buildEnv = gitEnvironment();
    delete buildEnv.RIFFET_BUILD_INFO_FILE;
    await command('pnpm', ['build'], 15 * 60_000, buildEnv);
    const built = JSON.parse(readFileSync(join(root, 'dist/build-info.json'), 'utf8')) as { build?: BuildInfo };
    if (built.build?.tag !== target.tag || built.build.commit !== target.commit || built.build.dirty) throw new Error('构建产物与目标 tag 不一致，尚未启动新版本。');
    const finalSource = await readSourceInfo(root);
    if (finalSource.dirty || finalSource.commit !== target.commit || finalSource.tag !== target.tag) throw new Error('构建期间源码发生变化，尚未启动新版本。');
    if (app) {
      step = '构建 App';
      await command('/bin/bash', ['apps/macos/scripts/build.sh', app.configuration === 'Release' ? 'update-release' : 'update-debug'], 30 * 60_000, buildEnv);
      const staged = join(root, 'apps/macos/build/update/Riffet.app');
      const appInfo = JSON.parse(readFileSync(join(staged, 'Contents/Resources/RiffetBuildInfo.json'), 'utf8')) as { build?: BuildInfo; sourceRoot?: string; buildConfiguration?: string };
      if (appInfo.build?.tag !== target.tag || appInfo.build.commit !== target.commit || appInfo.build.dirty || appInfo.buildConfiguration !== app.configuration || !appInfo.sourceRoot || realpathSync(appInfo.sourceRoot) !== root) throw new Error('App 构建版本不匹配，原 App 保留。');
      await assertAppStopped(root, app);
      const replacement = app.path + `.update-${process.pid}`;
      const previous = app.path + `.previous-${process.pid}`;
      if (existsSync(replacement) || existsSync(previous)) throw new Error('存在上次 App 替换留下的暂存目录，请手动核对后重试。');
      await cp(staged, replacement, { recursive: true, verbatimSymlinks: true });
      renameSync(app.path, previous);
      try { renameSync(replacement, app.path); }
      catch (error) { renameSync(previous, app.path); throw error; }
      rmSync(previous, { recursive: true, force: true });
      allowStart();
      await command('/usr/bin/open', [app.path]);
      log(`App 已替换为 ${target.tag}。请通过 App 现有启动入口恢复其托管服务，并核对服务版本。`);
    } else {
      step = '恢复并核对服务';
      allowStart();
      await lifecycle.restore(target);
      log(`更新完成：${target.tag} · ${target.commit}`);
    }
  } catch (error) {
    log(`更新停止于「${step}」：${error instanceof Error ? error.message : String(error)}`);
    if (originalCommit) {
      log(`恢复指引：cd ${shellQuote(root)}`);
      if (changed) log(`如需恢复原版，先确认工作树，再执行 git switch --detach ${originalCommit}`);
      log(`pnpm install --frozen-lockfile && pnpm build`);
      log(lifecycle.recoveryCommand);
    }
    throw error;
  } finally {
    releaseLock();
  }
}
