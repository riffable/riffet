import { describe, expect, it } from 'vitest';
import type { CouncilDiscussion } from '../../../../../packages/contracts/src/index.js';
import { repeatedRoundCount } from './roundtable-repetition.js';

function discussion(rounds: string[][]): CouncilDiscussion {
  const speeches = rounds.flatMap((texts, r) => texts.map((text, i) => ({
    id: `r${r + 1}-${i}`, seatId: `d${i + 1}`, round: r + 1, phase: 'statement', status: 'done', text,
  })));
  return { seats: [{ id: 'd1', role: 'debater' }, { id: 'd2', role: 'debater' }], speeches } as unknown as CouncilDiscussion;
}

const A = 'Remote work improves productivity because employees avoid commuting, control their own schedules and focus on deep tasks without interruption. Companies save on office space and can hire from a wider pool of candidates across regions. Surveys of knowledge workers repeatedly report higher satisfaction and lower attrition when flexible arrangements are offered, which reduces recruiting costs over several years.';
const B = 'Office presence still matters since spontaneous conversations spread tacit knowledge, mentoring juniors is slower over video, and teams build trust faster in person. Hybrid compromises often inherit the worst of both worlds, with meetings split between room and screen. Managers also struggle to evaluate contribution fairly when only some staff are visible, which can quietly distort promotions.';
const C = 'Governments should prioritise public transport investment because congestion costs cities billions each year, while emissions from private vehicles dominate urban air pollution. Dense networks raise property values around stations and let low income residents reach jobs that were previously out of reach.';
const D = 'Carbon pricing is the cheaper lever: a transparent per tonne charge lets households and firms find their own cheapest reductions, whereas megaprojects overrun budgets and lock in decades of maintenance. Revenue can be recycled as dividends so poorer families end up ahead.';

describe('repeatedRoundCount', () => {
  it('does not flag English rounds that argue different points', () => {
    expect(repeatedRoundCount(discussion([[A, B], [C, D]]), 2)).toBe(0);
    expect(repeatedRoundCount(discussion([[A, B], [B, A]]), 2)).toBe(1);
  });
  it('flags a near-duplicate English round', () => {
    expect(repeatedRoundCount(discussion([[A, B], [`${A} Overall this holds.`, B.replace('quietly', 'subtly')]]), 2)).toBe(1);
  });
  it('handles Chinese by character pairs', () => {
    const x = '远程办公减少通勤时间，员工可以自主安排日程，专注完成需要深度思考的任务，企业也能节省办公空间。';
    const y = '面对面协作更利于隐性知识传递，新人在现场学习更快，团队信任也更容易建立，混合办公常常两头不讨好。';
    expect(repeatedRoundCount(discussion([[x], [y]]), 2)).toBe(0);
    expect(repeatedRoundCount(discussion([[x], [`${x}总之如此。`]]), 2)).toBe(1);
  });
});
