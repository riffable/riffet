/** What an installed package's plan may set: a plain upper-case name that cannot change how a program or the shell starts, with a bounded value. */
const INSTALLED_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
// `SHELLOPTS`, `BASHOPTS` and `PS4` reach the `/bin/sh` wrapper every task runs under (bash imports them: `SHELLOPTS=xtrace` with `PS4='$(…)'` runs code before the command).
const INSTALLED_ENV_DENIED = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'PATH', 'HOME', 'SHELL', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'IFS',
  'PYTHONSTARTUP', 'PYTHONPATH', 'PYTHONHOME', 'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'PERL5LIB', 'PERLLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
]);
const INSTALLED_ENV_DENIED_PREFIXES = ['DYLD_', 'LD_', 'GIT_', 'SSH_', 'RIFFET_', 'BASH_', 'LUA_'];
export const INSTALLED_ENV_VALUE_BYTES = 4096;

/** Shared by the plans of installed packages (tasks/service.ts) and `host.exec` (plugins-host/host-service.ts). */
export const installedEnvNameAllowed = (name: string): boolean =>
  INSTALLED_ENV_NAME.test(name) && !INSTALLED_ENV_DENIED.has(name) && !INSTALLED_ENV_DENIED_PREFIXES.some(prefix => name.startsWith(prefix));
