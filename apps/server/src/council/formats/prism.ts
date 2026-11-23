import type { CouncilDiscussion } from '../../../../../packages/contracts/src/index.js';
import { languageRule, latestDirective, recordSeatIds, SEAT_RULE, seatsOf, speak, speaker, spoken, type FormatSpec, type SpeechPrompt, type Step } from './shared.js';

/**
 * Prism: the participants answer independently (round 1), the observer probes where they really
 * disagree, each answers the probe aimed at it (round 2), the observer concludes. The differences
 * between models are used for collision, not for dividing the work.
 */

const EXPLORE: SpeechPrompt = {
  task: '独立回答问题，给出你真实的判断。明确表明立场，避免在所有选项之间摇摆。你也可以指出问题本身的缺陷。最多 400 词。',
};

const PROBE_SHAPE = '{"contradictions":[{"title":"简短标题","seats":["p1","p2"],"question":"相关参与者无法回避的问题"}],"gaps":["没人提到的一项约束或风险"]}';

const probeTask = (d: CouncilDiscussion): SpeechPrompt => ({
  task: '找出回答里的实质性分歧，包括前提冲突、同一个词被赋予不同含义、表面上的共识，以及共同忽略的问题。为读者写一段简短的分析，最多 250 词。',
  record: `${PROBE_SHAPE}\n${recordSeatIds(d, 'participant')}\n最多列出四处分歧，把最尖锐的放在最前面。`,
});

function deepenTask(d: CouncilDiscussion, seatId: string): SpeechPrompt {
  const probe = latestDirective(d, 'probe', 'probe');
  const mine = probe?.contradictions.filter(c => c.seats.includes(seatId)) ?? [];
  const questions = mine.length ? mine : probe?.contradictions ?? [];
  return {
    task: [
      questions.length ? `${mine.length ? '观察者向你提出的追问' : '观察者提出的追问'}\n${questions.map(c => `- ${c.title}：${c.question}`).join('\n')}\n` : '',
      '直接回答观察者的追问。如果其他回答说服了你，明确说明你的立场有何变化。如果你维持原来的判断，说明理由。最多 350 词。',
    ].filter(Boolean).join('\n'),
  };
}

const CONCLUSION: SpeechPrompt = {
  task: [
    '结合整个讨论，直接回答读者的问题。',
    '如果各模型的意见趋同，给出答案及其成立的条件。如果仍有分歧，分点说明分歧及其根源，并明确你的倾向。',
    '最多 500 词。',
  ].join('\n'),
};

export const prism: FormatSpec = {
  brief(d, seat) {
    if (seat.role === 'observer') {
      return [
        `你是多视角讨论的观察者。在 ${seatsOf(d, 'participant').length} 个 AI 模型独立回答同一个问题后，你要找出实质分歧并提出追问。阅读它们的回应后，为读者给出结论。`,
        SEAT_RULE, languageRule('题目'), '', `问题：${d.topic}`,
      ].join('\n');
    }
    return [
      `你是 ${speaker(d, seat.id)}，与其他 AI 模型共同回答一个问题。先独立作答，观察者随后会针对各方回答中的分歧追问。`,
      SEAT_RULE, languageRule('题目'), '', `问题：${d.topic}`,
    ].join('\n');
  },
  // A participant's first answer is its own: the others' come with the probe.
  hears: (d, seat) => seat.role !== 'participant' || d.round > 1,
  plan(d): Step {
    const observer = seatsOf(d, 'observer')[0]!.id;
    const participants = seatsOf(d, 'participant');
    const conclusion = () => spoken(d, d.round, 'conclusion') ? { kind: 'done' as const } : speak({ seatId: observer, round: d.round, phase: 'conclusion', prompt: CONCLUSION });
    if (d.round === 1) {
      const missing = participants.filter(s => !spoken(d, 1, 'explore', s.id));
      if (missing.length) return speak(...missing.map(s => ({ seatId: s.id, round: 1, phase: 'explore' as const, prompt: EXPLORE })));
      if (!spoken(d, 1, 'probe')) return speak({ seatId: observer, round: 1, phase: 'probe', prompt: probeTask(d) });
      return { kind: 'round-end' };
    }
    if (d.concluding) return conclusion();
    const missing = participants.filter(s => !spoken(d, 2, 'deepen', s.id));
    if (missing.length) return speak(...missing.map(s => ({ seatId: s.id, round: 2, phase: 'deepen' as const, prompt: deepenTask(d, s.id) })));
    return conclusion();
  },
  conclude(d) {
    d.concluding = true;
  },
};
