import { describe, expect, it } from 'vitest';
import { MODEL_CHAT_DEFAULT_CONFIG } from '../../../../../packages/contracts/src/index.js';
import {
  activePathOf,
  activeRecordsOf,
  assembleContext,
  buildChatTree,
  contextOf,
  resolveEffectiveParentId,
  type ChatRecord,
} from './history.js';

const at = '2026-10-31T00:00:00.000Z';
const turn = (n: number, size = 10): ChatRecord[] => [
  { kind: 'user', id: `u${n}`, turnId: `t${n}`, at, text: `q${n} ${'x'.repeat(size)}`, commandId: `c${n}` },
  { kind: 'assistant', id: `a${n}`, turnId: `t${n}`, at, text: `a${n} ${'y'.repeat(size)}`, status: 'completed' },
];

describe('contextOf', () => {
  it('starts after a clear, then after the newest summary, and keeps the newest turns within the budget', () => {
    const records: ChatRecord[] = [...turn(1), { kind: 'clear', id: 'k', turnId: 'tk', at, commandId: 'ck' }, ...turn(2), ...turn(3), ...turn(4)];
    expect(contextOf(records, 'next', 10_000).messages.map(message => message.content.split(' ')[0])).toEqual(['q2', 'a2', 'q3', 'a3', 'q4', 'a4', 'next']);
    const summarized: ChatRecord[] = [...records, { kind: 'summary', id: 's', at, upTo: 'a3', text: 'earlier' }];
    const context = contextOf(summarized, 'next', 10_000);
    expect(context.summary).toBe('earlier');
    expect(context.messages.map(message => message.content.split(' ')[0])).toEqual(['q4', 'a4', 'next']);
    // A summary from before the last clear says nothing about what follows it.
    expect(contextOf([...summarized, { kind: 'clear', id: 'k2', turnId: 'tk2', at, commandId: 'ck2' }], 'next', 10_000)).toEqual({ messages: [{ role: 'user', content: 'next' }], dropped: 0 });
    const tight = contextOf([...turn(5, 400), ...turn(6, 400)], 'next', 400);
    expect(tight.dropped).toBe(1);
    expect(tight.messages.map(message => message.content.split(' ')[0])).toEqual(['q6', 'a6', 'next']);
  });
});

describe('buildChatTree, activePathOf and activeRecordsOf', () => {
  it('reconstructs branches, overlays assistant_edit and turn_flag, and respects branch_select', () => {
    const records: ChatRecord[] = [
      { kind: 'user', id: 'u1', turnId: 't1', at, text: 'root q', commandId: 'c1' },
      { kind: 'assistant', id: 'a1', parentId: 'u1', turnId: 't1', at, text: 'root a', status: 'completed', wireBlobRef: 'a1' },
      { kind: 'user', id: 'u2a', parentId: 'a1', turnId: 't2a', at, text: 'branch A q', commandId: 'c2a' },
      { kind: 'assistant', id: 'a2a', parentId: 'u2a', turnId: 't2a', at, text: 'branch A a', status: 'completed' },
      { kind: 'user', id: 'u2b', parentId: 'a1', turnId: 't2b', at, text: 'branch B q', commandId: 'c2b', editedFrom: 'u2a' },
      { kind: 'assistant', id: 'a2b', parentId: 'u2b', turnId: 't2b', at, text: 'branch B a', status: 'completed' },
      { kind: 'assistant_edit', id: 'e1', at, targetId: 'a1', text: 'edited root a' },
      { kind: 'turn_flag', id: 'f1', at, userId: 'u1', pinned: true },
      { kind: 'turn_flag', id: 'f2', at, userId: 'u2a', muted: true },
      { kind: 'branch_select', id: 'b1', at, leafId: 'a2a' },
    ];
    const tree = buildChatTree(records, MODEL_CHAT_DEFAULT_CONFIG);
    expect(tree.activeLeafId).toBe('a2a');
    expect(activePathOf(tree.nodes, tree.activeLeafId).map(n => n.id)).toEqual(['u1', 'a1', 'u2a', 'a2a']);
    const a1 = tree.nodes.find(n => n.id === 'a1');
    expect(a1).toMatchObject({ kind: 'assistant', text: 'edited root a', edited: true, hasWire: true });
    const u1 = tree.nodes.find(n => n.id === 'u1');
    expect(u1).toMatchObject({ kind: 'user', pinned: true });
    const u2a = tree.nodes.find(n => n.id === 'u2a');
    expect(u2a).toMatchObject({ kind: 'user', muted: true });

    // activeRecordsOf projects only the selected branch with assistant_edit applied.
    const projected = activeRecordsOf(records);
    expect(projected.map(r => r.id)).toEqual(['u1', 'a1', 'u2a', 'a2a']);
    expect(projected[1]).toMatchObject({ kind: 'assistant', text: 'edited root a' });
  });

  it('handles legacy JSONL missing parentId and explicit root edit forks', () => {
    const legacy = [...turn(1), ...turn(2)];
    const legacyTree = buildChatTree(legacy);
    expect(activePathOf(legacyTree.nodes, legacyTree.activeLeafId).map(n => n.id)).toEqual(['u1', 'a1', 'u2', 'a2']);

    const forkedRoot: ChatRecord[] = [
      { kind: 'user', id: 'u1', turnId: 't1', at, text: 'v1', commandId: 'c1' },
      { kind: 'assistant', id: 'a1', parentId: 'u1', turnId: 't1', at, text: 'ans1', status: 'completed' },
      { kind: 'user', id: 'u1b', turnId: 't1b', at, text: 'v2', commandId: 'c1b', editedFrom: 'u1' },
      { kind: 'assistant', id: 'a1b', parentId: 'u1b', turnId: 't1b', at, text: 'ans2', status: 'completed' },
    ];
    const forkTree = buildChatTree(forkedRoot);
    expect(forkTree.activeLeafId).toBe('a1b');
    expect(activePathOf(forkTree.nodes, forkTree.activeLeafId).map(n => n.id)).toEqual(['u1b', 'a1b']);
  });

  it('resolves effective parentId for legacy JSONL edit forks and stops traversal at rootFork: true', () => {
    const legacy: ChatRecord[] = [...turn(1), ...turn(2)];
    expect(resolveEffectiveParentId(legacy, 'u1')).toBeUndefined();
    expect(resolveEffectiveParentId(legacy, 'u2')).toBe('a1');

    // Editing u2 on a legacy JSONL links the edited turn to `a1`, preserving turn 1.
    const editedParent = resolveEffectiveParentId(legacy, 'u2');
    const withEditedU2: ChatRecord[] = [
      ...legacy,
      { kind: 'user', id: 'u2b', parentId: editedParent, turnId: 't2b', at, text: 'edited q2', commandId: 'c2b', editedFrom: 'u2' },
      { kind: 'assistant', id: 'a2b', parentId: 'u2b', turnId: 't2b', at, text: 'edited a2', status: 'completed' },
    ];
    const editedTree = buildChatTree(withEditedU2);
    expect(activePathOf(editedTree.nodes, editedTree.activeLeafId).map(n => n.id)).toEqual(['u1', 'a1', 'u2b', 'a2b']);

    // Explicit root fork (`rootFork: true`, without `editedFrom`) on a legacy JSONL never stitches prior turns.
    const withRootFork: ChatRecord[] = [
      ...legacy,
      { kind: 'user', id: 'u_root', rootFork: true, turnId: 'tr', at, text: 'brand new root', commandId: 'cr' },
      { kind: 'assistant', id: 'a_root', parentId: 'u_root', turnId: 'tr', at, text: 'fresh ans', status: 'completed' },
    ];
    const rootTree = buildChatTree(withRootFork);
    expect(activePathOf(rootTree.nodes, rootTree.activeLeafId).map(n => n.id)).toEqual(['u_root', 'a_root']);
    expect(activePathOf(rootTree.nodes, 'u_root').map(n => n.id)).toEqual(['u_root']);
    expect(resolveEffectiveParentId(withRootFork, 'u_root')).toBeUndefined();
  });
});

describe('assembleContext', () => {
  const baseRecords = (): ChatRecord[] => [
    { kind: 'user', id: 'u1', turnId: 't1', at, text: `q1 ${'a'.repeat(300)}`, commandId: 'c1' },
    { kind: 'assistant', id: 'a1', parentId: 'u1', turnId: 't1', at, text: `r1 ${'b'.repeat(300)}`, status: 'completed' },
    { kind: 'user', id: 'u2', parentId: 'a1', turnId: 't2', at, text: `q2 ${'c'.repeat(300)}`, commandId: 'c2' },
    { kind: 'assistant', id: 'a2', parentId: 'u2', turnId: 't2', at, text: `r2 ${'d'.repeat(300)}`, status: 'completed' },
    { kind: 'user', id: 'u3', parentId: 'a2', turnId: 't3', at, text: `q3 ${'e'.repeat(300)}`, commandId: 'c3' },
    { kind: 'assistant', id: 'a3', parentId: 'u3', turnId: 't3', at, text: `r3 ${'f'.repeat(300)}`, status: 'completed' },
  ];

  it('respects stateless, full, window, bareMode, pinned, muted and pinnedDocs', () => {
    // bareMode + stateless: zero system prompt, no history
    const statelessTree = buildChatTree([
      ...baseRecords(),
      { kind: 'config_patch', id: 'cp1', at, config: { bareMode: true, contextStrategy: 'stateless', systemPrompt: 'ignored in bare mode' } },
    ]);
    const stateless = assembleContext(statelessTree, { defaultSystemPrompt: 'host prompt', nextUserText: 'fresh question' });
    expect(stateless.system).toBeUndefined();
    expect(stateless.messages).toEqual([{ role: 'user', content: 'fresh question' }]);
    expect(stateless.tokenBreakdown.includedTurnIds).toEqual([]);
    expect(stateless.tokenBreakdown.droppedTurnIds).toEqual(['u1', 'u2', 'u3']);

    // full strategy with muted turn + pinnedDocs
    const fullTree = buildChatTree([
      ...baseRecords(),
      { kind: 'turn_flag', id: 'f2', at, userId: 'u2', muted: true },
      { kind: 'pinned_docs', id: 'pd1', at, docs: [{ id: 'd1', name: 'spec.md', text: 'important spec', tokens: 10, pinned: true }] },
      { kind: 'config_patch', id: 'cp2', at, config: { contextStrategy: 'full', systemPrompt: 'custom sys' } },
    ]);
    const full = assembleContext(fullTree, { nextUserText: 'next' });
    expect(full.system).toContain('custom sys');
    expect(full.system).toContain('spec.md');
    expect(full.tokenBreakdown.includedTurnIds).toEqual(['u1', 'u3']);
    expect(full.tokenBreakdown.droppedTurnIds).toEqual(['u2']);
    expect(full.tokenBreakdown.pinnedDocsTokens).toBeGreaterThan(0);

    // window strategy: pinned u1 is forced to stay even when tight budget drops u2
    const windowTree = buildChatTree([
      ...baseRecords(),
      { kind: 'turn_flag', id: 'f1', at, userId: 'u1', pinned: true },
      { kind: 'config_patch', id: 'cp3', at, config: { contextStrategy: 'window', contextBudget: 420 } },
    ]);
    const windowed = assembleContext(windowTree, { nextUserText: 'next' });
    expect(windowed.tokenBreakdown.includedTurnIds).toEqual(['u1', 'u3']);
    expect(windowed.tokenBreakdown.droppedTurnIds).toEqual(['u2']);
    expect(windowed.dropped).toBe(1);
  });

  it('prevents manual summaries from leaking across /clear and trims window contiguously without skipping turns', () => {
    // Manual summary written before `/clear` must not leak into post-clear tree or context.
    const clearedRecords: ChatRecord[] = [
      { kind: 'user', id: 'u1', turnId: 't1', at, text: 'old q', commandId: 'c1' },
      { kind: 'assistant', id: 'a1', parentId: 'u1', turnId: 't1', at, text: 'old a', status: 'completed' },
      { kind: 'summary', id: 's_manual', at, upTo: '', text: 'secret pre-clear manual summary', manual: true },
      { kind: 'clear', id: 'k1', parentId: 'a1', turnId: 'tk1', at, commandId: 'ck1' },
      { kind: 'user', id: 'u2', parentId: 'k1', turnId: 't2', at, text: 'new q', commandId: 'c2' },
      { kind: 'assistant', id: 'a2', parentId: 'u2', turnId: 't2', at, text: 'new a', status: 'completed' },
    ];
    const clearedTree = buildChatTree(clearedRecords);
    expect(clearedTree.summary).toBe('');
    expect(clearedTree.summaryManual).toBeUndefined();
    const afterClear = assembleContext(clearedTree, { nextUserText: 'next' });
    expect(afterClear.system ?? '').not.toContain('secret pre-clear manual summary');
    expect(afterClear.tokenBreakdown.summaryTokens).toBe(0);

    // A manual summary written AFTER `/clear` still applies.
    const postClearManualTree = buildChatTree([
      ...clearedRecords,
      { kind: 'summary', id: 's_after', at, upTo: '', text: 'post-clear summary', manual: true },
    ]);
    expect(postClearManualTree.summary).toBe('post-clear summary');
    expect(assembleContext(postClearManualTree, { nextUserText: 'next' }).system).toContain('post-clear summary');

    // Window strategy: when u2 is too large for remaining budget, break immediately so u1 is not jumped over to.
    const gapRecords: ChatRecord[] = [
      { kind: 'user', id: 'u1', turnId: 't1', at, text: 'tiny q1', commandId: 'c1' },
      { kind: 'assistant', id: 'a1', parentId: 'u1', turnId: 't1', at, text: 'tiny a1', status: 'completed' },
      { kind: 'user', id: 'u2', parentId: 'a1', turnId: 't2', at, text: `huge ${'x'.repeat(2000)}`, commandId: 'c2' },
      { kind: 'assistant', id: 'a2', parentId: 'u2', turnId: 't2', at, text: `huge ${'y'.repeat(2000)}`, status: 'completed' },
      { kind: 'user', id: 'u3', parentId: 'a2', turnId: 't3', at, text: 'tiny q3', commandId: 'c3' },
      { kind: 'assistant', id: 'a3', parentId: 'u3', turnId: 't3', at, text: 'tiny a3', status: 'completed' },
      { kind: 'config_patch', id: 'cp_win', at, config: { contextStrategy: 'window', contextBudget: 200 } },
    ];
    const gapTree = buildChatTree(gapRecords);
    const assembled = assembleContext(gapTree, { nextUserText: 'next' });
    expect(assembled.tokenBreakdown.includedTurnIds).toEqual(['u3']);
    expect(assembled.tokenBreakdown.droppedTurnIds).toEqual(['u1', 'u2']);
  });
});
