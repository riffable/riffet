import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { NativeWorkbenchEvent } from '../../../../../../packages/contracts/src/index.js';
import { ClaudeLiveDrafts } from './drafts.js';

const screen = (name: string) => ({ text: readFileSync(fileURLToPath(new URL(`../fixtures/screens/2.1.322/${name}.txt`, import.meta.url)), 'utf8'), cols: 100 });
const at = '2026-11-18T00:00:00.000Z';
const event = (nativeId: string, type: string, text: string, turn = 't1'): NativeWorkbenchEvent =>
  ({ sessionId: 's', nativeId, nativeTurnId: turn, runId: 'run-1', sequence: 0, type, createdAt: at, data: { content: { type: 'text', text } } });
const PROMPT = 'First run the shell command `ls -la` with the Bash tool. Then write about 250 words in Markdown explaining what a resilient job queue needs';

describe('ClaudeLiveDrafts', () => {
  it('drafts only the block the transcript lacks, and takes it back in the commit that writes it', () => {
    const drafts = new ClaudeLiveDrafts({ sessionId: 's', clip: text => text });
    drafts.opened('t1');
    expect(drafts.committed([event('p', 'user_message_chunk', PROMPT), event('a', 'agent_message_chunk', 'The directory contains only a `.git` folder — an empty repo.\n\n# What a Resilient Job Queue Needs')])).toEqual([]);

    const first = drafts.plan('t1', screen('live-after-tool'), at);
    expect(first.retire).toEqual([]);
    expect(first.drafts).toHaveLength(1);
    expect(first.drafts[0]).toMatchObject({ finalId: 'claude-live:t1:1', event: { nativeTurnId: 't1', runId: 'run-1', type: 'agent_message_chunk' } });
    expect(first.drafts[0]!.event.data.content).toMatchObject({ text: expect.stringMatching(/^Now the closing paragraph:\n\nReliability is/) });
    // The same screen again writes nothing.
    expect(drafts.plan('t1', screen('live-after-tool'), at).drafts).toEqual([]);

    expect(drafts.committed([event('b', 'agent_message_chunk', 'Now the closing paragraph:\n\nReliability is ultimately a property of the whole pipeline, as described in the [docs](https://example.com/docs).')])).toEqual(['claude-live:t1:1']);
    // Still drawn, but written: no second copy.
    expect(drafts.plan('t1', screen('live-after-tool'), at)).toEqual({ drafts: [], retire: [], kept: [] });
  });

  it('takes a draft back when its turn is over, and drafts nothing for a turn it did not see open', () => {
    const drafts = new ClaudeLiveDrafts({ sessionId: 's', clip: text => text });
    drafts.opened('t1');
    drafts.committed([event('p', 'user_message_chunk', PROMPT)]);
    expect(drafts.plan('t1', screen('live-text'), at).drafts.map(draft => draft.finalId)).toEqual(['claude-live:t1:0']);
    expect(drafts.plan(undefined, undefined, at).retire).toEqual(['claude-live:t1:0']);

    expect(drafts.watching('t0')).toBe(false);
    expect(drafts.plan('t0', screen('live-text'), at)).toEqual({ drafts: [], retire: [], kept: [] });
  });

  it('keeps the draft of a turn a cut stream failed, unless what it drew is the error', () => {
    const failedTurn = (error: string) => {
      const drafts = new ClaudeLiveDrafts({ sessionId: 's', clip: text => text });
      drafts.opened('t1');
      drafts.committed([event('p', 'user_message_chunk', PROMPT)]);
      const [draft] = drafts.plan('t1', screen('live-text'), at).drafts;
      return { draft: draft!, plan: drafts.plan(undefined, undefined, at, id => id === 't1' ? { error } : undefined), drafts };
    };
    const cut = failedTurn('API Error: Connection lost mid-response. The response above may be incomplete.');
    expect(cut.plan.retire).toEqual([]);
    expect(cut.plan.kept).toEqual([cut.draft.event]);
    // Kept once: the turn has no draft left to keep or take back.
    expect(cut.drafts.plan(undefined, undefined, at, () => ({}))).toEqual({ drafts: [], retire: [], kept: [] });

    const text = (cut.draft.event.data.content as { text: string }).text;
    // The transcript writing the block after all takes the kept copy back, also as Markdown that starts otherwise: never two.
    expect(cut.drafts.committed([event('a', 'agent_message_chunk', `**Note.** ${text}`)])).toEqual(['claude-live:t1:0']);
    const drawn = failedTurn(text);
    expect(drawn.plan).toEqual({ drafts: [], retire: ['claude-live:t1:0'], kept: [] });
  });

  it('keeps the answer a failed request drew its error below', () => {
    const error = 'API Error: Connection lost mid-response. The response above may be incomplete.';
    const answer = screen('live-text');
    const cut = { ...answer, text: answer.text.replace(/\n(─+\n❯\n)/, `\n\n⏺ ${error}\n\n$1`) };
    const drafts = new ClaudeLiveDrafts({ sessionId: 's', clip: text => text });
    drafts.opened('t1');
    drafts.committed([event('p', 'user_message_chunk', PROMPT)]);
    const [drawn] = drafts.plan('t1', answer, at).drafts;
    // The error takes the draft's place while the turn is still open.
    expect(drafts.plan('t1', cut, at).drafts[0]!.event.data.content).toMatchObject({ text: error });
    expect(drafts.plan(undefined, undefined, at, () => ({ error }))).toEqual({ drafts: [], retire: [], kept: [drawn!.event] });
  });

  it('reports a draft its transcript text contradicts', () => {
    const reports: unknown[] = [];
    const drafts = new ClaudeLiveDrafts({ sessionId: 's', clip: text => text, report: drift => reports.push(drift) });
    drafts.opened('t1');
    drafts.committed([event('p', 'user_message_chunk', '不要使用任何工具。用中文写约 500 字的回答')]);
    expect(drafts.plan('t1', screen('live-cjk'), at).drafts).toHaveLength(1);
    drafts.committed([event('a', 'agent_message_chunk', 'Something else entirely, written by another hand and nowhere on the screen.')]);
    expect(reports).toEqual([expect.objectContaining({ sessionId: 's', turnId: 't1', ratio: 0 })]);
  });
});
