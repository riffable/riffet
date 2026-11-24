import type { CouncilDiscussion, CouncilReviewTask } from '../../../../../packages/contracts/src/index.js';
import { languageRule, lengthCap, SEAT_RULE, seatsOf, speak, spoken, type FormatSpec, type SpeechPrompt, type Step } from './shared.js';

/**
 * Review: each reviewer reads the document from its own angle and proposes paragraph edits
 * (round 1); the reader accepts some; the editor merges the accepted ones into a revised document.
 */

export const REVIEW_TASKS: readonly CouncilReviewTask[] = ['correct', 'augment', 'diagnose', 'restructure'];

const FOCUS: Record<CouncilReviewTask, string> = {
  correct: '你负责纠错。检查事实错误、推理矛盾、遗漏的边界情况，以及按原文无法执行的说法。',
  augment: '你负责补充遗漏。找出未说明的前提、缺失的分支或状态，以及遗漏的失败处理和权限要求。',
  diagnose: '你负责审阅风险。检查安全、性能和兼容性风险，指出隐含假设以及读者作判断时还缺少的信息。',
  restructure: '你负责审阅结构。检查段落顺序，指出哪些背景需要提前交代、哪些段落混杂了不同主题。',
};

function numbered(d: CouncilDiscussion): string {
  return `${d.document?.title ? `文档：${d.document.title}\n\n` : ''}${(d.document?.paragraphs ?? []).map(p => `[${p.id}] ${p.text}`).join('\n\n')}`;
}

const EDITS_SHAPE = '{"edits":[{"para":"P3","title":"修改要点","before":"从该段逐字摘录的原文","after":"替换后的完整文字"}]}';

const REVIEW: SpeechPrompt = {
  task: `从你的审阅角度，向读者说明最值得关注的问题。审阅意见${lengthCap(300)}。`,
  record: `${EDITS_SHAPE}\n提出一至四条修改建议，最重要的排在前面。before 必须与段落原文逐字一致。如需在段末追加内容，before 填写原段最后一句，after 填写这句话及要追加的内容。`,
};

function mergeTask(d: CouncilDiscussion): SpeechPrompt {
  const accepted = new Set(d.accepted ?? []);
  const edits = d.speeches.flatMap(s => s.directive?.kind === 'edits' ? s.directive.edits : []).filter(e => accepted.has(e.id));
  const changes = edits.map(edit => {
    const change = edit.before ? `原文：${edit.before}\n  替换为：${edit.after}` : `在段末追加：${edit.after}`;
    return `- [${edit.para}] ${edit.title}\n  ${change}`;
  });
  return {
    task: [
      '读者已采纳以下修改：',
      ...changes,
      '',
      '将已采纳的修改应用到原文，其他内容照原样保留。用 Markdown 输出完整修订稿，去掉审阅用的段落标签，不附加说明。',
    ].join('\n'),
  };
}

export const review: FormatSpec = {
  brief(d, seat) {
    const lead = seat.role === 'editor'
      ? '你负责修订文档。其他模型会先提出修改建议，读者选定后，由你把已采纳的建议合并成完整修订稿。'
      : `${FOCUS[seat.task ?? 'correct']}只从这个角度审阅。文中的 [P1]、[P2] 等标记是段落编号。`;
    return [lead, SEAT_RULE, languageRule('文档'), '', numbered(d)].join('\n');
  },
  // Reviews are independent, and the editor works from the accepted edits alone.
  hears: () => false,
  plan(d): Step {
    if (d.round === 1) {
      const missing = seatsOf(d, 'reviewer').filter(s => !spoken(d, 1, 'review', s.id));
      if (missing.length) return speak(...missing.map(s => ({ seatId: s.id, round: 1, phase: 'review' as const, prompt: REVIEW })));
      return { kind: 'round-end' };
    }
    if (spoken(d, 2, 'conclusion') || !(d.accepted ?? []).length) return { kind: 'done' };
    return speak({ seatId: seatsOf(d, 'editor')[0]!.id, round: 2, phase: 'conclusion', prompt: mergeTask(d) });
  },
  autoAdvance(d) {
    if (d.accepted?.length) return;
    d.accepted = d.speeches.flatMap(s => s.directive?.kind === 'edits' ? s.directive.edits.map(e => e.id) : []);
  },
  conclude() {},
};
