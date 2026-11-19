import { isRecord, records, str } from './values.js';

/*
 * The language-free part of a tool row's one-line title, shared by the web (which adds its own
 * translated fallback) and the server's channel projector. Pure functions of a tool event's data.
 */

/** Model names from a CLI sometimes carry zero-width padding and doubled spaces. */
export function cleanLabel(value: string): string {
  return value.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

/** Rewrites absolute paths under the project root (including macOS /private aliases) as project-relative paths. */
export function stripRoot(text: string, root?: string): string {
  if (!root) return text;
  const base = root.replace(/\/+$/, '');
  const roots = [base, base.startsWith('/private/') ? base.slice('/private'.length) : `/private${base}`].sort((a, b) => b.length - a.length);
  let result = text;
  for (const item of roots) result = result.split(`${item}/`).join('').split(item).join('.');
  return result;
}

/**
 * The one-line header of a shell command: backslash-continued lines stay together, while heredoc
 * bodies and multi-line scripts (such as `python3 - <<'PY'`) stop at the first logical line so the
 * folded row does not flatten the script body into its title.
 */
export function commandHeadline(command: string): string {
  const joined = command.replace(/\\\r?\n[ \t]*/g, ' ');
  const lines = joined.split(/\r?\n/).map(line => cleanLabel(line)).filter(Boolean);
  return lines.find(line => !line.startsWith('#')) ?? lines[0] ?? cleanLabel(command);
}

/** A leading `cd` into the project root (`cd .` once `stripRoot` ran): every command starts there anyway. */
const ROOT_CD = /^cd \.?\s*(?:&&|;)\s*/;

/**
 * Whether a title only restates its command: the command itself, its headline, or either cut short
 * with `…` (an activity's title is its command's first line, clipped).
 */
export function isCommandTitle(title: string, command: string | undefined): boolean {
  if (!command) return false;
  const normalized = cleanLabel(title.replace(ROOT_CD, ''));
  if (normalized === cleanLabel(command) || normalized === commandHeadline(command)) return true;
  const clipped = normalized.endsWith('…') ? normalized.slice(0, -1).trimEnd() : '';
  return clipped.length > 0 && (cleanLabel(command).startsWith(clipped) || cleanLabel(command.replace(ROOT_CD, '')).startsWith(clipped));
}

/** A command as a one-line label: project-relative, without the `cd` into the root, cut to its first logical line. */
export function commandLabel(command: string, root?: string): string {
  return commandHeadline(stripRoot(command, root).replace(ROOT_CD, ''));
}

function uniqueStrings(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

/**
 * Names each path by its basename when unique within the call, or adds parent segments when two
 * files in the same call share a basename (`claude/index.ts, codex/index.ts`).
 */
export function shortFileLabels(paths: readonly string[]): string[] {
  const split = paths.map(path => path.split(/[\\/]/).filter(Boolean));
  const baseCounts = new Map<string, number>();
  for (const parts of split) {
    const base = parts.at(-1) ?? '';
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  return split.map((parts, index) => {
    const fallback = paths[index]!;
    const base = parts.at(-1);
    if (!base) return fallback;
    if ((baseCounts.get(base) ?? 0) <= 1 || parts.length <= 1) return base;
    return parts.slice(-2).join('/');
  });
}

export function formatTargetList(items: readonly string[], limit = 3): string {
  if (items.length <= limit) return items.join(', ');
  return `${items.slice(0, limit).join(', ')} +${items.length - limit}`;
}

/** Distinct file paths from a tool's `diff` content blocks, shortened for a folded row's detail. */
export function diffTargetSummary(title: string, contents: readonly Record<string, unknown>[], root?: string): string | undefined {
  const paths = uniqueStrings(contents.flatMap(item => item.type === 'diff' && str(item.path) ? [stripRoot(str(item.path)!, root)] : []));
  if (!paths.length) return undefined;
  if (paths.some(path => title.includes(path.split('/').at(-1) ?? path))) return undefined;
  return formatTargetList(shortFileLabels(paths));
}

export type CommandActionKind = 'read' | 'search' | 'execute' | 'other';

/**
 * Summarizes Codex `commandActions` into a category and concise one-line title. Repeated reads or
 * searches share a single verb and name multiple files by basename (with parent disambiguation),
 * while pure read/search combinations keep their exploration category instead of degrading to `other`.
 */
export function describeCommandActions(
  actions: readonly Record<string, unknown>[],
  root?: string,
): { name: string; kind: CommandActionKind; title?: string } | undefined {
  if (!actions.length) return undefined;
  const kinds = actions.map(action =>
    action.type === 'read' ? 'read' : action.type === 'search' || action.type === 'listFiles' ? 'search' : 'execute',
  );
  const allSame = kinds.every(value => value === kinds[0]);
  const hasExecute = kinds.includes('execute');
  const kind: CommandActionKind = allSame ? kinds[0]! : !hasExecute ? kinds[0]! : 'other';
  const name = actions.length === 1 && actions[0]?.type === 'listFiles' ? 'List files'
    : kind === 'read' ? 'Read' : kind === 'search' ? 'Search' : kind === 'execute' ? 'Command' : 'Commands';
  if (kind === 'execute') return { name, kind };

  const groupOrder: Array<'read' | 'search' | 'listFiles' | 'unknown'> = [];
  for (const action of actions) {
    const type = action.type === 'read' || action.type === 'search' || action.type === 'listFiles' ? action.type : 'unknown';
    if (!groupOrder.includes(type)) groupOrder.push(type);
  }

  if (groupOrder.length > 3) {
    const counts = new Map<string, number>();
    for (const action of actions) {
      const label = action.type === 'read' ? 'file read' : action.type === 'search' ? 'search'
        : action.type === 'listFiles' ? 'file listing' : 'command';
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const summary = [...counts].map(([label, count]) => `${count} ${label}${count === 1 ? '' : label === 'search' ? 'es' : 's'}`);
    return { name, kind, title: summary.join(' · ') };
  }

  const singleGroup = groupOrder.length === 1;
  const segments = groupOrder.map(group => {
    const members = actions.filter(action =>
      (action.type === 'read' || action.type === 'search' || action.type === 'listFiles' ? action.type : 'unknown') === group,
    );
    if (group === 'read') {
      const targets = uniqueStrings(members.map(action => {
        const raw = str(action.path) ?? str(action.name);
        return raw ? stripRoot(raw, root) : '';
      }));
      if (!targets.length) return 'Read file';
      if (singleGroup && targets.length === 1) return `Read ${targets[0]}`;
      return `Read ${formatTargetList(shortFileLabels(targets))}`;
    }
    if (group === 'listFiles') {
      const targets = uniqueStrings(members.map(action => {
        const raw = str(action.path);
        return raw ? stripRoot(raw, root) : '';
      }));
      if (!targets.length) return 'List files';
      if (singleGroup && targets.length === 1) return `List files ${targets[0]}`;
      return `List files ${formatTargetList(shortFileLabels(targets))}`;
    }
    if (group === 'search') {
      const rawPaths = members.map(action => {
        const raw = str(action.path);
        return raw ? stripRoot(raw, root) : '';
      });
      const nonEmptyPaths = uniqueStrings(rawPaths);
      const shortPaths = singleGroup && members.length === 1
        ? rawPaths
        : (() => {
            const labels = shortFileLabels(nonEmptyPaths);
            const map = new Map(nonEmptyPaths.map((path, index) => [path, labels[index]!]));
            return rawPaths.map(path => (path ? map.get(path) ?? path : ''));
          })();
      const specs = uniqueStrings(members.map((action, index) => {
        const query = str(action.query);
        const path = shortPaths[index];
        return [query, path ? `in ${path}` : undefined].filter(Boolean).join(' ');
      }));
      return specs.length ? `Search ${formatTargetList(specs)}` : 'Search';
    }
    return members.length === 1 ? 'Run command' : `${members.length} commands`;
  });

  return { name, kind, title: segments.join(' · ') };
}

/** A display category, including the child metadata retained by older Task rows. */
export function toolDataKind(data: Record<string, unknown>): string {
  const input = data.rawInput ?? data.input;
  if (isRecord(data.subagent) || (data.kind === 'think' && isRecord(input) && str(input.subagent_type))) return 'agent';
  const kind = str(data.kind);
  if (!kind || kind === 'other') {
    const actions = isRecord(input) ? records(input.commandActions) : [];
    const described = actions.length ? describeCommandActions(actions) : undefined;
    if (described) return described.kind;
  }
  return kind ?? 'other';
}

/**
 * A tool call's title and the command it ran. `fallback` names a call that carries no title; the
 * title of a multi-line command is cut to its first logical line so the folded header never dumps
 * an inline script body onto one line.
 */
export function toolTitleOf(data: Record<string, unknown>, fallback: string, root?: string): { title: string; command?: string } {
  const rawInput = data.rawInput ?? data.input;
  const input = isRecord(rawInput) ? rawInput : undefined;
  const rawCommand = str(input?.command) ?? (Array.isArray(input?.command) ? (input.command as unknown[]).join(' ') : undefined);
  const command = rawCommand ? stripRoot(rawCommand, root).replace(ROOT_CD, '') : undefined;
  const actions = records(input?.commandActions);
  const described = actions.length ? describeCommandActions(actions, root) : undefined;
  const rawTitle = described?.title ?? str(data.title) ?? str(data.toolName) ?? str(data.name) ?? fallback;
  const title = stripRoot(cleanLabel(rawTitle), root).replace(/^`([^`]*)`$/, '$1');
  return { title: command && isCommandTitle(title, command) ? commandHeadline(command) : title, ...(command ? { command } : {}) };
}
