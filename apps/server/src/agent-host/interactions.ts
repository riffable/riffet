import { randomUUID } from 'node:crypto';
import { CURSOR_APPROVAL_SCROLLBACK_ROWS } from '../../../../packages/contracts/src/index.js';
import type { NativeInteraction, NativeInteractionResponse, NativeInteractionResult, Session, TerminalInfo } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import type { TerminalService } from '../terminal/service.js';
import { cursorApprovalNeedsHistory, hasCursorApprovalTitle, parseCursorApprovalHistory } from './interaction-choice.js';
import { matchesOtherValue, parseDialog, type DialogScreen } from './interaction-screen.js';

type Control = Parameters<Parameters<TerminalService['withInteraction']>[1]>[0];
/** The part of the terminal service that reads and answers dialogs. */
export type DialogTerminal = Pick<TerminalService, 'get' | 'screen' | 'withInteraction'>;
/** Re-evaluated at the mutation boundary; protocol/policy changes do not take the terminal lock. */
export type NativeInteractionGuard = (interaction: NativeInteraction) => boolean | Promise<boolean>;
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 40));
const stale = () => new AppError('NATIVE_INTERACTION_STALE', 'The CLI prompt changed; sync and try again', 409);

export interface NativeInteractionsOptions {
  recoverCursorApprovals?: boolean;
  /**
   * Whether a screen that shows no dialog has the CLI back at its own prompt, which completes an
   * answer at once instead of after several empty reads. Only a backend with a recognisable status
   * line (Cursor's footer) can vouch for that; without it an answer completes when the dialog stays gone.
   * Before this was an option the core applied Cursor's footer reader to every backend's screens. It needs a `→` prompt
   * bar or a `ctrl+c to stop` hint, which Claude Code and Codex do not draw (none of the recorded Claude screens matches;
   * Droid runs without a terminal), so for them nothing changed: they have always waited for the dialog to stay gone.
   */
  settledScreen?: (screen: string) => boolean;
}

/** Adapts verified foreground CLI dialogs; never writes answers into the transcript database. */
export class NativeInteractions {
  private readonly salt = randomUUID();
  private readonly active = new Set<string>();
  private readonly observed = new Map<string, { rawId: string; token: string }>();
  private readonly requests = new Map<string, { payload: string; promise: Promise<NativeInteractionResult>; done: boolean; evictable: boolean }>();

  constructor(private readonly terminal: DialogTerminal, private readonly options: NativeInteractionsOptions = {}) {}

  observe(screen: string | undefined, info: Pick<TerminalInfo, 'id' | 'epoch'>): DialogScreen | undefined {
    return this.record(screen === undefined ? undefined : parseDialog(screen, info), info.id);
  }

  private async read(screen: string | undefined, info: Pick<TerminalInfo, 'id' | 'epoch'>): Promise<DialogScreen | undefined> {
    let parsed = screen === undefined ? undefined : parseDialog(screen, info);
    if (screen !== undefined && this.options.recoverCursorApprovals && cursorApprovalNeedsHistory(screen, parsed)) {
      const history = await this.terminal.screen(info.id, { scrollback: CURSOR_APPROVAL_SCROLLBACK_ROWS });
      parsed = history === undefined ? undefined : parseCursorApprovalHistory(screen, history, info);
    }
    return this.record(parsed, info.id);
  }

  private record(parsed: DialogScreen | undefined, terminalId: string): DialogScreen | undefined {
    if (!parsed) { if (!this.active.has(terminalId)) this.observed.delete(terminalId); return; }
    let identity = this.observed.get(terminalId);
    if (identity?.rawId !== parsed.interaction.id) {
      identity = { rawId: parsed.interaction.id, token: `${this.salt}:${randomUUID()}` };
      this.observed.set(terminalId, identity);
      while (this.observed.size > 128) this.observed.delete(this.observed.keys().next().value!);
    }
    parsed.interaction.id = identity.token;
    return parsed;
  }

  isResponding(terminalId: string): boolean { return this.active.has(terminalId); }

  ownsInteraction(id: string): boolean { return id.startsWith(`${this.salt}:`); }

  /** A completed/in-flight terminal answer remains replayable after its dialog disappears. */
  replay(session: Session, input: NativeInteractionResponse): Promise<NativeInteractionResult> | undefined {
    const previous = this.requests.get(`${session.id}:${input.requestId}`);
    if (!previous) return undefined;
    if (previous.payload !== JSON.stringify({ terminalId: session.terminalId, ...input })) {
      throw new AppError('INTERACTION_REQUEST_REUSED', 'This request was already used for a different answer; sync and submit again', 409);
    }
    return previous.promise;
  }

  async current(session: Session): Promise<NativeInteraction | null> {
    if (!session.terminalId || session.archivedAt) return null;
    const info = await this.terminal.get(session.terminalId);
    if (info.state !== 'running') return null;
    return (await this.read(await this.terminal.screen(info.id), info))?.interaction ?? null;
  }

  respond(session: Session, input: NativeInteractionResponse, guard?: NativeInteractionGuard): Promise<NativeInteractionResult> {
    if (session.kind !== 'native' || !session.terminalId || session.archivedAt) throw new AppError('TERMINAL_NOT_RUNNING', 'This conversation has no running CLI', 409);
    if (!input || ![input.requestId, input.interactionId, input.revision, input.action].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200)) throw new AppError('INVALID_INTERACTION', 'The interaction request is invalid', 400, undefined, { reason: 'request' });
    if (input.selectedIds !== undefined && (!Array.isArray(input.selectedIds) || input.selectedIds.length > 100 || input.selectedIds.some(value => typeof value !== 'string' || value.length > 100))) throw new AppError('INVALID_INTERACTION', 'The selected options are invalid', 400, undefined, { reason: 'selection' });
    if (input.otherText !== undefined && (typeof input.otherText !== 'string' || input.otherText.length > 2000 || /[\x00-\x1f\x7f-\x9f]/.test(input.otherText))) throw new AppError('INVALID_INTERACTION', 'The other answer must be one line of at most 2000 characters', 400, undefined, { reason: 'otherText' });
    const key = `${session.id}:${input.requestId}`;
    const payload = JSON.stringify({ terminalId: session.terminalId, ...input });
    const replay = this.replay(session, input);
    if (replay) return replay;
    if (this.requests.size >= 256) {
      for (const [id, item] of this.requests) { if (item.done && item.evictable) { this.requests.delete(id); break; } }
      if (this.requests.size >= 256) throw new AppError('INTERACTION_BUSY', 'Too many interaction requests; try again shortly', 429);
    }
    const record = { payload, done: false, evictable: false, promise: Promise.resolve<NativeInteractionResult>({ status: 'uncertain' }) };
    record.promise = this.execute(session.terminalId, input, guard).then(result => { record.evictable = result.status !== 'uncertain'; return result; }, error => {
      // `execute` only rejects before it starts mutating the TUI (busy, stale revision, invalid
      // action, etc.). Those failures are safe to retry with the same idempotency key; keeping
      // the rejected promise would make a transient TERMINAL_INTERACTION_BUSY permanent.
      record.evictable = true;
      if (this.requests.get(key) === record) this.requests.delete(key);
      throw error;
    }).finally(() => { record.done = true; });
    this.requests.set(key, record);
    return record.promise;
  }

  private async execute(terminalId: string, input: NativeInteractionResponse, guard?: NativeInteractionGuard): Promise<NativeInteractionResult> {
    return this.terminal.withInteraction(terminalId, async control => {
      this.active.add(terminalId);
      try {
        const info = await this.terminal.get(terminalId);
        let current = await this.read(await control.screen(), info);
        if (!current || current.interaction.id !== input.interactionId || current.interaction.revision !== input.revision) throw stale();
        if (!current.interaction.actions.some(action => action.id === input.action)) throw new AppError('INVALID_INTERACTION_ACTION', 'The current interaction does not support this action');
        const identity = current.interaction.id;
        const cursorApproval = this.options.recoverCursorApprovals && hasCursorApprovalTitle(current.interaction.title);
        const optionId = input.action.startsWith('option:') ? input.action.slice('option:'.length) : undefined;
        let wrote = false;
        const write = async (operation: () => Promise<unknown>): Promise<void> => {
          // Capture/acquisition and redraws await independently of protocol notifications. A
          // matching screen alone cannot endorse automation after the driver revoked its policy.
          if (guard && !(await guard(current!.interaction))) throw stale();
          wrote = true;
          await operation();
        };
        const readSame = () => this.changed(control, info, identity, () => true);
        const move = async (target: number) => {
          for (let count = 0; count < 110; count++) {
            current = await readSame();
            if (current.focus === target) return;
            const before = current.focus;
            await write(() => control.keys([before < target ? 'Down' : 'Up']));
            current = await this.changed(control, info, identity, item => item.focus !== before);
          }
          throw stale();
        };
        try {
          if (input.action === 'answer') {
            if (current.interaction.kind !== 'question') throw stale();
            const selected = new Set(input.selectedIds ?? []);
            const other = input.otherText?.trim() ?? '';
            if (selected.size !== (input.selectedIds ?? []).length || [...selected].some(id => !current!.interaction.options.some(option => option.id === id))) throw new AppError('INVALID_INTERACTION_ANSWER', 'The answer contains invalid or duplicate options');
            if (other && !current.interaction.allowOther) throw new AppError('INVALID_INTERACTION_ANSWER', 'The current question does not allow another answer');
            if (!selected.size && !other) throw new AppError('INVALID_INTERACTION_ANSWER', 'Choose an answer or enter other text');
            if (!current.interaction.multiple && selected.size + Number(Boolean(other)) !== 1) throw new AppError('INVALID_INTERACTION_ANSWER', 'This question accepts exactly one answer');
            if (current.interaction.multiple && current.interaction.otherSelected && !other) throw new AppError('UNSUPPORTED_OTHER_DESELECT', 'The CLI cannot deselect a selected Other option; keep or change it, or skip the question');
            const rowCount = current.rows.length;
            for (let index = 0; index < rowCount; index++) {
              current = await readSame();
              const row = current.rows[index]!;
              if (row.other) continue;
              const wanted = selected.has(row.id);
              if (row.selected === wanted) continue;
              // Selecting the desired radio clears the old one; don't toggle a radio off first.
              if (!current.interaction.multiple && !wanted) continue;
              await move(index);
              const before = current.rows[index]!.selected;
              await write(() => control.keys(['Space']));
              current = await this.changed(control, info, identity, item => item.rows[index]?.selected !== before);
            }
            current = await readSame();
            const otherIndex = current.rows.findIndex(row => row.other);
            if (other) {
              if (otherIndex < 0) throw stale();
              await move(otherIndex);
              // The CLI's Other editor supports Ctrl+U after End; clear before bracketed paste.
              await write(() => control.keys(['End', 'C-u']));
              await this.changed(control, info, identity, item => !item.interaction.otherValue);
              await write(() => control.paste(other, false));
              current = await this.changed(control, info, identity, item => matchesOtherValue(item, other) && item.interaction.otherSelected === true);
            }
            current = await readSame();
            if (current.interaction.options.some(option => option.selected !== selected.has(option.id)) || (other ? !matchesOtherValue(current, other) || !current.interaction.otherSelected : current.interaction.otherSelected)) throw stale();
            // Enter in Other commits its text. For ordinary answers, leave the text editor first.
            if (!other) await move(current.rows.findIndex(row => selected.has(row.id)));
          } else if (optionId !== undefined) {
            const target = current.rows.findIndex(row => row.id === optionId);
            if (target < 0) throw stale();
            await move(target);
          }
          current = await readSame();
          if (optionId !== undefined && current.rows[current.focus]?.id !== optionId) throw stale();
          const inOther = current.rows[current.focus]?.other;
          const key = input.action === 'previous' ? (inOther ? 'BTab' : 'Left') : input.action === 'next' ? (inOther ? 'Tab' : 'Right') : input.action === 'skip' ? 'Escape' : 'Enter';
          await write(() => control.keys([key]));
          /**
           * A blocking dialog that is gone for several consecutive reads is the CLI having taken the
           * key. The footer test alone only ever holds for Cursor: Claude Code and Codex have no such
           * status line, so every answer of theirs used to end as "not confirmed" even though the CLI
           * had already moved on — which is what left an answered card on screen until the reader
           * pressed 同步. Only *readable* panes count: a blank or unparsed frame is what a redraw
           * looks like, and treating that as success would clear the card on no evidence at all.
           */
          let gone = 0;
          for (let attempt = 0; attempt < 50; attempt++) {
            await pause();
            const screen = await control.screen();
            const next = await this.read(screen, info);
            if (next && next.interaction.id !== identity) return { status: 'advanced', interaction: next.interaction };
            if (!next && screen !== undefined) {
              if (cursorApproval) {
                if (!hasCursorApprovalTitle(screen) && this.options.settledScreen?.(screen)) return { status: 'completed' };
                continue;
              }
              gone = screen.split('\n').some(line => line.trim()) ? gone + 1 : 0;
              if (gone >= 5 || this.options.settledScreen?.(screen)) return { status: 'completed' };
            } else {
              gone = 0;
            }
          }
          return { status: 'uncertain', interaction: (await this.currentFromControl(control, info))?.interaction, message: 'CLI 尚未确认完成。若在最后一题，请检查前面的题目是否都已回答；同步状态后继续，或查看终端。' };
        } catch (error) {
          if (!wrote) throw error;
          return { status: 'uncertain', message: '交互途中 CLI 状态发生变化，已停止继续输入。请同步当前状态或查看终端，不要重复提交。' };
        }
      } finally { this.active.delete(terminalId); }
    });
  }

  private async currentFromControl(control: Control, info: TerminalInfo) { return this.read(await control.screen(), info); }

  private async changed(control: Control, info: TerminalInfo, identity: string, predicate: (screen: DialogScreen) => boolean): Promise<DialogScreen> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const parsed = await this.read(await control.screen(), info);
      if (!parsed) { await pause(); continue; }
      if (parsed.interaction.id !== identity) throw stale();
      if (predicate(parsed)) return parsed;
      await pause();
    }
    throw new AppError('NATIVE_INTERACTION_UNCONFIRMED', 'The CLI did not confirm the selection change; sync the status', 409);
  }
}
