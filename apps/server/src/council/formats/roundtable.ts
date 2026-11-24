import { councilSuggestsClosing, type CouncilDiscussion, type CouncilModeration } from '../../../../../packages/contracts/src/index.js';
import { repeatedRoundCount } from './roundtable-repetition.js';
import {
  languageRule, lengthCap, NAME_RULE, recordSeatIds, SEAT_RULE, seatsOf, speak, speaker, spoken,
  type FormatSpec, type SpeechPrompt, type Step,
} from './shared.js';

/**
 * Free debate among several models. Each round all speak at once, unaware of each other's current
 * speech; then the moderator sums up and records who challenged whom, which next round's prompts
 * put to the challenged. It ends on the moderator's call (in `auto`), the round limit or the reader.
 */

const CONCISE_PROSE = '直接在回复中写正文，不生成文件或附件。自然表达，不使用 Markdown 标题，只对关键词或短语加粗，段落之间留一个空行。';

/** Per-speech cap: at most the 1v1 debate's 700, shrinking only when many debaters share the round. */
function characterLimit(debaters: number, repeatedRounds: number): number {
  const limit = Math.min(700, Math.max(400, Math.floor(3600 / debaters)));
  if (repeatedRounds >= 2) return Math.max(200, Math.floor(limit * 0.5));
  if (repeatedRounds === 1) return Math.max(300, Math.floor(limit * 0.7));
  return limit;
}

function statementTask(d: CouncilDiscussion, seatId: string, limit: number, repeatedRounds: number, moderation?: CouncilModeration): SpeechPrompt {
  const round = d.round;
  const challenges = moderation?.challenges.filter(c => c.to === seatId) ?? [];
  return {
    task: [
      `第 ${round} 轮。辩手同时发言，你看不到他人在本轮的回答。第一句亮明你的核心主张或选择。`,
      round === 1
        ? '首轮给出你的立场和理由。'
        : '挑出上一轮最值得回应的论点，篇幅按论点分量分配。薄弱或无关的论点略过即可。直接向你提出的质疑要逐一回应，可以反驳、承认或解释它为什么不影响你的立场。立场未变时，用新论据或新角度推进，避免重复。主持人提出的新切口值得探讨时，可沿它推进。',
      '如果议题的前提或讨论方式有根本问题，可以质疑它，也可以说明你掌握的信息和推理有哪些局限。读者补充中与议题有关的材料可纳入论证。',
      challenges.length ? `上一轮向你提出的质疑：\n${challenges.map(c => `- ${speaker(d, c.from)}：${c.point}`).join('\n')}` : '',
      moderation?.unanswered ? `主持人指出上一轮仍有待回应的关键问题：${moderation.unanswered}\n请回应这个问题，或解释它为什么不影响你的判断。` : '',
      repeatedRounds > 0 ? '最近的发言有较多重复，本轮请引入新证据或未讨论的角度。' : '',
      `发言${lengthCap(limit)}，上限不必用满。`,
      CONCISE_PROSE,
    ].filter(Boolean).join('\n'),
  };
}

const MODERATION_SHAPE = '{"positions":[{"seatId":"s1","stance":"一句话概括立场"}],"challenges":[{"from":"s1","to":"s2","point":"一句话概括质疑"}],"unanswered":null,"convergence":"divergent","action":"continue"}';

const PARALLEL_ROUND = '本轮辩手并行发言，彼此看不到对方本轮刚提出的观点。区分对旧论点的真实交锋、有机会却回避的旧问题，以及本轮才出现、尚无机会回应的新论点。';

function summaryTask(d: CouncilDiscussion): SpeechPrompt {
  const round = d.round;
  const needsNewAngle = round < d.maxRounds && repeatedRoundCount(d, round) >= 2;
  return {
    task: [
      `第 ${round} 轮发言已结束。以主持人身份，为读者总结这一轮。`,
      PARALLEL_ROUND,
      round === 1 ? '首轮只比较各自提出的主张、前提和依据。独立提出不同看法不算互相反驳。' : '说明谁回应了此前的哪条论点，以及这次回应给讨论带来了什么。',
      '聚焦本轮的新论点、新证据和盲区。指出关键分歧落在哪个前提，以及哪条论证更站得住脚、为什么。同样有深度的论证，留意谁把推理讲得更清楚。重复或空泛的发言一句带过，无需逐人罗列立场。把整个讨论的脉络留到终评。',
      '当共识缺少论证、关键前提长期无人检验、辩手各说各话或大家回避同一个关键问题时，可以在末尾追问。每轮最多一个，点名并引用具体轮次的论述，直接问关键问题。没有值得追问的就省略。',
      needsNewAngle ? '连续两轮新增内容有限。如果还有一个未触及、足以打破重复的角度，优先把它作为小结末尾唯一的问题交给下一轮。找不到这样的角度时省略。' : '',
      `小结${lengthCap(600)}。`,
      CONCISE_PROSE,
    ].filter(Boolean).join('\n'),
    record: [
      MODERATION_SHAPE, recordSeatIds(d, 'debater'),
      '根据本轮辩手的原始发言核对记录。positions 用一句话概括每位已发言辩手的当前立场，反映立场变化。',
      'challenges 仅记录本轮真正发生的定向挑战，指出谁用什么论点质疑了谁。彼此独立提出的不同意见和泛泛的「不同意」均不算。没有时填空数组。',
      'unanswered 最多填一个关键问题。只有辩手本轮有机会回答却都回避时才填入。本轮才提出的论点和主持人为下一轮提出的问题留在小结，没有符合条件的问题则填 null。',
      'convergence 表示共识程度：立场明显对立填 divergent，局部一致但核心仍有分歧填 partial，主要立场一致但细节有分歧填 converging，各方实质达成共识填 consensus。没有论证支撑的附和不算共识。',
      'action 表示下一步。有值得追问的新切口或仍能推进的分歧，填 continue，即使各方已对当前论点达成共识也继续。确认讨论可以收尾时填 conclude。措辞重复时先寻找新的切入角度。',
    ].join('\n'),
  };
}

const CONCLUSION: SpeechPrompt = {
  task: [
    '讨论已经结束。综合全部轮次，作为主持人为读者写终评。',
    '先用两三句交代起点、终点和改变讨论的关键转折，再给读者一句最值得带走的判断，直接回答议题。',
    '按实际情况补充经交锋形成的共识及其成立条件，或仍无法弥合的分歧、各方的前提和能改变判断的证据。如果某位辩手打破僵局、提出被采纳的论点或给出有效反驳，点明他怎样改变了讨论。确有跳出议题框架或直面自身局限的洞察时，再说明它的价值。只写有依据的部分。',
    `终评${lengthCap(800)}。`,
    CONCISE_PROSE,
  ].join('\n'),
};

export const roundtable: FormatSpec = {
  brief(d, seat) {
    const debaters = seatsOf(d, 'debater');
    if (seat.role === 'moderator') {
      return [
        `你是这场圆桌讨论的主持人，辩手包括 ${debaters.map(s => speaker(d, s.id)).join('、')}。每轮总结讨论的推进和最重要的分歧，最后综合各轮写出终评。由辩手自行决定回应谁、如何论证和是否改变立场。`,
        SEAT_RULE, NAME_RULE, languageRule('题目'), '', `议题：${d.topic}`,
      ].join('\n');
    }
    return [
      `你是参加圆桌讨论的 ${debaters.length} 个 AI 模型之一。不同模型的训练和推理方式各有侧重，请独立判断，只有论证和证据说服你时才改变立场。`,
      `你的显示名称是 ${speaker(d, seat.id)}。其他辩手包括 ${debaters.filter(s => s.id !== seat.id).map(s => speaker(d, s.id)).join('、')}。主持人会在每轮结束后做小结。`,
      SEAT_RULE, NAME_RULE, languageRule('题目'), '', `议题：${d.topic}`,
    ].join('\n');
  },
  // Resuming an interrupted round can leave completed peers. A retried debater still speaks blind.
  hears: (d, seat, speech) => seat.role !== 'debater' || speech.round < d.round,
  plan(d): Step {
    const round = d.round;
    const moderator = seatsOf(d, 'moderator')[0]!.id;
    const conclusion = () => spoken(d, round, 'conclusion') ? { kind: 'done' as const } : speak({ seatId: moderator, round, phase: 'conclusion', prompt: CONCLUSION });
    if (d.concluding) return conclusion();
    const debaters = seatsOf(d, 'debater');
    const missing = debaters.filter(s => !spoken(d, round, 'statement', s.id));
    if (missing.length) {
      const previous = spoken(d, round - 1, 'summary')?.directive;
      const moderation = previous?.kind === 'moderation' ? previous : undefined;
      const repeatedRounds = round > 1 ? repeatedRoundCount(d, round - 1) : 0;
      const limit = characterLimit(debaters.length, repeatedRounds);
      return speak(...missing.map(s => ({
        seatId: s.id, round, phase: 'statement' as const,
        prompt: statementTask(d, s.id, limit, repeatedRounds, moderation),
      })));
    }
    if (!spoken(d, round, 'summary')) return speak({ seatId: moderator, round, phase: 'summary', prompt: summaryTask(d) });
    if (round >= d.maxRounds) return conclusion();
    return { kind: 'round-end' };
  },
  autoAdvance(d) {
    if (councilSuggestsClosing(d)) d.concluding = true;
  },
  conclude(d) {
    d.concluding = true;
  },
};
