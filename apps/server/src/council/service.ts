import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  COUNCIL_BUDGET,
  type CouncilCreateRequest,
  type CouncilDebateRound,
  type CouncilDebateSide,
  type CouncilDebateState,
  type CouncilDebateTurn,
  type CouncilDiscussion,
  type CouncilExportRequest,
  type CouncilExportResult,
  type CouncilInsightAnnotation,
  type CouncilInsightState,
  type CouncilModelParticipant,
  type CouncilModelRef,
  type CouncilPatchRequest,
  type CouncilPrismState,
  type CouncilStreamEvent,
  type NativeBackendId,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import {
  debateHostPrompt,
  debateJudgePrompt,
  debateRoundPrompt,
  extractStreamingField,
  insightGoalPrompt,
  insightReviewPrompt,
  insightRoleFor,
  insightSynthesizePrompt,
  parseJsonObject,
  prismDeepenPrompt,
  prismExplorePrompt,
  prismProbePrompt,
  prismVerdictPrompt,
  splitDocumentParagraphs,
} from './prompts.js';
import { CouncilStore } from './store.js';

export interface CouncilExportHandlers {
  createWorkItem(input: { title: string; body: string; projectId?: string }): string;
  openSession(input: { title: string; prompt: string; projectId?: string; backendId?: NativeBackendId; model?: string }): Promise<string>;
}

export interface CouncilAgentTurnRequest {
  backendId: NativeBackendId;
  profileId?: string;
  model?: string;
  prompt: string;
  signal: AbortSignal;
  onDelta?: (delta: { text: string; thought?: string }) => void;
}

export interface CouncilAgentTurnResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface CouncilBackendProfileSummary {
  id: string;
  name: string;
  isDefault?: boolean;
  defaultModel?: string;
}

export interface CouncilServiceDeps {
  db: DatabaseSync;
  listBackendProfiles: (backendId: NativeBackendId) => CouncilBackendProfileSummary[];
  runAgentTurn: (request: CouncilAgentTurnRequest) => Promise<CouncilAgentTurnResult>;
  exports?: CouncilExportHandlers;
}

const now = () => new Date().toISOString();

function participantKey(ref: { backendId: string; profileId: string; model: string }): string {
  return `${ref.backendId}:${ref.profileId}:${ref.model}`;
}

export class CouncilService {
  private readonly store: CouncilStore;
  private readonly active = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<(event: CouncilStreamEvent) => void>>();

  constructor(private readonly deps: CouncilServiceDeps) {
    this.store = new CouncilStore(deps.db);
  }

  close(): void {
    for (const controller of this.active.values()) controller.abort(new Error('Service closed'));
    this.active.clear();
    this.listeners.clear();
  }

  subscribe(id: string, listener: (event: CouncilStreamEvent) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, set = new Set());
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(id);
    };
  }

  private emit(id: string, event: CouncilStreamEvent): void {
    const set = this.listeners.get(id);
    if (!set) return;
    for (const listener of set) {
      try { listener(event); } catch { /* listener closed */ }
    }
  }

  private saveAndEmit(discussion: CouncilDiscussion): CouncilDiscussion {
    discussion.updatedAt = now();
    this.store.save(discussion);
    this.emit(discussion.id, { type: 'snapshot', discussion });
    return discussion;
  }

  private resolveModelRef(ref: CouncilModelRef): CouncilModelParticipant {
    const cleanModel = ref.model.replace(/\[[^\]]*\]$/u, '').trim();
    let profiles: CouncilBackendProfileSummary[] = [];
    try { profiles = this.deps.listBackendProfiles(ref.backendId); } catch { /* handled by runtime */ }

    const profile = (ref.profileId ? profiles.find(p => p.id === ref.profileId) : undefined)
      ?? profiles.find(p => p.isDefault)
      ?? profiles[0];
    const profileId = ref.profileId ?? profile?.id ?? '';
    const profileName = profile?.name ?? (profileId || ref.backendId);
    const model = cleanModel || profile?.defaultModel || '默认模型';
    return {
      id: participantKey({ backendId: ref.backendId, profileId, model }),
      backendId: ref.backendId,
      profileId,
      profileName,
      model,
      label: `${model} (${profileName})`,
    };
  }

  private resolveParticipants(refs: CouncilModelRef[] | undefined, min: number, max: number): CouncilModelParticipant[] {
    const out: CouncilModelParticipant[] = [];
    const seen = new Set<string>();
    for (const ref of refs ?? []) {
      const resolved = this.resolveModelRef(ref);
      if (!seen.has(resolved.id)) {
        seen.add(resolved.id);
        out.push(resolved);
      }
    }
    if (out.length > 0 && out.length < min) {
      while (out.length < min) out.push(out[out.length % out.length]!);
    }
    return out.slice(0, max);
  }

  list(): CouncilDiscussion[] {
    return this.store.list();
  }

  get(id: string): CouncilDiscussion {
    const found = this.store.get(id);
    if (!found) throw new AppError('COUNCIL_NOT_FOUND', 'Discussion not found', 404);
    return found;
  }

  delete(id: string): void {
    this.cancel(id);
    if (!this.store.delete(id)) throw new AppError('COUNCIL_NOT_FOUND', 'Discussion not found', 404);
  }

  cancel(id: string): CouncilDiscussion {
    const controller = this.active.get(id);
    if (controller) {
      controller.abort(new Error('Cancelled by user'));
      this.active.delete(id);
    }
    const found = this.get(id);
    if (found.status === 'running') {
      found.status = 'paused';
      return this.saveAndEmit(found);
    }
    return found;
  }

  async create(req: CouncilCreateRequest): Promise<CouncilDiscussion> {
    if (!req || !['debate', 'prism', 'insight'].includes(req.mode)) {
      throw new AppError('INVALID_COUNCIL_MODE', 'Mode must be debate, prism, or insight');
    }
    const topic = typeof req.topic === 'string' ? req.topic.trim() : '';
    if (!topic && req.mode !== 'insight') throw new AppError('INVALID_COUNCIL_TOPIC', 'Enter a topic or proposition');
    if (topic.length > COUNCIL_BUDGET.topicChars) throw new AppError('INVALID_COUNCIL_TOPIC', 'Topic is too long');

    const rhythm = req.rhythm === 'auto' ? 'auto' : 'pause';
    const createdAt = now();
    const id = `council_${randomUUID().slice(0, 12)}`;

    let discussion: CouncilDiscussion;

    if (req.mode === 'debate') {
      const rawSides = req.sides?.length
        ? req.sides
        : [
            { id: 'pro', label: '正方', models: req.proModels ?? [] },
            { id: 'con', label: '反方', models: req.conModels ?? [] },
          ];
      const sides: CouncilDebateSide[] = rawSides
        .slice(0, 4)
        .map((s, idx) => ({
          id: s.id?.trim() || (idx === 0 ? 'pro' : idx === 1 ? 'con' : `side-${idx + 1}`),
          label: s.label.trim() || `立场 ${idx + 1}`,
          models: this.resolveParticipants(s.models, 1, 3),
        }))
        .filter(s => s.models.length > 0);
      if (sides.length < 2) {
        throw new AppError('COUNCIL_MODELS_UNAVAILABLE', 'Choose at least two sides with models to debate', 409);
      }
      const judgeModel = req.judgeModel ? this.resolveModelRef(req.judgeModel) : sides[sides.length - 1]!.models[0]!;

      discussion = {
        id,
        mode: 'debate',
        title: topic,
        status: rhythm === 'auto' ? 'running' : 'paused',
        phaseIndex: 0,
        phases: ['命题与分工', '第 1 轮 · 亮明观点', '第 2 轮 · 交锋回应', '结论'],
        rhythm,
        createdAt,
        updatedAt: createdAt,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        debate: {
          proposition: topic,
          sides,
          judgeModel,
          rounds: [],
          hostTurns: [],
        },
      };
    } else if (req.mode === 'prism') {
      const participants = this.resolveParticipants(req.participants, 2, 4);
      if (participants.length < 2) {
        throw new AppError('COUNCIL_MODELS_UNAVAILABLE', 'Choose at least two models to collaborate', 409);
      }
      const observer = req.observerModel ? this.resolveModelRef(req.observerModel) : participants[0]!;
      discussion = {
        id,
        mode: 'prism',
        title: topic,
        status: 'running',
        phaseIndex: 0,
        phases: ['各自作答', '分歧焦点', '回应追问', '结论'],
        rhythm,
        createdAt,
        updatedAt: createdAt,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        prism: {
          participants,
          observer,
          explore: {},
          contradictions: [],
          gaps: [],
          deepen: {},
          supplements: [],
        },
      };
    } else {
      const docText = typeof req.documentText === 'string' && req.documentText.trim() ? req.documentText.trim() : topic;
      if (!docText) throw new AppError('INVALID_COUNCIL_DOCUMENT', 'Paste a document or diff to review');
      if (docText.length > COUNCIL_BUDGET.documentChars) throw new AppError('INVALID_COUNCIL_DOCUMENT', 'Document exceeds the length limit');
      const paragraphs = splitDocumentParagraphs(docText);
      const participants = this.resolveParticipants(req.participants, 2, 4);
      if (participants.length < 2) {
        throw new AppError('COUNCIL_MODELS_UNAVAILABLE', 'Choose at least two models to review', 409);
      }
      const synthesizer = req.observerModel ? this.resolveModelRef(req.observerModel) : participants[0]!;
      discussion = {
        id,
        mode: 'insight',
        title: req.sourceTitle?.trim() || (topic.length <= 48 ? topic : `${topic.slice(0, 48)}…`),
        status: 'running',
        phaseIndex: 0,
        phases: ['目标与原文', '分工审阅', '确认修改'],
        rhythm,
        createdAt,
        updatedAt: createdAt,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        insight: {
          sourceTitle: req.sourceTitle?.trim() || '文档草稿',
          paragraphs,
          participants,
          synthesizer,
          reviews: {},
          annotations: [],
        },
      };
    }

    this.store.save(discussion);
    this.store.pruneOldest();

    if (discussion.status === 'running' || (discussion.mode === 'debate' && rhythm === 'auto')) {
      void this.runFromCurrent(discussion.id);
    }
    return discussion;
  }

  patch(id: string, req: CouncilPatchRequest): CouncilDiscussion {
    const d = this.get(id);
    if (req.swapDebateSides && d.mode === 'debate' && d.debate && d.phaseIndex === 0 && d.debate.sides.length === 2) {
      const [s0, s1] = d.debate.sides as [CouncilDebateSide, CouncilDebateSide];
      [s0.models, s1.models] = [s1.models, s0.models];
      return this.saveAndEmit(d);
    }
    if (req.toggleContradictionId && d.mode === 'prism' && d.prism) {
      const target = d.prism.contradictions.find(c => c.id === req.toggleContradictionId);
      if (target) target.selected = !target.selected;
      return this.saveAndEmit(d);
    }
    if (req.toggleAnnotationId && d.mode === 'insight' && d.insight) {
      const target = d.insight.annotations.find(a => a.id === req.toggleAnnotationId);
      if (target) target.checked = !target.checked;
      return this.saveAndEmit(d);
    }
    return d;
  }

  async advance(id: string, action?: 'next-round' | 'conclude'): Promise<CouncilDiscussion> {
    const d = this.get(id);
    if (d.status === 'running') return d;

    if (d.mode === 'debate' && d.debate) {
      if (action === 'conclude') {
        d.phaseIndex = d.phases.length - 1;
        d.status = 'running';
        d.error = undefined;
        this.saveAndEmit(d);
        void this.runDebateConclude(d.id);
        return d;
      }
      const nextRoundNum = d.debate.rounds.length + 1;
      if (nextRoundNum > 2) {
        const label = `第 ${nextRoundNum} 轮 · 深入交锋`;
        if (!d.phases.includes(label)) {
          d.phases.splice(d.phases.length - 1, 0, label);
        }
      }
      d.phaseIndex = nextRoundNum;
      d.status = 'running';
      d.error = undefined;
      this.saveAndEmit(d);
      void this.runFromCurrent(d.id);
      return d;
    }

    if (d.mode === 'prism' && d.phaseIndex === 1) d.phaseIndex = 2;
    else if (d.mode === 'insight' && d.phaseIndex === 0) d.phaseIndex = 1;
    else return d;
    d.status = 'running';
    d.error = undefined;
    this.saveAndEmit(d);
    void this.runFromCurrent(d.id);
    return d;
  }

  async steer(id: string, text: string): Promise<CouncilDiscussion> {
    const prompt = text.trim();
    if (!prompt) throw new AppError('INVALID_STEER', 'Enter a follow-up question');
    if (prompt.length > COUNCIL_BUDGET.steerChars) throw new AppError('INVALID_STEER', 'Follow-up is too long');
    const d = this.get(id);
    if (d.status === 'running') throw new AppError('COUNCIL_BUSY', 'Wait for the current round to finish', 409);

    if (d.mode === 'debate' && d.debate) {
      const controller = this.beginRun(d);
      const startedAt = Date.now();
      try {
        const debate = d.debate;
        const context = debate.rounds.map(r =>
          `第${r.num}轮\n${r.turns.map(t => `[${t.sideLabel} · ${t.speaker.model}] ${t.text}`).join('\n')}`
        ).join('\n\n');

        const replies = (await Promise.all(debate.sides.map(side =>
          Promise.all(side.models.map(async (m, idx) => {
            const res = await this.callAgent(
              d,
              m,
              debateHostPrompt({ proposition: debate.proposition, sideLabel: side.label, hostQuestion: prompt, context }),
              `host-${side.id}-${idx}`,
              controller.signal,
            );
            return { sideId: side.id, sideLabel: side.label, speaker: m, text: res.text.trim() };
          }))
        ))).flat();

        debate.hostTurns.push({
          id: `host_${randomUUID().slice(0, 8)}`,
          prompt,
          replies,
          createdAt: now(),
        });
        d.durationMs += Date.now() - startedAt;
        d.status = debate.verdict ? 'done' : (d.rhythm === 'pause' ? 'paused' : 'done');
        return this.saveAndEmit(d);
      } catch (error) {
        return this.handleError(d, error);
      } finally {
        this.active.delete(d.id);
      }
    }

    if (d.mode === 'prism' && d.prism) {
      d.prism.supplements.push(prompt);
      d.prism.contradictions.push({
        id: `u_${randomUUID().slice(0, 6)}`,
        title: '主持人追问',
        leftModelId: d.prism.participants[0]!.id,
        leftQuote: '补充约束',
        rightModelId: d.prism.participants[1]?.id ?? d.prism.participants[0]!.id,
        rightQuote: prompt,
        question: prompt,
        selected: true,
      });
      d.phaseIndex = 2;
      d.status = 'running';
      this.saveAndEmit(d);
      void this.runFromCurrent(d.id);
      return d;
    }

    throw new AppError('COUNCIL_STEER_UNSUPPORTED', 'Steer is only supported in Debate and Prism modes', 400);
  }

  async exportDiscussion(id: string, req: CouncilExportRequest): Promise<CouncilExportResult> {
    const d = this.get(id);
    if (!this.deps.exports) throw new AppError('SERVICE_STARTING', 'Export handlers unavailable', 503);
    const body = (req.body || '').trim();
    if (!body) throw new AppError('INVALID_EXPORT', 'Export content cannot be empty');
    if (req.kind === 'task') {
      const workItemId = this.deps.exports.createWorkItem({
        title: d.title,
        body,
        ...(req.projectId ? { projectId: req.projectId } : {}),
      });
      return { kind: 'task', id: workItemId };
    }
    const sessionId = await this.deps.exports.openSession({
      title: d.title,
      prompt: `以下是模型协作「${d.title}」的结论，请在此基础上继续推进：\n\n${body}`,
      ...(req.projectId ? { projectId: req.projectId } : {}),
      ...(req.backendId ? { backendId: req.backendId } : {}),
      ...(req.model ? { model: req.model } : {}),
    });
    return { kind: 'session', id: sessionId };
  }

  private beginRun(d: CouncilDiscussion): AbortController {
    this.active.get(d.id)?.abort(new Error('Superseded'));
    const controller = new AbortController();
    this.active.set(d.id, controller);
    d.status = 'running';
    d.error = undefined;
    this.saveAndEmit(d);
    return controller;
  }

  private handleError(d: CouncilDiscussion, error: unknown): CouncilDiscussion {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Cancelled by user' || message === 'Service closed') {
      d.status = 'paused';
    } else {
      d.status = 'failed';
      d.error = message;
    }
    return this.saveAndEmit(d);
  }

  private async callAgent(
    d: CouncilDiscussion,
    participant: CouncilModelParticipant,
    prompt: { system: string; user: string },
    targetId: string,
    signal: AbortSignal,
    streamKeys: readonly string[] = ['argument', 'text'],
  ): Promise<CouncilAgentTurnResult> {
    const fullPrompt = `${prompt.system}\n\n重要：请仅根据问题本身直接作答，不要调用任何文件读写或命令执行工具。\n\n${prompt.user}`;
    let lastEmitAt = 0;
    const res = await this.deps.runAgentTurn({
      backendId: participant.backendId,
      ...(participant.profileId ? { profileId: participant.profileId } : {}),
      ...(participant.model && participant.model !== '默认模型' ? { model: participant.model } : {}),
      prompt: fullPrompt,
      signal,
      onDelta: ({ text, thought }) => {
        const nowMs = Date.now();
        if (nowMs - lastEmitAt < 75) return;
        lastEmitAt = nowMs;
        const extracted = extractStreamingField(text, streamKeys);
        if (extracted) {
          this.emit(d.id, { type: 'delta', discussionId: d.id, phaseIndex: d.phaseIndex, targetId, kind: 'text', text: extracted });
        }
        if (thought) {
          this.emit(d.id, { type: 'delta', discussionId: d.id, phaseIndex: d.phaseIndex, targetId, kind: 'thought', text: thought });
        }
      },
    });
    d.inputTokens += res.inputTokens ?? 0;
    d.outputTokens += res.outputTokens ?? 0;
    return res;
  }

  private async runFromCurrent(id: string): Promise<void> {
    const d = this.get(id);
    const controller = this.beginRun(d);
    const startedAt = Date.now();
    try {
      if (d.mode === 'debate' && d.debate) await this.runDebate(d, d.debate, controller.signal);
      else if (d.mode === 'prism' && d.prism) await this.runPrism(d, d.prism, controller.signal);
      else if (d.mode === 'insight' && d.insight) await this.runInsight(d, d.insight, controller.signal);
      d.durationMs += Date.now() - startedAt;
      if (d.status === 'running') d.status = 'done';
      this.saveAndEmit(d);
    } catch (error) {
      d.durationMs += Date.now() - startedAt;
      this.handleError(d, error);
    } finally {
      this.active.delete(d.id);
    }
  }

  private async runDebateConclude(id: string): Promise<void> {
    const d = this.get(id);
    if (!d.debate) return;
    const controller = this.beginRun(d);
    const startedAt = Date.now();
    try {
      await this.concludeDebate(d, d.debate, controller.signal);
      d.durationMs += Date.now() - startedAt;
      if (d.status === 'running') d.status = 'done';
      this.saveAndEmit(d);
    } catch (error) {
      d.durationMs += Date.now() - startedAt;
      this.handleError(d, error);
    } finally {
      this.active.delete(d.id);
    }
  }

  private async executeDebateRound(
    d: CouncilDiscussion,
    debate: CouncilDebateState,
    roundNum: number,
    signal: AbortSignal,
  ): Promise<void> {
    const stage = roundNum === 1 ? '亮明观点' : roundNum === 2 ? '交锋回应' : '深入交锋';
    const priorRound = debate.rounds.at(-1);
    const priorTranscript = debate.rounds.length
      ? debate.rounds.map(r => `第 ${r.num} 轮：\n${r.turns.map(t => `[${t.sideLabel} · ${t.speaker.model}] ${t.text}`).join('\n')}`).join('\n\n')
      : undefined;

    const allSides = debate.sides.map(s => s.label);
    const placeholders: CouncilDebateTurn[] = [];
    for (const side of debate.sides) {
      side.models.forEach((m, idx) => {
        placeholders.push({
          id: `r${roundNum}-${side.id}-${idx}`,
          sideId: side.id,
          sideLabel: side.label,
          speaker: m,
          text: '',
        });
      });
    }

    const round: CouncilDebateRound = { num: roundNum, stage, turns: placeholders, summary: {} };
    debate.rounds.push(round);
    d.phaseIndex = Math.min(roundNum, d.phases.length - 2);
    this.saveAndEmit(d);

    let turnCursor = 0;
    const tasks: Array<Promise<void>> = [];

    for (const side of debate.sides) {
      const incoming = priorRound?.turns.filter(t => t.sideId !== side.id && t.question && (!t.question.targetSideId || t.question.targetSideId === side.id)) ?? [];

      side.models.forEach((m, idx) => {
        const myIndex = turnCursor++;
        const turnId = `r${roundNum}-${side.id}-${idx}`;
        const replyTarget = incoming[idx % Math.max(1, incoming.length)];
        const incomingQuestions = incoming.map(t => ({ fromLabel: `${t.sideLabel} · ${t.speaker.model}`, text: t.question!.text }));

        tasks.push((async () => {
          const res = await this.callAgent(
            d,
            m,
            debateRoundPrompt({
              proposition: debate.proposition,
              sideLabel: side.label,
              allSides,
              roundNum,
              memberIndex: idx,
              teamSize: side.models.length,
              priorTranscript,
              incomingQuestions: incomingQuestions.length ? incomingQuestions : undefined,
            }),
            turnId,
            signal,
          );
          const json = parseJsonObject<Record<string, unknown>>(res.text);
          const str = (k: string) => (typeof json?.[k] === 'string' && json[k] !== 'null' ? (json[k] as string).trim() : undefined);

          if (str('claim')) {
            round.summary![side.id] = {
              claim: str('claim')!,
              ...(str('weakness') ? { weakness: str('weakness') } : {}),
            };
          }

          let replyTo: CouncilDebateTurn['replyTo'];
          if (replyTarget?.question && str('reply')) {
            const rawStatus = str('replyStatus');
            const status = rawStatus === 'partial' || rawStatus === 'dodged' ? rawStatus : 'direct';
            replyTarget.question.status = status === 'direct' ? 'direct' : 'dodged';
            replyTo = {
              turnId: replyTarget.id,
              label: `回应 ${replyTarget.speaker.model}「${replyTarget.question.summary}」`,
              quote: str('reply')!,
              status,
            };
          }

          let question: CouncilDebateTurn['question'];
          const qText = str('question');
          if (qText) {
            const targetName = str('questionTarget');
            const otherSides = debate.sides.filter(s => s.id !== side.id);
            const targetSide = (targetName ? otherSides.find(s => targetName.includes(s.label)) : undefined) ?? otherSides[0];
            question = {
              id: `${turnId}-q`,
              ...(targetSide ? { targetSideId: targetSide.id, targetLabel: targetSide.label } : {}),
              summary: str('questionSummary') || '追问',
              text: qText,
              status: 'pending',
            };
          }

          round.turns[myIndex] = {
            id: turnId,
            sideId: side.id,
            sideLabel: side.label,
            speaker: m,
            text: str('argument') || res.text.trim(),
            ...(replyTo ? { replyTo } : {}),
            ...(question ? { question } : {}),
          };
          this.saveAndEmit(d);
        })());
      });
    }

    await Promise.all(tasks);
  }

  private async concludeDebate(d: CouncilDiscussion, debate: CouncilDebateState, signal: AbortSignal): Promise<void> {
    d.phaseIndex = d.phases.length - 1;
    this.saveAndEmit(d);
    const judgeRes = await this.callAgent(d, debate.judgeModel, debateJudgePrompt(debate), 'debate-judge', signal);
    const judgeJson = parseJsonObject<Record<string, string>>(judgeRes.text);
    debate.verdict = {
      winner: judgeJson?.winner || '讨论已收敛',
      takeaway: judgeJson?.takeaway || judgeRes.text.trim(),
    };
    d.status = 'done';
    this.saveAndEmit(d);
  }

  private async runDebate(d: CouncilDiscussion, debate: CouncilDebateState, signal: AbortSignal): Promise<void> {
    if (d.phaseIndex === 0) d.phaseIndex = 1;
    const targetRound = Math.max(1, d.phaseIndex);

    while (debate.rounds.length < targetRound) {
      await this.executeDebateRound(d, debate, debate.rounds.length + 1, signal);
      if (d.rhythm === 'pause' && debate.rounds.length >= targetRound) {
        d.status = 'paused';
        this.saveAndEmit(d);
        return;
      }
    }

    if (d.rhythm === 'auto') {
      if (debate.rounds.length < 2) {
        await this.executeDebateRound(d, debate, debate.rounds.length + 1, signal);
      }
      await this.concludeDebate(d, debate, signal);
    } else {
      d.status = 'paused';
      this.saveAndEmit(d);
    }
  }

  private async runPrism(d: CouncilDiscussion, prism: CouncilPrismState, signal: AbortSignal): Promise<void> {
    if (d.phaseIndex === 0) {
      for (const p of prism.participants) {
        prism.explore[p.id] = { stance: '作答中…', text: '' };
      }
      this.saveAndEmit(d);
      await Promise.all(prism.participants.map(async (p) => {
        const res = await this.callAgent(d, p, prismExplorePrompt(d.title), `explore-${p.id}`, signal, ['text']);
        const json = parseJsonObject<Record<string, string>>(res.text);
        prism.explore[p.id] = {
          stance: json?.stance || '待定立场',
          thought: json?.thought || undefined,
          text: json?.text || res.text.trim(),
        };
        this.saveAndEmit(d);
      }));
      d.phaseIndex = 1;
      this.saveAndEmit(d);

      const probeRes = await this.callAgent(d, prism.observer, prismProbePrompt(d.title, prism.participants, prism.explore), 'prism-probe', signal);
      const probeJson = parseJsonObject<{ contradictions?: Array<Record<string, string>>; gaps?: unknown[] }>(probeRes.text);
      const contradictions = (probeJson?.contradictions ?? []).slice(0, 4).map((c, i) => {
        const leftId = prism.participants.some(p => p.id === c.leftModelId) ? c.leftModelId! : prism.participants[0]!.id;
        const rightId = prism.participants.some(p => p.id === c.rightModelId) ? c.rightModelId! : (prism.participants[1] ?? prism.participants[0]!).id;
        const cid = `c${i + 1}`;
        const leftQuote = c.leftQuote || prism.explore[leftId]?.stance || '';
        const rightQuote = c.rightQuote || prism.explore[rightId]?.stance || '';
        if (prism.explore[leftId] && leftQuote) {
          prism.explore[leftId]!.quoteId = cid;
          prism.explore[leftId]!.quoteSnippet = leftQuote;
        }
        if (prism.explore[rightId] && rightQuote) {
          prism.explore[rightId]!.quoteId = cid;
          prism.explore[rightId]!.quoteSnippet = rightQuote;
        }
        return {
          id: cid,
          title: c.title || `分歧 ${i + 1}`,
          leftModelId: leftId,
          leftQuote,
          rightModelId: rightId,
          rightQuote,
          question: c.question || '请针对该分歧说明前提假设。',
          selected: true,
        };
      });
      prism.contradictions = contradictions.length ? contradictions : [{
        id: 'c1',
        title: '核心方案取舍',
        leftModelId: prism.participants[0]!.id,
        leftQuote: prism.explore[prism.participants[0]!.id]?.stance ?? '',
        rightModelId: prism.participants[1]?.id ?? prism.participants[0]!.id,
        rightQuote: prism.explore[prism.participants[1]?.id ?? prism.participants[0]!.id]?.stance ?? '',
        question: '各方前提在哪些边界条件下无法同时成立？',
        selected: true,
      }];
      prism.gaps = Array.isArray(probeJson?.gaps) ? probeJson.gaps.filter((g): g is string => typeof g === 'string').slice(0, 3) : [];

      if (d.rhythm === 'pause') {
        d.status = 'paused';
        this.saveAndEmit(d);
        return;
      }
      d.phaseIndex = 2;
      this.saveAndEmit(d);
    }

    if (d.phaseIndex === 2) {
      const selectedQuestions = prism.contradictions.filter(c => c.selected).map(c => c.question);
      const questions = selectedQuestions.length ? selectedQuestions : prism.contradictions.map(c => c.question);
      for (const p of prism.participants) {
        prism.deepen[p.id] = {
          shifted: false,
          oldStance: prism.explore[p.id]?.stance ?? '',
          newStance: '回应中…',
          challenge: questions[0] ?? '综合追问',
          text: '',
        };
      }
      this.saveAndEmit(d);
      await Promise.all(prism.participants.map(async (p) => {
        const othersSummary = prism.participants
          .filter(o => o.id !== p.id)
          .map(o => `${o.label}（${prism.explore[o.id]?.stance ?? ''}）：${prism.explore[o.id]?.text ?? ''}`)
          .join('\n');
        const res = await this.callAgent(d, p, prismDeepenPrompt({
          topic: d.title,
          model: p,
          ownExplore: prism.explore[p.id]!,
          questions,
          othersSummary,
        }), `deepen-${p.id}`, signal, ['text']);
        const json = parseJsonObject<Record<string, unknown>>(res.text);
        const oldStance = prism.explore[p.id]?.stance ?? '';
        prism.deepen[p.id] = {
          shifted: Boolean(json?.shifted),
          oldStance,
          newStance: typeof json?.newStance === 'string' && json.newStance ? json.newStance : (json?.shifted ? '已调整立场' : '维持原判'),
          challenge: typeof json?.challenge === 'string' && json.challenge ? json.challenge : (questions[0] ?? '综合追问'),
          text: typeof json?.text === 'string' && json.text ? json.text : res.text.trim(),
        };
        this.saveAndEmit(d);
      }));
      d.phaseIndex = 3;
      this.saveAndEmit(d);
    }

    if (d.phaseIndex >= 3) {
      const verdictRes = await this.callAgent(d, prism.observer, prismVerdictPrompt(d.title, prism), 'prism-verdict', signal);
      const json = parseJsonObject<Record<string, string>>(verdictRes.text);
      prism.verdict = {
        headline: json?.headline || '一致结论',
        analysis: json?.analysis || verdictRes.text.trim(),
      };
      d.status = 'done';
      this.saveAndEmit(d);
    }
  }

  private async runInsight(d: CouncilDiscussion, insight: CouncilInsightState, signal: AbortSignal): Promise<void> {
    if (d.phaseIndex === 0) {
      const docText = insight.paragraphs.map(p => p.text).join('\n\n');
      const goalRes = await this.callAgent(d, insight.synthesizer, insightGoalPrompt(docText), 'insight-goal', signal);
      insight.goal = goalRes.text.trim().replace(/^目标[：:]\s*/, '');
      if (d.rhythm === 'pause') {
        d.status = 'paused';
        this.saveAndEmit(d);
        return;
      }
      d.phaseIndex = 1;
      this.saveAndEmit(d);
    }

    if (d.phaseIndex === 1) {
      const goal = insight.goal || d.title;
      const collected: CouncilInsightAnnotation[] = [];
      await Promise.all(insight.participants.map(async (p, idx) => {
        const role = insightRoleFor(idx);
        const res = await this.callAgent(d, p, insightReviewPrompt({ goal, paragraphs: insight.paragraphs, role }), `review-${p.id}`, signal);
        const json = parseJsonObject<{ summary?: string; text?: string; annotations?: Array<Record<string, string>> }>(res.text);
        insight.reviews[p.id] = {
          role: role.label,
          summary: json?.summary || `${role.label}建议`,
          text: json?.text || res.text.trim(),
        };
        for (const [aIdx, ann] of (json?.annotations ?? []).slice(0, 2).entries()) {
          const para = insight.paragraphs.some(x => x.id === ann.para) ? ann.para! : (insight.paragraphs[0]?.id ?? 'P1');
          collected.push({
            id: `${p.id}-${aIdx}-${randomUUID().slice(0, 4)}`,
            task: role.task,
            taskLabel: role.label,
            modelId: p.id,
            modelLabel: p.model,
            para,
            title: ann.title || `${role.label}建议`,
            before: ann.before || insight.paragraphs.find(x => x.id === para)?.text || '',
            after: ann.after || '',
            checked: idx === 0 || aIdx === 0,
          });
        }
      }));
      insight.annotations = collected;
      d.phaseIndex = 2;
      this.saveAndEmit(d);
    }

    if (d.phaseIndex >= 2) {
      const goal = insight.goal || d.title;
      if (insight.annotations.length) {
        const synRes = await this.callAgent(d, insight.synthesizer, insightSynthesizePrompt(goal, insight.annotations), 'insight-synthesis', signal);
        insight.synthesis = synRes.text.trim();
      } else {
        insight.synthesis = '各模型未发现必须修改的段落。';
      }
      d.status = 'done';
      this.saveAndEmit(d);
    }
  }
}
