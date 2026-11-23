import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface ShellLaunchSpec {
  command: string;
  args: string[];
  tmuxEnv?: Record<string, string>;
}

const SKIP_INTEGRATION_ARGS = new Set(['-c', '--norc', '--noprofile', '--rcfile', '-f', '--no-rcs', '--no-config']);

/**
 * Lightweight, non-invasive OSC 133 (prompt/command boundaries + exit status) and OSC 7 (CWD)
 * shell integration for zsh, bash and fish. Scripts live exclusively inside Riffet's private
 * `stateDir` and delegate to the user's own rc files without modifying anything in `$HOME`.
 */
export function prepareShellLaunch(stateDir: string, spec: ShellLaunchSpec, enabled: boolean): ShellLaunchSpec {
  if (!enabled) return spec;
  if (spec.args.some(arg => SKIP_INTEGRATION_ARGS.has(arg))) return spec;
  const kind = detectShellKind(spec.command);
  if (!kind) return spec;
  const root = join(stateDir, 'shell-integration');
  if (kind === 'zsh') {
    const zshDir = join(root, 'zsh');
    ensureFiles(zshDir, {
      '.zshenv': ZSH_ENV_SCRIPT,
      '.zprofile': ZSH_PROFILE_SCRIPT,
      '.zshrc': ZSH_RC_SCRIPT,
      '.zlogin': ZSH_LOGIN_SCRIPT,
    });
    const origZdotdir = spec.tmuxEnv?.ZDOTDIR ?? process.env.ZDOTDIR ?? '';
    return {
      command: spec.command,
      args: spec.args,
      tmuxEnv: {
        ...spec.tmuxEnv,
        ZDOTDIR: zshDir,
        RIFFET_ZSH_DIR: zshDir,
        RIFFET_ORIG_ZDOTDIR: origZdotdir,
        RIFFET_SHELL_INTEGRATION: '1',
      },
    };
  }
  if (kind === 'bash') {
    // Bash ignores --rcfile when invoked as a login shell (-l / --login); leave login shells untouched.
    if (spec.args.includes('-l') || spec.args.includes('--login')) return spec;
    const bashDir = join(root, 'bash');
    const rcPath = join(bashDir, 'bashrc.sh');
    ensureFiles(bashDir, { 'bashrc.sh': BASH_RC_SCRIPT });
    const filteredArgs = spec.args.filter(arg => arg !== '-i');
    return {
      command: spec.command,
      args: ['--rcfile', rcPath, '-i', ...filteredArgs],
      tmuxEnv: {
        ...spec.tmuxEnv,
        RIFFET_SHELL_INTEGRATION: '1',
      },
    };
  }
  if (kind === 'fish') {
    const fishDataDir = join(root, 'fish');
    const vendorDir = join(fishDataDir, 'fish', 'vendor_conf.d');
    ensureFiles(vendorDir, { 'riffet-shell-integration.fish': FISH_CONF_SCRIPT });
    const existingDataDirs = spec.tmuxEnv?.XDG_DATA_DIRS ?? process.env.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share';
    return {
      command: spec.command,
      args: spec.args,
      tmuxEnv: {
        ...spec.tmuxEnv,
        XDG_DATA_DIRS: `${fishDataDir}:${existingDataDirs}`,
        RIFFET_SHELL_INTEGRATION: '1',
      },
    };
  }
  return spec;
}

export function detectShellKind(command: string): 'zsh' | 'bash' | 'fish' | undefined {
  const name = basename(command).replace(/^-/, '').toLowerCase();
  if (name === 'zsh') return 'zsh';
  if (name === 'bash') return 'bash';
  if (name === 'fish') return 'fish';
  return undefined;
}

function ensureFiles(directory: string, files: Record<string, string>): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(directory, name);
    try {
      if (readFileSync(filePath, 'utf8') === content) continue;
    } catch { /* missing or unreadable: write fresh */ }
    writeFileSync(filePath, content, { mode: 0o600 });
  }
}

const ZSH_ENV_SCRIPT = `# Riffet shell integration v1 (non-invasive ZDOTDIR wrapper)
__riffet_target_zdotdir="\${RIFFET_ORIG_ZDOTDIR:-\$HOME}"
if [[ -f "\$__riffet_target_zdotdir/.zshenv" ]]; then
  ZDOTDIR="\$__riffet_target_zdotdir"
  source "\$__riffet_target_zdotdir/.zshenv"
  if [[ "\$ZDOTDIR" == "\$__riffet_target_zdotdir" ]]; then
    ZDOTDIR="\$RIFFET_ZSH_DIR"
  fi
fi
unset __riffet_target_zdotdir
`;

const ZSH_PROFILE_SCRIPT = `# Riffet shell integration v1
__riffet_target_zdotdir="\${RIFFET_ORIG_ZDOTDIR:-\$HOME}"
if [[ -f "\$__riffet_target_zdotdir/.zprofile" ]]; then
  ZDOTDIR="\$__riffet_target_zdotdir"
  source "\$__riffet_target_zdotdir/.zprofile"
  if [[ "\$ZDOTDIR" == "\$__riffet_target_zdotdir" ]]; then
    ZDOTDIR="\$RIFFET_ZSH_DIR"
  fi
fi
unset __riffet_target_zdotdir
`;

const ZSH_LOGIN_SCRIPT = `# Riffet shell integration v1
__riffet_target_zdotdir="\${RIFFET_ORIG_ZDOTDIR:-\$HOME}"
if [[ -f "\$__riffet_target_zdotdir/.zlogin" ]]; then
  source "\$__riffet_target_zdotdir/.zlogin"
fi
unset __riffet_target_zdotdir
`;

const ZSH_RC_SCRIPT = `# Riffet shell integration v1
__riffet_target_zdotdir="\${RIFFET_ORIG_ZDOTDIR:-\$HOME}"
if [[ -n "\$RIFFET_ORIG_ZDOTDIR" ]]; then
  export ZDOTDIR="\$RIFFET_ORIG_ZDOTDIR"
else
  unset ZDOTDIR
fi
unset RIFFET_ORIG_ZDOTDIR RIFFET_ZSH_DIR
if [[ -f "\$__riffet_target_zdotdir/.zshrc" ]]; then
  source "\$__riffet_target_zdotdir/.zshrc"
fi
unset __riffet_target_zdotdir

if [[ -z "\${__RIFFET_SI_LOADED:-}" && -o interactive ]]; then
  __RIFFET_SI_LOADED=1
  __riffet_in_cmd=0

  __riffet_osc7() {
    local LC_ALL=C
    local pwd_val="\$PWD"
    local encoded=""
    local i ch hex
    for (( i = 1; i <= \${#pwd_val}; i++ )); do
      ch="\${pwd_val[i]}"
      case "\$ch" in
        [a-zA-Z0-9._~/-]) encoded+="\$ch" ;;
        *)
          printf -v hex '%%%02X' "'\$ch"
          encoded+="\$hex"
          ;;
      esac
    done
    printf '\\e]7;file://%s%s\\a' "\${HOST:-\$(hostname 2>/dev/null)}" "\$encoded"
  }

  __riffet_precmd() {
    local exit_code="\$?"
    if [[ "\$__riffet_in_cmd" -eq 1 ]]; then
      printf '\\e]133;D;%s\\a' "\$exit_code"
      __riffet_in_cmd=0
    fi
    __riffet_osc7
    printf '\\e]133;A\\a'
  }

  __riffet_preexec() {
    __riffet_in_cmd=1
    printf '\\e]133;C\\a'
  }

  autoload -Uz add-zsh-hook 2>/dev/null
  if typeset -f add-zsh-hook >/dev/null 2>&1; then
    add-zsh-hook precmd __riffet_precmd
    add-zsh-hook preexec __riffet_preexec
  else
    precmd_functions+=(__riffet_precmd)
    preexec_functions+=(__riffet_preexec)
  fi
  if [[ "\$PROMPT" != *'133;B'* ]]; then
    PROMPT="\$PROMPT%{\$(printf '\\e]133;B\\a')%}"
  fi
fi
`;

const BASH_RC_SCRIPT = `# Riffet shell integration v1 (non-invasive bash --rcfile wrapper)
if [ -f /etc/bashrc ]; then
  . /etc/bashrc
elif [ -f /etc/bash.bashrc ]; then
  . /etc/bash.bashrc
fi
if [ -f "\$HOME/.bashrc" ]; then
  . "\$HOME/.bashrc"
fi

if [ -z "\${__RIFFET_SI_LOADED:-}" ] && [[ \$- == *i* ]]; then
  __RIFFET_SI_LOADED=1
  __riffet_in_cmd=0

  __riffet_osc7() {
    local LC_ALL=C
    local pwd_val="\$PWD"
    local encoded=""
    local i ch hex
    for (( i = 0; i < \${#pwd_val}; i++ )); do
      ch="\${pwd_val:i:1}"
      case "\$ch" in
        [a-zA-Z0-9._~/-]) encoded+="\$ch" ;;
        *)
          printf -v hex '%%%02X' "'\$ch"
          encoded+="\$hex"
          ;;
      esac
    done
    printf '\\e]7;file://%s%s\\a' "\${HOSTNAME:-\$(hostname 2>/dev/null)}" "\$encoded"
  }

  __riffet_in_prompt=1
  __riffet_preexec() {
    if [ "\$__riffet_in_prompt" -eq 0 ] && [ "\$__riffet_in_cmd" -eq 0 ]; then
      __riffet_in_cmd=1
      printf '\\e]133;C\\a'
    fi
  }

  __riffet_prompt_start() {
    local exit_code="\$?"
    __riffet_in_prompt=1
    if [ "\$__riffet_in_cmd" -eq 1 ]; then
      printf '\\e]133;D;%s\\a' "\$exit_code"
      __riffet_in_cmd=0
    fi
  }

  __riffet_prompt_end() {
    __riffet_osc7
    printf '\\e]133;A\\a'
    __riffet_in_prompt=0
  }

  trap '__riffet_preexec' DEBUG
  if [[ "\$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__riffet_prompt_start "\${PROMPT_COMMAND[@]}" __riffet_prompt_end)
  elif [ -n "\${PROMPT_COMMAND:-}" ]; then
    PROMPT_COMMAND="__riffet_prompt_start; \$PROMPT_COMMAND; __riffet_prompt_end"
  else
    PROMPT_COMMAND="__riffet_prompt_start; __riffet_prompt_end"
  fi
  if [[ "\$PS1" != *'133;B'* ]]; then
    PS1="\$PS1\\[\\e]133;B\\a\\]"
  fi
fi
`;

const FISH_CONF_SCRIPT = `# Riffet shell integration v1
if status is-interactive; and not set -q __RIFFET_SI_LOADED
  set -g __RIFFET_SI_LOADED 1

  function __riffet_osc7 --on-variable PWD
    set -l host (hostname 2>/dev/null)
    set -l encoded (string escape --style=url -- "\$PWD" | string replace -a '%2F' '/')
    printf '\\e]7;file://%s%s\\a' "\$host" "\$encoded"
  end

  function __riffet_fish_prompt --on-event fish_prompt
    __riffet_osc7
    printf '\\e]133;A\\a'
  end

  function __riffet_fish_preexec --on-event fish_preexec
    printf '\\e]133;C\\a'
  end

  function __riffet_fish_postexec --on-event fish_postexec
    printf '\\e]133;D;%s\\a' "\$status"
  end

  __riffet_osc7
end
`;
