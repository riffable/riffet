import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { CouncilDiscussion, CouncilSeat, TimelineRow } from '@contracts';
import type { SpeechRows } from '@/app/council/model';
import { CouncilStage } from '@/app/council/CouncilStage';
import { CouncilControls } from '@/app/council/CouncilPage';
import { Chapter, Frame, Plate } from '../specimen';

const seat = (id: string, role: CouncilSeat['role'], backendId: CouncilSeat['model']['backendId'], model: string): CouncilSeat =>
  ({ id, role, model: { backendId, profileId: 'demo', model }, profileName: 'Demo' });

const row = (key: string, pos: number, fields: Pick<TimelineRow & { kind: 'thought' }, 'kind' | 'text' | 'channel'>): TimelineRow => ({
  key, pos, turn: 'turn-1', seq: pos, rev: 1, runId: 'r1', ...fields,
  event: { type: 'agent_thought_chunk', data: {}, createdAt: '2026-11-18T10:00:00.000Z', lastAt: '2026-11-18T10:00:00.000Z', sourceIds: [] },
});

const AT = '2026-11-18T10:00:00.000Z';
const ENDED = '2026-11-18T10:00:12.000Z';
const METRICS = { outputTokens: 420, durationMs: 9_000, tokens: 'provider' as const, window: 'stream' as const, steps: 1 };

/** A paused 1v1 debate after its first round, and the same debate while CON answers in the second. */
function useDebate(): { paused: CouncilDiscussion; live: CouncilDiscussion } {
  const { t } = useLingui();
  return useMemo(() => {
    const q1 = t`两周内要给三个平台的用户试用，原生方案怎么做到？`;
    const q2 = t`离线时 Web 端还能用吗？`;
    const paused: CouncilDiscussion = {
      id: 'demo-ld', format: 'ld', title: t`首版应当先做 Web 端`, topic: t`首版应当先做 Web 端`,
      seats: [seat('pro', 'pro', 'claude', 'claude-sonnet-5-5'), seat('con', 'con', 'codex', 'gpt-6.2-sol'), seat('judge', 'judge', 'dsh', 'deepseek-v4')],
      maxRounds: 4, rhythm: 'pause', status: 'paused', round: 1, version: 1, createdAt: AT, updatedAt: AT,
      supplements: [{ id: 'n1', text: t`团队只有两名前端`, at: AT, after: 3 }],
      speeches: [
        { id: 's1', seatId: 'pro', round: 1, phase: 'opening', status: 'done', startedAt: AT, endedAt: ENDED, runId: 'r1', metrics: METRICS,
          text: t`**Web 优先能用最少的人覆盖最多的用户。** 一套代码同时服务桌面与手机浏览器，迭代不用等商店审核。` + `\n\n---\n\n1. ${q1}` },
        { id: 's2', seatId: 'con', round: 1, phase: 'opening', status: 'done', startedAt: AT, endedAt: ENDED, runId: 'r2', metrics: METRICS,
          text: t`先回答：两周内三端都做到，确实只有 Web。但首版要验证的是留存，不是覆盖面；通知、离线和系统集成决定用户会不会回来。` + `\n\n---\n\n1. ${q2}` },
        { id: 's3', seatId: 'judge', round: 1, phase: 'ledger', status: 'done', startedAt: AT, endedAt: ENDED, metrics: METRICS,
          text: t`交锋在「覆盖」与「留存」哪个是首版的目标。反方正面回答了时间问题，正方还没回应离线。`,
          directive: { kind: 'ledger', intensity: 'clashing', action: 'continue',
            sides: { pro: { claim: t`一套代码覆盖最多用户`, reinforced: t`两周三端只有 Web 做得到` }, con: { claim: t`首版验证留存`, broken: t`承认了时间上做不到` } },
            crossExam: [{ asker: 'pro', question: q1, answered: 'direct' }, { asker: 'con', question: q2, answered: 'pending' }] } },
      ],
    };
    const live: CouncilDiscussion = {
      ...paused, status: 'running', round: 2, supplements: [],
      speeches: [...paused.speeches, { id: 'live', seatId: 'pro', round: 2, phase: 'rebuttal', status: 'streaming', startedAt: new Date().toISOString(), runId: 'r4', text: '' }],
    };
    return { paused, live };
  }, [t]);
}

/** A roundtable round: speeches given at once as a row of cards, then the moderator's notes across the page. */
function useRoundtable(): CouncilDiscussion {
  const { t } = useLingui();
  return useMemo(() => ({
    id: 'demo-rt', format: 'roundtable', title: t`26 个字母里对 AI 最重要的是哪一个`, topic: t`26 个字母里对 AI 最重要的是哪一个`,
    seats: [seat('d1', 'debater', 'codex', 'gpt-6.2-sol'), seat('d2', 'debater', 'claude', 'claude-sonnet-5-5'), seat('d3', 'debater', 'traex', 'Seed-Evolving'), seat('m', 'moderator', 'claude', 'claude-opus-5-5')],
    maxRounds: 3, rhythm: 'pause', status: 'paused', round: 1, version: 1, createdAt: AT, updatedAt: AT, supplements: [],
    speeches: [
      { id: 'r1', seatId: 'd1', round: 1, phase: 'statement', status: 'done', startedAt: AT, endedAt: ENDED, metrics: METRICS,
        text: t`我选 E，Evaluation。「智能」给出了目标，评估决定我们把哪些变化当作进步。同一个模型，只看补丁能否通过测试，和同时看它是否保留了调用方依赖的行为，会得到截然不同的结论；评价标准就在塑造用户实际接触到的 AI。` },
      { id: 'r2', seatId: 'd2', round: 1, phase: 'statement', status: 'done', startedAt: AT, endedAt: ENDED, metrics: METRICS,
        text: t`我选 A。**Attention** 是这十年模型的共同底座，Agent、Alignment 也都从 A 开始。E 说的评估很重要，但它衡量的对象是先由注意力机制做出来的。` },
      { id: 'r3', seatId: 'd3', round: 1, phase: 'statement', status: 'failed', startedAt: AT, endedAt: AT, text: '', error: 'model returned HTTP 401: invalid api key' },
      { id: 'r4', seatId: 'm', round: 1, phase: 'summary', status: 'done', startedAt: AT, endedAt: ENDED, metrics: METRICS,
        text: t`两种读法：A 是「做出来的东西」，E 是「判断它好不好」。下一轮请各自回应对方的框架。`,
        directive: { kind: 'moderation', convergence: 'partial', action: 'continue', positions: [{ seatId: 'd1', stance: 'E' }, { seatId: 'd2', stance: 'A' }],
          challenges: [{ from: 'd2', to: 'd1', point: t`评估衡量的对象由注意力机制做出来，E 排在 A 之后` }] } },
    ],
  }), [t]);
}

/** A finished Prism: answers given apart, the observer's disagreements, and the conclusion across the page. */
function usePrism(): CouncilDiscussion {
  const { t } = useLingui();
  return useMemo(() => ({
    id: 'demo-prism', format: 'prism', title: t`本地优先的同步该用 CRDT 还是服务端裁决`, topic: t`本地优先的同步该用 CRDT 还是服务端裁决`,
    seats: [seat('p1', 'participant', 'claude', 'claude-sonnet-5-5'), seat('p2', 'participant', 'codex', 'gpt-6.2-sol'), seat('o', 'observer', 'dsh', 'deepseek-v4')],
    maxRounds: 1, rhythm: 'auto', status: 'done', round: 1, version: 1, createdAt: AT, updatedAt: AT, supplements: [],
    speeches: [
      { id: 'p1', seatId: 'p1', round: 1, phase: 'explore', status: 'done', startedAt: AT, endedAt: ENDED, metrics: METRICS,
        text: t`CRDT。离线编辑是本地优先的前提，合并必须在没有服务端时也成立；代价是文档体积和撤销语义更复杂。` },
      { id: 'p2', seatId: 'p2', round: 1, phase: 'explore', status: 'done', startedAt: AT, endedAt: ENDED, metrics: METRICS,
        text: t`服务端裁决。多数冲突是同一字段的覆盖，最后写入胜出加冲突提示就够用，换来简单的数据模型和权限检查。` },
      { id: 'pr', seatId: 'o', round: 1, phase: 'probe', status: 'done', startedAt: AT, endedAt: ENDED, metrics: METRICS,
        text: t`分歧在于离线是常态还是例外。`,
        directive: { kind: 'probe', gaps: [], contradictions: [{ title: t`离线的地位`, seats: ['p1', 'p2'], question: t`用户离线编辑多久之后再同步？` }] } },
      { id: 'pc', seatId: 'o', round: 1, phase: 'conclusion', status: 'done', startedAt: AT, endedAt: ENDED, metrics: METRICS,
        text: t`按文档类型分：长文本与列表用 CRDT，结构化记录由服务端裁决。两边都同意权限必须在服务端检查。` },
    ],
  }), [t]);
}

export function CouncilChapter() {
  const { t } = useLingui();
  const { paused, live } = useDebate();
  const roundtable = useRoundtable();
  const prism = usePrism();
  const rows: SpeechRows = useMemo(() => ({
    s1: [row('t1', 1, { kind: 'thought', text: t`先确定论证负担：要证明 Web 优先在首版的成本与覆盖上都更优。`, channel: 'thinking' })],
    live: [row('t2', 1, { kind: 'thought', text: t`对方的质询要先正面回答。`, channel: 'thinking' })],
  }), [t]);
  const frame = (d: CouncilDiscussion, controls = false) => (
    <Frame className="px-6 py-8 max-md:px-4">
      <div className="mx-auto max-w-(--content-width)">
        <CouncilStage discussion={d} rows={rows} onLoadRows={() => {}} onToggleEdit={() => {}} />
        {controls && <div className="timeline-gap-turn"><CouncilControls discussion={d} onContinue={() => {}} /></div>}
      </div>
    </Frame>
  );
  return (
    <Chapter title={t`模型协作`} tone="canvas" lede={t`几个 Agent 围绕一个问题发言，每个席位是一段独立的会话。顶部是对阵或席位面板，问题居中作标题；1v1 正反方对席，同时发言的排成一行卡片，裁判与主持人的记录横跨整页。`} source="apps/web/src/app/council/CouncilPage.tsx">
      <Plate number={1} title={t`1v1 辩论`} note={t`质询从发言里分出来，按裁判的记录标出回答情况。`}>{frame(paused, true)}</Plate>
      <Plate number={2} title={t`发言中`}>{frame(live)}</Plate>
      <Plate number={3} title={t`圆桌讨论`} note={t`失败的发言写明原因后跳过。`}>{frame(roundtable, true)}</Plate>
      <Plate number={4} title={t`多视角`}>{frame(prism)}</Plate>
    </Chapter>
  );
}
