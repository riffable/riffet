import { describe, expect, it } from 'vitest';
import { subviewPhase, transcriptWorking } from './service.js';

const now = 1_000_000;

describe('transcriptWorking', () => {
  it('counts a store that kept growing after the pane went idle as a turn in progress', () => {
    expect(transcriptWorking({ awaitingReply: true, lastActivityAt: now - 2_000, paneBusyAt: now - 60_000 }, now)).toBe(true);
    // Never seen busy at all: the CLI continued on its own from an idle prompt.
    expect(transcriptWorking({ awaitingReply: true, lastActivityAt: now - 2_000, paneBusyAt: 0 }, now)).toBe(true);
  });

  it('settles once the last message calls nothing', () => {
    expect(transcriptWorking({ awaitingReply: false, lastActivityAt: now - 2_000, paneBusyAt: 0 }, now)).toBe(false);
  });

  it('leaves the writes that close a visible turn to the pane', () => {
    expect(transcriptWorking({ awaitingReply: true, lastActivityAt: now - 2_000, paneBusyAt: now - 3_000 }, now)).toBe(false);
    expect(transcriptWorking({ awaitingReply: true, lastActivityAt: now - 10_000, paneBusyAt: now - 1_000 }, now)).toBe(false);
  });

  it('stops counting a store that has gone quiet', () => {
    expect(transcriptWorking({ awaitingReply: true, lastActivityAt: now - 61_000, paneBusyAt: 0 }, now)).toBe(false);
  });
});

describe('subviewPhase', () => {
  it('is busy while the view shows work', () => {
    expect(subviewPhase({ working: true, previous: 'idle', transcript: { awaitingReply: false, lastActivityAt: 0 } }, now)).toBe('busy');
  });

  it('follows the transcript tail behind the view', () => {
    expect(subviewPhase({ working: false, previous: 'idle', transcript: { awaitingReply: true, lastActivityAt: now - 120_000 } }, now)).toBe('busy');
    expect(subviewPhase({ working: false, previous: 'busy', transcript: { awaitingReply: false, lastActivityAt: now - 2_000 } }, now)).toBe('busy');
    expect(subviewPhase({ working: false, previous: 'busy', transcript: { awaitingReply: false, lastActivityAt: now - 10_000 } }, now)).toBe('idle');
    expect(subviewPhase({ working: false, previous: 'attention', transcript: { awaitingReply: false, lastActivityAt: 0 } }, now)).toBe('idle');
  });

  it('keeps the phase seen before the view without a transcript, and never reports an unknown turn finished', () => {
    expect(subviewPhase({ working: false, previous: 'idle' }, now)).toBe('idle');
    expect(subviewPhase({ working: false, previous: 'busy' }, now)).toBe('busy');
    expect(subviewPhase({ working: false, previous: 'attention' }, now)).toBe('busy');
  });
});
