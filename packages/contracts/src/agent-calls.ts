import type { NativeBackendId } from './agent-ids.js';

/**
 * Another conversation's Agent calling this server's Agents (docs/AGENT-CALLS.md). A call is one conversation the
 * caller opened, `id` being that conversation's id; each `agent_call` is one of its turns.
 */
export type AgentCallState = 'working' | 'input-required' | 'completed' | 'failed' | 'cancelled';
export type AgentCallMode = 'consult' | 'work';
export interface AgentCallTurn {
  /** The run of the called conversation. */
  runId: string;
  /** The caller's turn that asked, when it was one of the caller's own turns. */
  callerRunId?: string;
  prompt: string;
  state: AgentCallState;
  createdAt: string;
}
export interface AgentCall {
  id: string;
  callerSessionId: string;
  backendId: NativeBackendId;
  backendProfileId?: string;
  model?: string;
  /** Team member id when the called conversation belongs to a standing member. */
  memberId?: string;
  /** Display name of the called team member. */
  memberName?: string;
  mode: AgentCallMode;
  title: string;
  /** The state of its latest turn. */
  state: AgentCallState;
  /** The owner has spoken in the called conversation: the caller can no longer continue it (§4.2). */
  takenOver?: boolean;
  /** The worktree branch a `work` call runs on. */
  branch?: string;
  /** While a turn runs, the newest line of its work; after, the end of its answer. */
  latest?: string;
  turns: AgentCallTurn[];
  createdAt: string;
  updatedAt: string;
}
