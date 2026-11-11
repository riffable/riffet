import { isRecord, str } from './values.js';

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

/** A display category, including the child metadata retained by older Task rows. */
export function toolDataKind(data: Record<string, unknown>): string {
  const input = data.rawInput ?? data.input;
  return isRecord(data.subagent) || (data.kind === 'think' && isRecord(input) && str(input.subagent_type))
    ? 'agent' : str(data.kind) ?? 'other';
}

/**
 * A tool call's title and the command it ran. `fallback` names a call that carries no title; the
 * title of a multi-line command is not repeated when it only collapses that command.
 */
export function toolTitleOf(data: Record<string, unknown>, fallback: string, root?: string): { title: string; command?: string } {
  const rawInput = data.rawInput ?? data.input;
  const input = isRecord(rawInput) ? rawInput : undefined;
  const rawCommand = str(input?.command) ?? (Array.isArray(input?.command) ? (input.command as unknown[]).join(' ') : undefined);
  const command = rawCommand ? stripRoot(rawCommand, root).replace(/^cd \.? ?&& /, '') : undefined;
  const title = stripRoot(cleanLabel(str(data.title) ?? str(data.toolName) ?? str(data.name) ?? fallback), root).replace(/^`([^`]*)`$/, '$1');
  // `cleanLabel` collapses the title's whitespace, so a multi-line command (a heredoc, say)
  // never compared equal to its own title: the row then showed the command twice — the collapsed
  // title and the raw command as the trailing detail — before the body repeated it again.
  return { title: command && cleanLabel(title.replace(/^cd \.? ?&& /, '')) === cleanLabel(command) ? command : title, ...(command ? { command } : {}) };
}
