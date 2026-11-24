import { describe, expect, it } from 'vitest';
import type { Session } from '../../../../packages/contracts/src/index.js';
import type { TerminalInteractionControl, TerminalService } from '../terminal/service.js';
import { NativeInteractions } from './interactions.js';

/**
 * Adversarial PTY/tmux physical-channel contract for TUI input submission.
 *
 * Models an event-loop-stalled CLI (such as Ink / cursor-agent) whose stdin reader coalesces
 * consecutive writes arriving before the next screen repaint into one chunk, and whose Ctrl+U
 * handler matches `chunk.startsWith('\x15')` and returns early — silently discarding any
 * bracketed paste coalesced into the same read.
 *
 * Invariants verified:
 * - **T1 (Empty-Field Clear Restraint)**: never emit `C-u` / `C-k` when the target input is already empty.
 * - **T2 (Dirty-Field Coalescing Isolation)**: when clearing a non-empty field, wait for screen repaint
 *   after `C-u` before emitting the bracketed paste so `\x15` and `\x1b[200~…\x1b[201~` never share a chunk.
 * - **T3 (At-Most-Once Paste)**: an answer paste is transmitted exactly once and arrives uncorrupted.
 */

const session: Session = {
  id: 'tui-contract-session', projectId: 'project-1', kind: 'native', title: 'TUI Channel Contract', tags: [],
  state: 'running', backendId: 'cursor', mode: 'agent', terminalId: 'terminal-1',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

const KEY_WIRE: Record<string, string> = {
  Down: '\x1b[B',
  Up: '\x1b[A',
  End: '\x1b[F',
  'C-u': '\x15',
  'C-k': '\x0b',
  Space: ' ',
  Enter: '\r',
};

class HostileTuiQuestionChannel {
  focus = 0;
  otherText = '';
  submitted = false;
  coalescedDrops = 0;
  pasteCount = 0;
  readonly emittedKeys: string[] = [];
  private stdinBuffer = '';

  constructor(initialOther = '') {
    this.otherText = initialOther;
  }

  /** Appends raw bytes to the unread PTY buffer (coalescing with any bytes not yet drained by a repaint). */
  writeRaw(bytes: string): void {
    this.stdinBuffer += bytes;
  }

  /** Simulates the TUI event loop waking up, reading one coalesced stdin chunk, and repainting. */
  drainAndRender(): string {
    if (this.stdinBuffer.length > 0) {
      const chunk = this.stdinBuffer;
      this.stdinBuffer = '';
      this.processChunk(chunk);
    }
    if (this.submitted) return '✓ Answer submitted\n› ';
    const lines = [
      'Confirm strategy',
      'Question 1 of 1',
      '1. How should we proceed?',
      `${this.focus === 0 ? '› ' : '  '}[ ] Option A`,
      `${this.focus === 1 ? '› ' : '  '}[ ] Option B`,
      `${this.focus === 2 ? '› ' : '  '}[${this.otherText ? 'x' : ' '}] Other: ${this.otherText || '(type to answer)'}`,
      '↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip',
    ];
    const width = Math.max(...lines.map(line => line.length));
    return [`┌${'─'.repeat(width + 2)}┐`, ...lines.map(line => `│ ${line.padEnd(width)} │`), `└${'─'.repeat(width + 2)}┘`].join('\n');
  }

  private processChunk(chunk: string): void {
    // Realistic cursor-agent/Ink Ctrl+U hazard: `startsWith('\x15')` clears input and returns early,
    // silently discarding any bracketed paste coalesced into the same stdin read.
    if (chunk.startsWith('\x15')) {
      if (chunk.length > 1) this.coalescedDrops += 1;
      if (this.focus === 2) this.otherText = '';
      return;
    }
    let rest = chunk;
    while (rest.length > 0) {
      if (rest.startsWith('\x1b[200~')) {
        const end = rest.indexOf('\x1b[201~');
        const body = end >= 0 ? rest.slice(6, end) : rest.slice(6);
        if (this.focus === 2) this.otherText += body;
        rest = end >= 0 ? rest.slice(end + 6) : '';
      } else if (rest.startsWith('\x1b[B')) {
        this.focus = Math.min(2, this.focus + 1);
        rest = rest.slice(3);
      } else if (rest.startsWith('\x1b[A')) {
        this.focus = Math.max(0, this.focus - 1);
        rest = rest.slice(3);
      } else if (rest.startsWith('\x1b[F')) {
        rest = rest.slice(3);
      } else if (rest.startsWith('\x15')) {
        if (this.focus === 2) this.otherText = '';
        rest = rest.slice(1);
      } else if (rest.startsWith('\r')) {
        this.submitted = true;
        rest = rest.slice(1);
      } else {
        rest = rest.slice(1);
      }
    }
  }

  terminalService(): TerminalService {
    const control: TerminalInteractionControl = {
      screen: async () => this.drainAndRender(),
      keys: async keys => {
        this.emittedKeys.push(...keys);
        for (const key of keys) this.writeRaw(KEY_WIRE[key] ?? key);
      },
      paste: async (text, submit) => {
        this.pasteCount += 1;
        this.writeRaw(`\x1b[200~${text}\x1b[201~${submit ? '\r' : ''}`);
      },
    };
    return {
      get: async () => ({ id: 'terminal-1', epoch: 1, state: 'running' }),
      screen: async () => this.drainAndRender(),
      withInteraction: async <T>(_id: string, task: (control: TerminalInteractionControl) => Promise<T>) => await task(control),
    } as unknown as TerminalService;
  }
}

describe('TUI physical-channel adversarial contract (T1–T3)', () => {
  it('negative control: coalesced Ctrl+U + bracketed paste silently drops the paste on a stalled TUI', () => {
    const channel = new HostileTuiQuestionChannel('stale');
    channel.focus = 2;
    // Unisolated write: C-u followed immediately by bracketed paste without an intervening repaint.
    channel.writeRaw('\x15');
    channel.writeRaw('\x1b[200~important answer\x1b[201~');
    channel.drainAndRender();
    expect(channel.coalescedDrops).toBe(1);
    expect(channel.otherText).toBe('');
  });

  it('T1 + T3: empty Other field emits zero Ctrl+U/Ctrl+K and delivers bracketed paste intact once', async () => {
    const channel = new HostileTuiQuestionChannel('');
    const interactions = new NativeInteractions(channel.terminalService());
    const shown = await interactions.current(session);
    expect(shown?.kind).toBe('question');

    await interactions.respond(session, {
      requestId: 'req-empty',
      interactionId: shown!.id,
      revision: shown!.revision,
      action: 'answer',
      otherText: 'ship unified guardrails',
    });

    expect(channel.emittedKeys).not.toContain('C-u');
    expect(channel.emittedKeys).not.toContain('C-k');
    expect(channel.coalescedDrops).toBe(0);
    expect(channel.pasteCount).toBe(1);
    expect(channel.otherText).toBe('ship unified guardrails');
    expect(channel.submitted).toBe(true);
  });

  it('T2 + T3: dirty Other field isolates Ctrl+U repaint from bracketed paste with zero coalesced drops', async () => {
    const channel = new HostileTuiQuestionChannel('old draft text');
    const interactions = new NativeInteractions(channel.terminalService());
    const shown = await interactions.current(session);
    expect(shown?.kind).toBe('question');

    await interactions.respond(session, {
      requestId: 'req-dirty',
      interactionId: shown!.id,
      revision: shown!.revision,
      action: 'answer',
      otherText: 'fresh clean answer',
    });

    expect(channel.emittedKeys).toContain('C-u');
    expect(channel.coalescedDrops).toBe(0);
    expect(channel.pasteCount).toBe(1);
    expect(channel.otherText).toBe('fresh clean answer');
    expect(channel.submitted).toBe(true);
  });
});
