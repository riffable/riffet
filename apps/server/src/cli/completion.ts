import type { Command, Option } from 'commander';
import { basename } from 'node:path';
import { PackageStore } from '../plugins-host/packages.js';
import type { Session } from '../../../../packages/contracts/src/index.js';
import { Api } from './api.js';
import { accessToken, active } from './context.js';
import { UsageError, hint, out, printLines } from './ui.js';

/*
 * `riffet completion <shell>` prints a script that asks `riffet __complete <words…>` for candidates, one
 * `value<TAB>description` per line, so commands, options, conversation ids and plugin ids complete from
 * the same command tree the parser uses. A lone `:file` line asks the shell for paths instead. The
 * scripts pass the words after `--`, so options such as `--state-dir` reach here instead of the parser.
 */

const SHELLS = ['zsh', 'bash', 'fish'] as const;
type Shell = typeof SHELLS[number];

const SCRIPTS: Record<Shell, string> = {
  zsh: `#compdef riffet
_riffet() {
  local -a lines completions
  local line value description
  lines=("\${(@f)$(riffet __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  if [[ "\${lines[1]}" == ":file" ]]; then _files; return; fi
  for line in "\${lines[@]}"; do
    [[ -z "$line" ]] && continue
    value="\${line%%$'\\t'*}"
    description="\${line#*$'\\t'}"
    [[ "$description" == "$line" ]] && description=""
    completions+=("\${value//:/\\\\:}:\${description}")
  done
  _describe -t riffet riffet completions
}
compdef _riffet riffet
`,
  bash: `_riffet() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" out
  local words=("\${COMP_WORDS[@]:1:COMP_CWORD}")
  out=$(riffet __complete -- "\${words[@]}" 2>/dev/null)
  if [[ "$out" == ":file" ]]; then COMPREPLY=($(compgen -f -- "$cur")); return; fi
  local IFS=$'\\n'
  COMPREPLY=($(compgen -W "$(printf '%s\\n' "$out" | cut -f1)" -- "$cur"))
}
complete -o default -F _riffet riffet
`,
  fish: `function __riffet_complete
    set -l tokens (commandline -opc) (commandline -ct)
    set -l out (riffet __complete -- $tokens[2..-1] 2>/dev/null)
    if test "$out[1]" = ":file"
        __fish_complete_path (commandline -ct)
    else
        printf '%s\\n' $out
    end
end
complete -c riffet -f -a '(__riffet_complete)'
`,
};

const RC: Record<Shell, string> = { zsh: '~/.zshrc', bash: '~/.bashrc', fish: '~/.config/fish/config.fish' };
const LOADER: Record<Shell, string> = { zsh: 'eval "$(riffet completion zsh)"', bash: 'eval "$(riffet completion bash)"', fish: 'riffet completion fish | source' };

export function completion(shell?: string): void {
  const chosen = (shell ?? basename(process.env.SHELL ?? '')) as Shell;
  if (!SHELLS.includes(chosen)) throw new UsageError(shell ? `No completion for ${shell}; choose zsh, bash or fish` : 'Name the shell: zsh, bash or fish');
  // Typed at a prompt, the script itself is no use: say where it goes instead.
  if (process.stdout.isTTY) {
    printLines([`${out.bold('Add this line to')} ${RC[chosen]}${out.dim(', then open a new terminal')}`, '', `  ${out.cmd(LOADER[chosen])}`, '', hint(`\`riffet completion ${chosen} > file\` writes the script itself`, out)]);
    return;
  }
  process.stdout.write(SCRIPTS[chosen]);
}

const visible = (command: Command) => (command as unknown as { _hidden?: boolean })._hidden !== true;
const optionVisible = (option: Option) => !option.hidden;
const describe = (value: string, description = '') => `${value}\t${description.replace(/\s+/g, ' ')}`;

/** Values a command's argument takes that the shell cannot know. */
async function dynamicValues(path: string[], stateDir: string): Promise<string[]> {
  const leaf = path.join(' ');
  if (leaf === 'completion') return SHELLS.map(shell => describe(shell));
  if (leaf === 'resume') {
    const record = await active(stateDir);
    if (!record) return [];
    const api = await Api.login(record, accessToken(stateDir));
    const sessions = await api.call<Session[]>('GET', '/api/sessions', undefined, 2000);
    return sessions.filter(session => session.kind === 'native' && !session.archivedAt)
      .sort((a, b) => Date.parse(b.lastActivityAt ?? b.updatedAt) - Date.parse(a.lastActivityAt ?? a.updatedAt))
      .slice(0, 50).map(session => describe(session.id.slice(0, 8), session.displayTitle ?? session.title));
  }
  if (/^plugin (?:uninstall|reload|diagnostics|logs|select|delete-data|update|unlink)$/.test(leaf)) {
    return new PackageStore(stateDir).records().map(record => describe(record.id, record.selected));
  }
  return [];
}

/** `riffet __complete <words…>`: the last word is the one being completed. */
export async function complete(program: Command, words: string[], stateDir: string): Promise<void> {
  const current = words.at(-1) ?? '';
  // `riffet --state-dir X resume <TAB>` lists X's conversations.
  const typedDir = words.findIndex((word, index) => word === '--state-dir' && index < words.length - 2);
  if (typedDir >= 0) stateDir = words[typedDir + 1]!;
  let command = program;
  const path: string[] = [];
  let positional = 0;
  for (let index = 0; index < words.length - 1; index++) {
    const word = words[index]!;
    if (word.startsWith('-')) {
      const option = [...command.options, ...program.options].find(item => item.long === word || item.short === word);
      if (option && (option.required || option.optional)) index++;
      continue;
    }
    const sub = command.commands.find(item => item.name() === word || item.aliases().includes(word));
    if (sub && positional === 0) { command = sub; path.push(sub.name()); } else positional++;
  }
  const previous = words.at(-2);
  const previousOption = previous?.startsWith('-') ? [...command.options, ...program.options].find(item => item.long === previous || item.short === previous) : undefined;
  if (previousOption && (previousOption.required || previousOption.optional)) {
    if (/path|dir|out|backup|workspace/.test(previousOption.long ?? '')) process.stdout.write(':file\n');
    return;
  }
  const lines: string[] = [];
  if (current.startsWith('-')) {
    for (const option of [...command.options, ...(command === program ? [] : program.options)].filter(optionVisible)) {
      if (option.long) lines.push(describe(option.long, option.description));
    }
  } else {
    if (positional === 0) for (const sub of command.commands.filter(visible)) lines.push(describe(sub.name(), sub.description()));
    try { lines.push(...await dynamicValues(path, stateDir)); } catch { /* a server that is down completes nothing */ }
  }
  process.stdout.write(lines.filter(line => line.startsWith(current)).join('\n') + (lines.length ? '\n' : ''));
}
