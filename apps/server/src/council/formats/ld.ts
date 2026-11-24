import { councilSuggestsClosing, type CouncilDiscussion } from '../../../../../packages/contracts/src/index.js';
import { closingRoundOf, languageRule, lengthCap, SEAT_RULE, speak, spoken, type FormatSpec, type SpeechPrompt, type Step } from './shared.js';

/**
 * One-on-one Lincoln-Douglas debate. Pro carries the burden of proof, con holds presumption. Within a
 * round they speak in turn — pro first, except in the closing round, where con speaks first and pro
 * has the last word. Outside closing, each speech ends with questions for the other side's next
 * speech. The judge keeps a ledger after each of those rounds and gives a verdict after closing.
 */

type Side = 'pro' | 'con';
type DebatePhase = 'opening' | 'rebuttal' | 'closing';
const SIDE_NAME: Record<Side, string> = { pro: '正方', con: '反方' };

const DEBATER_DUTY: Record<Side, string> = {
  pro: '你承担举证责任，必须主动证明命题成立。未能证明命题成立，裁判判反方胜。',
  con: '平局判反方胜。你仍须针对正方的关键前提、证据或推理作出实质反驳，指出它为何无法成立。',
};
const STANCE_RULES = '为分配给你的一方构建最有力的论证。可以质疑对方的框架，改换立场视为弃赛。论证要立足真实的考量，严禁编造事实或曲解对方发言。';
const ANSWER_RULE = '有质询时，先逐条正面回答。每道质询的第一句直接给出是或否、明确的数值或具体取舍，然后解释。裁判会把有机会却未正面回答的质询记为回避。';
const QUESTION_RULE = '在发言结尾单独一行写 `---`，接着用编号列表提出一到两个具体、尖锐、能用一句话回答的质询。问题应逼出明确让步或检验对方最薄弱的环节，避免开放式大题。列表之后不再写其他内容。';
const DEBATE_STYLE = '直接在回复中写正文，省略礼貌性开场、思考过程和自我评论。使用自然的口语表达，段落间空一行，不用 Markdown 标题，加粗只用于关键词或短语。不要另建文件。';

function phaseOf(d: CouncilDiscussion, round: number): DebatePhase {
  if (round >= closingRoundOf(d)) return 'closing';
  return round === 1 ? 'opening' : 'rebuttal';
}

function phaseRules(phase: DebatePhase, side: Side): string {
  if (phase === 'opening') {
    return side === 'pro'
      ? '由你先立论。用一句话概括主张，再提出最有力的两到三条论点，逐条说明依据。'
      : '这是你的立论。先回答正方本轮结尾的质询，再陈述反方的论证，并反驳正方立论。';
  }
  if (phase === 'rebuttal') {
    const questions = side === 'pro' ? '反方上一轮末尾的质询' : '正方本轮末尾的质询';
    return `这是你的驳论。先回答${questions}，再实质反驳对方最新的有力论点，用新论据或新角度补强己方论证。不要复述此前的发言。`;
  }
  const order = side === 'con' ? '你先结辩，正方随后发言。' : '你的结辩是全场最后一次辩手发言。';
  return `${order}先回答此前仍待你正面作答的质询，查阅结辩前对方提出的问题。然后总结己方最有力的一到两条论证和对方最关键的漏洞，说明它们怎样影响裁决。结辩只讨论已经提出的论点和证据，不提出新论点、新证据或新质询。`;
}

function ledgerOfRound(d: CouncilDiscussion, round: number) {
  const directive = spoken(d, round, 'ledger')?.directive;
  return directive?.kind === 'ledger' ? directive : undefined;
}

function debaterTask(d: CouncilDiscussion, side: Side, phase: DebatePhase, round: number): SpeechPrompt {
  const incoming = ledgerOfRound(d, round - 1)?.crossExam.filter(q => q.asker !== side) ?? [];
  const pending = incoming.filter(q => q.answered === 'pending').map(q => `- ${q.question}`);
  const dodged = incoming.filter(q => q.answered === 'dodged').map(q => `- ${q.question}`);
  return {
    task: [
      `第 ${round} 轮。请以${SIDE_NAME[side]}身份发言。`,
      ...(round > 1 ? [DEBATER_DUTY[side], STANCE_RULES] : []),
      pending.length ? `上一轮还未轮到你回答的质询，本轮请正面回答：\n${pending.join('\n')}` : '',
      dodged.length ? `上一轮裁判记下的回避，本轮请补答：\n${dodged.join('\n')}` : '',
      phaseRules(phase, side),
      phase !== 'opening' || side === 'con' ? ANSWER_RULE : '',
      phase !== 'closing' ? QUESTION_RULE : '',
      DEBATE_STYLE,
      phase === 'closing' ? `${lengthCap(600)}。` : `${lengthCap(700)}。`,
    ].filter(Boolean).join('\n\n'),
  };
}

const LEDGER_SHAPE = `{
  "sides": {
    "pro": {"claim":"正方当前的核心主张","reinforced":"本轮得到加强的论点","broken":null},
    "con": {"claim":"反方当前的核心主张","reinforced":null,"broken":"被对方揭示的论证缺口"}
  },
  "crossExam": [{"asker":"pro","question":"质询原文","answered":"direct"}],
  "intensity": "clashing",
  "action": "continue"
}`;

const LEDGER_RULES = [
  '两方各记录全场至今最有力的论点、本轮新增或补强的论证，以及被对方击中的漏洞。缺少补强或漏洞时，相应字段填 null。',
  'crossExam 逐条记录本轮应答、已答和仍待答的质询。逐字引用问题，asker 正方用 pro，反方用 con。没有质询时填空数组。',
  'answered 要按实际发言顺序判断。第一句直接作答填 direct。有机会作答却略过问题，或先辩解、绕开明确答案，填 dodged。尚未获得作答机会填 pending，不计回避或失分。例如，反方在本轮最后发言时提出的质询，正方到下一轮才能回答。',
  'intensity 只看攻防是否仍在产生新的论证或反驳。有新交锋填 clashing，双方只在重复旧论证时填 stalling。某方改变立场不是有效推进，双方立场接近也不能作为空转的依据。',
  'action 需要继续驳论时填 continue。有实质理由判断下一轮也只会重复时填 closing，进入结辩。',
].join('\n');

const JUDGE_RULE = '公正呈现双方最扎实的论证。只依据这场辩论中的发言，按各自被分配的立场评估论证质量，剥离立场本身的难度和话术强弱。';
const CROSS_EXAM_JUDGING = '按发言顺序看当事人是否获得回答机会。有机会却未在回答的第一句给出明确答案，记为回避。尚未轮到对方作答的，记为待答，不计失分。';

const ledgerTask = (round: number): SpeechPrompt => ({
  task: [
    `为读者整理第 ${round} 轮的裁判记录。本轮正方先发言，反方看过正方本轮的发言之后作答。`,
    JUDGE_RULE,
    '概括双方当前最有力的论证，指出本轮真正交锋的地方、各自补强的论点和被对方击中的漏洞。直说本轮有何实质推进，重复发言一笔带过。',
    CROSS_EXAM_JUDGING,
    DEBATE_STYLE,
    `${lengthCap(500)}。`,
  ].join('\n\n'),
  record: `${LEDGER_SHAPE}\n${LEDGER_RULES}`,
});

const VERDICT: SpeechPrompt = {
  task: [
    `辩论已结束，反方先结辩，正方最后发言。请给出场内裁决。${JUDGE_RULE}`,
    '1. 用两到三句话呈现正方最有力的论证。',
    '2. 用两到三句话呈现反方最有力的论证。',
    `3. 说明哪些质询击中了关键，点名哪些质询被回避。${CROSS_EXAM_JUDGING}检查双方在结辩中对尚待回答的质询作了什么回应。`,
    '4. 说明剥离双方立场的论证难度后，哪一方的论证更扎实、依据是什么。若难分高下，讲清差异如何来自各自立场。',
    '5. 告诉读者，如果要依据本场辩论作决策，应怎样权衡双方最有分量的理由。',
    DEBATE_STYLE,
    `${lengthCap(800)}。`,
  ].join('\n'),
};

export const ld: FormatSpec = {
  brief(d, seat) {
    const resolution = `辩题：${d.topic}`;
    if (seat.role === 'judge') {
      return [
        '你是两位 AI 模型进行一对一辩论时的裁判。每轮结束后为读者整理本轮记录，结辩后给出裁决。',
        JUDGE_RULE, CROSS_EXAM_JUDGING,
        SEAT_RULE, languageRule('题目'), '', resolution,
      ].join('\n');
    }
    const side = seat.role === 'pro' ? 'pro' : 'con';
    return [
      `你与另一位 AI 模型进行一对一的林肯—道格拉斯式辩论，由第三位模型担任裁判。你全程代表${SIDE_NAME[side]}。`,
      DEBATER_DUTY[side], STANCE_RULES,
      SEAT_RULE, languageRule('题目'), '', resolution,
    ].join('\n');
  },
  plan(d): Step {
    const round = d.round;
    const phase = phaseOf(d, round);
    const order: Side[] = phase === 'closing' ? ['con', 'pro'] : ['pro', 'con'];
    for (const side of order) {
      if (!spoken(d, round, phase, side)) return speak({ seatId: side, round, phase, prompt: debaterTask(d, side, phase, round) });
    }
    if (phase === 'closing') {
      return spoken(d, round, 'conclusion') ? { kind: 'done' } : speak({ seatId: 'judge', round, phase: 'conclusion', prompt: VERDICT });
    }
    if (!spoken(d, round, 'ledger')) return speak({ seatId: 'judge', round, phase: 'ledger', prompt: ledgerTask(round) });
    return { kind: 'round-end' };
  },
  // The judge's notes are for the reader; debaters get only the questions still owed (see `debaterTask`).
  hears: (_d, seat, speech) => seat.role === 'judge' || (speech.phase !== 'ledger' && speech.phase !== 'conclusion'),
  autoAdvance(d) {
    if (councilSuggestsClosing(d)) d.closingRound = Math.min(d.round + 1, d.maxRounds);
  },
  conclude(d) {
    d.closingRound = Math.min(d.round + 1, d.maxRounds);
  },
};
