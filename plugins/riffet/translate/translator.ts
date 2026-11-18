// Translating one message: split at paragraph breaks outside code, each piece through `host.models.complete`, the
// pieces joined back in order. Results are kept for reuse within `PLUGIN_COMMAND_BUDGET.translationCacheChars`, the
// oldest first out, and dropped when the plugin is turned off; asking for the same text while it is being translated
// waits on the same calls.

import { createHash } from 'node:crypto';
import { PLUGIN_COMMAND_BUDGET } from '@contracts';
import type { CommandContext, PluginCommandResult, PluginHost } from '@riffet/plugin-api';
import { fallbackLanguage, targetLanguage, type Language } from './languages.js';

/** `TRANSLATE_MODEL` in index.ts, the use declared in the manifest. */
const MODEL_USE = 'riffet.translate/translation';

/** A piece this long fits the output limit below in any language pair. */
const PIECE_CHARS = 6_000;
const MAX_OUTPUT_TOKENS = 12_000;
/** Pieces translated at once: every piece of the longest message a client sends, so all finish within one call's time; the command has about a minute in all. */
const CONCURRENCY = Math.ceil(PLUGIN_COMMAND_BUDGET.messageChars / PIECE_CHARS);
const PIECE_TIMEOUT_MS = 55_000;

const TITLE = { 'zh-Hans': '译文', en: 'Translation' };

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** The text cut at blank lines outside fenced code, each piece at most about `limit` characters (a longer paragraph stays whole). */
export function pieces(text: string, limit = PIECE_CHARS): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let size = 0;
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const open = FENCE.exec(line)?.[1];
    if (open && (!fence || (open[0] === fence[0] && open.length >= fence.length))) fence = fence ? undefined : open;
    if (!fence && !line.trim() && size >= limit) { out.push(current.join('\n')); current = []; size = 0; continue; }
    current.push(line);
    size += line.length + 1;
  }
  if (current.some(line => line.trim())) out.push(current.join('\n'));
  return out;
}

export function systemPrompt(target: Language, fallback: Language): string {
  return [
    `You translate a message from a conversation between a person and a coding agent into ${target.english}.`,
    `If the message is already in ${target.english}, translate it into ${fallback.english} instead.`,
    'Keep the Markdown as it is: headings, lists, tables, links, emphasis and line breaks.',
    'Leave code blocks, inline code, file paths, commands, URLs, identifiers and product names unchanged.',
    'The message may be one part of a longer one; translate only what you are given.',
    'Answer with the translation alone: no preface, no notes, no quotation marks around it.',
  ].join('\n');
}

export class Translator {
  /** Insertion order is age: a hit moves its entry to the end. */
  private readonly kept = new Map<string, { text: string; size: number }>();
  private readonly pending = new Map<string, { promise: Promise<string>; controller: AbortController; waiters: number }>();
  private size = 0;

  constructor(private readonly host: PluginHost) {}

  async run(context: CommandContext): Promise<PluginCommandResult> {
    const source = context.selection?.text ?? context.message?.text;
    if (!source) throw this.host.error('COMMAND_ARGS_INVALID', 'Translate runs on a message or a selection', 400);
    const target = targetLanguage(this.host.settings().target, context.locale);
    const text = await this.translate(source, target, context.signal);
    return { kind: 'text', text, title: TITLE };
  }

  clear(): void {
    for (const entry of this.pending.values()) entry.controller.abort();
    this.pending.clear();
    this.kept.clear();
    this.size = 0;
  }

  private async translate(text: string, target: Language, signal: AbortSignal): Promise<string> {
    const models = this.host.models;
    if (!models) throw this.host.error('COMMAND_UNAVAILABLE', 'This Riffet cannot run a model for plugins', 409);
    const parts = pieces(text);
    if (!parts.length) throw this.host.error('PLUGIN_MODEL_EMPTY_OUTPUT', 'The model returned no translation', 502);
    const system = systemPrompt(target, fallbackLanguage(target));
    const out: string[] = new Array(parts.length);
    let next = 0;
    // One piece failing fails the message, so the others stop instead of spending calls on it.
    const failed = new AbortController();
    const pieceSignal = AbortSignal.any([signal, failed.signal]);
    const worker = async () => {
      while (next < parts.length) {
        const index = next++;
        out[index] = await this.translatePiece(models, parts[index]!, target, system, pieceSignal);
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(CONCURRENCY, parts.length) }, worker)); }
    catch (error) { failed.abort(); throw error; }
    const joined = out.join('\n\n').trim();
    if (!joined) throw this.host.error('PLUGIN_MODEL_EMPTY_OUTPUT', 'The model returned no translation', 502);
    return joined;
  }

  private async translatePiece(models: NonNullable<PluginHost['models']>, part: string, target: Language, system: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const key = createHash('sha256').update(`${target.tag}\0${part}`).digest('hex');
    const hit = this.kept.get(key);
    if (hit) { this.kept.delete(key); this.kept.set(key, hit); return hit.text; }
    let entry = this.pending.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = models.complete({ use: MODEL_USE, system, content: part, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: PIECE_TIMEOUT_MS, signal: controller.signal })
        .then(raw => {
          const text = raw.trim();
          if (!text) throw this.host.error('PLUGIN_MODEL_EMPTY_OUTPUT', 'The model returned no translation', 502);
          this.keep(key, text, part.length + text.length);
          return text;
        })
        .finally(() => { if (this.pending.get(key) === entry) this.pending.delete(key); });
      entry = { promise, controller, waiters: 0 };
      this.pending.set(key, entry);
    }
    entry.waiters += 1;
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        entry.waiters -= 1;
        if (entry.waiters <= 0) {
          if (this.pending.get(key) === entry) this.pending.delete(key);
          entry.controller.abort(signal.reason);
        }
        reject(signal.reason ?? new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        value => { signal.removeEventListener('abort', onAbort); entry.waiters = Math.max(0, entry.waiters - 1); resolve(value); },
        error => { signal.removeEventListener('abort', onAbort); entry.waiters = Math.max(0, entry.waiters - 1); reject(error); },
      );
    });
  }

  private keep(key: string, text: string, size: number): void {
    const budget = PLUGIN_COMMAND_BUDGET.translationCacheChars;
    if (size > budget) return;
    const previous = this.kept.get(key);
    if (previous) {
      this.kept.delete(key);
      this.size -= previous.size;
    }
    this.kept.set(key, { text, size });
    this.size += size;
    for (const [oldest, entry] of this.kept) {
      if (this.size <= budget) break;
      this.kept.delete(oldest);
      this.size -= entry.size;
    }
  }
}
