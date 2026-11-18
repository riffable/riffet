import type { NativeBackendId } from './agent-ids.js';

export type CouncilMode = 'debate' | 'prism' | 'insight';
export type CouncilStatus = 'setup' | 'running' | 'paused' | 'done' | 'failed';
export type CouncilRhythm = 'pause' | 'auto';

/** Reference submitted by clients when picking a model through Riffet's ModelPicker. */
export interface CouncilModelRef {
  backendId: NativeBackendId;
  profileId?: string;
  model: string;
}

/** A model participating in a discussion, resolved to a configured backend profile. */
export interface CouncilModelParticipant {
  /** Stable key `${backendId}:${profileId}:${model}`. */
  id: string;
  backendId: NativeBackendId;
  profileId: string;
  profileName: string;
  model: string;
  label: string;
}

export interface CouncilDebateSide {
  id: string;
  label: string;
  models: CouncilModelParticipant[];
}

export interface CouncilDebateQuestion {
  id: string;
  targetSideId?: string;
  targetLabel?: string;
  summary: string;
  text: string;
  status: 'direct' | 'dodged' | 'pending';
}

export interface CouncilDebateReply {
  turnId: string;
  label: string;
  quote: string;
  status: 'direct' | 'dodged' | 'partial';
}

export interface CouncilDebateTurn {
  id: string;
  sideId: string;
  sideLabel: string;
  speaker: CouncilModelParticipant;
  text: string;
  replyTo?: CouncilDebateReply;
  question?: CouncilDebateQuestion;
}

export interface CouncilDebateRound {
  num: number;
  stage: string;
  turns: CouncilDebateTurn[];
  summary?: Record<string, { claim: string; weakness?: string }>;
}

export interface CouncilDebateHostReply {
  sideId: string;
  sideLabel: string;
  speaker: CouncilModelParticipant;
  text: string;
}

export interface CouncilDebateHostTurn {
  id: string;
  prompt: string;
  replies: CouncilDebateHostReply[];
  createdAt: string;
}

export interface CouncilDebateState {
  proposition: string;
  sides: CouncilDebateSide[];
  judgeModel: CouncilModelParticipant;
  rounds: CouncilDebateRound[];
  hostTurns: CouncilDebateHostTurn[];
  verdict?: {
    winner: string;
    takeaway: string;
  };
}

export interface CouncilPrismExploreEntry {
  stance: string;
  thought?: string;
  text: string;
  quoteId?: string;
  quoteSnippet?: string;
}

export interface CouncilPrismContradiction {
  id: string;
  title: string;
  leftModelId: string;
  leftQuote: string;
  rightModelId: string;
  rightQuote: string;
  question: string;
  selected: boolean;
}

export interface CouncilPrismDeepenEntry {
  shifted: boolean;
  oldStance: string;
  newStance: string;
  challenge: string;
  text: string;
}

export interface CouncilPrismState {
  participants: CouncilModelParticipant[];
  observer: CouncilModelParticipant;
  explore: Record<string, CouncilPrismExploreEntry>;
  contradictions: CouncilPrismContradiction[];
  gaps: string[];
  deepen: Record<string, CouncilPrismDeepenEntry>;
  verdict?: {
    headline: string;
    analysis: string;
  };
  supplements: string[];
}

export type CouncilInsightTask = 'correct' | 'augment' | 'diagnose' | 'restructure';

export interface CouncilInsightAnnotation {
  id: string;
  task: CouncilInsightTask;
  taskLabel: string;
  modelId: string;
  modelLabel: string;
  para: string;
  title: string;
  before: string;
  after: string;
  checked: boolean;
}

export interface CouncilInsightState {
  sourceTitle?: string;
  goal?: string;
  paragraphs: Array<{ id: string; text: string }>;
  participants: CouncilModelParticipant[];
  synthesizer: CouncilModelParticipant;
  reviews: Record<string, { role: string; summary: string; text: string }>;
  annotations: CouncilInsightAnnotation[];
  synthesis?: string;
}

export interface CouncilDiscussion {
  id: string;
  mode: CouncilMode;
  title: string;
  status: CouncilStatus;
  phaseIndex: number;
  phases: string[];
  rhythm: CouncilRhythm;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
  debate?: CouncilDebateState;
  prism?: CouncilPrismState;
  insight?: CouncilInsightState;
}

export interface CouncilCreateRequest {
  mode: CouncilMode;
  topic: string;
  rhythm?: CouncilRhythm;
  participants?: CouncilModelRef[];
  observerModel?: CouncilModelRef;
  sides?: Array<{ id?: string; label: string; models: CouncilModelRef[] }>;
  proModels?: CouncilModelRef[];
  conModels?: CouncilModelRef[];
  judgeModel?: CouncilModelRef;
  /** Document text for Insight mode. */
  documentText?: string;
  sourceTitle?: string;
}

export interface CouncilAdvanceRequest {
  action?: 'next-round' | 'conclude';
}

export interface CouncilPatchRequest {
  swapDebateSides?: boolean;
  toggleContradictionId?: string;
  toggleAnnotationId?: string;
}

export interface CouncilSteerRequest {
  text: string;
}

export interface CouncilExportRequest {
  kind: 'task' | 'session';
  body: string;
  projectId?: string;
  backendId?: NativeBackendId;
  model?: string;
}

export interface CouncilExportResult {
  kind: 'task' | 'session';
  id: string;
}

export interface CouncilModelsResponse {
  models: CouncilModelParticipant[];
}

export type CouncilStreamEvent =
  | { type: 'snapshot'; discussion: CouncilDiscussion }
  | { type: 'delta'; discussionId: string; phaseIndex: number; targetId: string; kind: 'text' | 'thought'; text: string };
