import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { AGENT_CALL_BUDGET, catalogEntry, catalogParams, parseSelection, type AgentCall, type NativeBackendId } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { Spinner } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { backendLabel } from '@/lib/backends';
import { cachedCatalog } from '@/lib/catalog-cache';
import { cleanLabel, isRecord, str } from '@/lib/utils';
import { RowOutcome } from './Activities';
import { useLists } from '../state/stores';
import { MemberAvatar } from '../team/MemberAvatar';
import type { TimelineItem } from './model';
import { selectionTags } from './ModelPicker';
import { Disclosure } from './Timeline';
import { activeToolStates, toolView } from './toolView';

/*
 * One conversation's Agent calling another (docs/AGENT-CALLS.md §6): the `@` menu's Agents, and the row an
 * `agent_call` is drawn as in the caller's transcript, leading to the called conversation.
 */

const TOOL = /^(?:mcp__riffet__|riffet\s*[·.:/]\s*)(agent_(?:call|wait|stop|list))$/;

/** Which of Riffet's agent tools a tool row is, by the name its CLI reports it under. */
export function agentToolName(data: Record<string, unknown>): 'agent_call' | 'agent_wait' | 'agent_stop' | 'agent_list' | undefined {
  for (const key of ['toolName', 'name', 'title'] as const) {
    const match = str(data[key])?.trim().match(TOOL);
    if (match) return match[1] as 'agent_call';
  }
  return undefined;
}

interface CallsSource {
  calls: AgentCall[];
  /** The caller's project, whose model lists the composer already read: they name a call's model. */
  projectId: string;
  open(callId: string): void;
  /** A row that names no known call yet asks for the list again. */
  refresh(): void;
}

export const AgentCallsContext = createContext<CallsSource | null>(null);

const working = (call: AgentCall) => call.state === 'working' || call.state === 'input-required';

/**
 * The calls a conversation made, read while one of them runs or a row asks. Polled, at
 * `AGENT_CALL_BUDGET.cardPollMs`, only while a call is working and the page is shown.
 */
export function AgentCallsProvider({ sessionId, projectId, onOpenSession, children }: { sessionId: string; projectId: string; onOpenSession?: (id: string) => void; children: ReactNode }) {
  const [calls, setCalls] = useState<AgentCall[]>([]);
  const [tick, setTick] = useState(0);
  const asked = useRef(false);
  useEffect(() => { setCalls([]); asked.current = false; }, [sessionId]);
  const refresh = useCallback(() => setTick(value => value + 1), []);
  const live = calls.some(working);
  useEffect(() => {
    if (!tick && !live) return;
    const controller = new AbortController();
    api.agentCalls(sessionId, controller.signal).then(setCalls, () => undefined);
    return () => controller.abort();
  }, [sessionId, tick, live]);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, AGENT_CALL_BUDGET.cardPollMs);
    return () => window.clearInterval(timer);
  }, [live, refresh]);
  const value = useMemo<CallsSource>(() => ({
    calls,
    projectId,
    open: id => onOpenSession?.(id),
    refresh: () => { if (!asked.current) { asked.current = true; refresh(); window.setTimeout(() => { asked.current = false; }, AGENT_CALL_BUDGET.cardPollMs); } },
  }), [calls, projectId, onOpenSession, refresh]);
  return <AgentCallsContext.Provider value={value}>{children}</AgentCallsContext.Provider>;
}

function parsedOutput(rawOutput: unknown): Record<string, unknown> | undefined {
  if (isRecord(rawOutput)) {
    if (isRecord(rawOutput.structuredContent)) return rawOutput.structuredContent;
    if (typeof rawOutput.call === 'string') return rawOutput;
  }
  const text = typeof rawOutput === 'string' ? rawOutput
    : Array.isArray(rawOutput) ? rawOutput.map(item => isRecord(item) && typeof item.text === 'string' ? item.text : '').join('')
      : isRecord(rawOutput) && Array.isArray(rawOutput.content) ? rawOutput.content.map(item => isRecord(item) && typeof item.text === 'string' ? item.text : '').join('') : '';
  try { const parsed = JSON.parse(text) as unknown; return isRecord(parsed) ? parsed : undefined; } catch { return undefined; }
}

/** What a call runs on, as the model menu's trigger says it: the model's name, then its effort and Fast. */
function modelLine(call: AgentCall, projectId: string): string | undefined {
  if (!call.model) return undefined;
  const { model, params } = parseSelection(call.model);
  const catalog = cachedCatalog(`${projectId}:${call.backendId}:${call.backendProfileId ?? 'default'}`)?.models ?? [];
  const info = catalogEntry(catalog, model);
  if (!info) return [model, params.effort].filter(Boolean).join(' ');
  const tags = selectionTags(catalogParams(catalog, info.value, params));
  return [cleanLabel(info.name), tags.effort, tags.fast && 'Fast', tags.max && 'MAX'].filter(Boolean).join(' ');
}

/** The call a row asked for: the id it named or was answered with, else the turn whose request it sent. */
function callOf(calls: readonly AgentCall[], input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined): AgentCall | undefined {
  const id = str(output?.call) ?? str(input?.call);
  if (id) return calls.find(call => call.id === id);
  const prompt = str(input?.prompt)?.trim();
  if (!prompt) return undefined;
  return calls.findLast(call => call.turns.some(turn => turn.prompt === prompt));
}

/** An `agent_call` in the caller's transcript: who was asked, what, and how it is going; it opens the called conversation. */
export const AgentCallRow = memo(function AgentCallRow({ item, stale }: { item: Extract<TimelineItem, { kind: 'tool' }>; stale?: boolean }) {
  const { t } = useLingui();
  const source = useContext(AgentCallsContext);
  const view = useMemo(() => toolView(item.event), [item.event]);
  const input = isRecord(view.rawInput) ? view.rawInput : undefined;
  const output = useMemo(() => parsedOutput(view.rawOutput), [view.rawOutput]);
  const call = source ? callOf(source.calls, input, output) : undefined;
  const missing = Boolean(source) && !call;
  const refresh = source?.refresh;
  useEffect(() => { if (missing) refresh?.(); }, [missing, refresh]);
  const rowActive = activeToolStates.has(view.status) && !stale;
  const state = call?.state ?? (rowActive ? 'working' : str(output?.state) as AgentCall['state'] | undefined ?? (view.status === 'failed' ? 'failed' : 'completed'));
  const running = state === 'working';
  const teamMembers = useLists((state) => state.teamMembers);
  const rawAgent = str(input?.agent);
  const rawMemberId = rawAgent?.startsWith('member/') ? rawAgent.slice('member/'.length) : undefined;
  const memberId = call?.memberId ?? rawMemberId;
  const member = memberId ? teamMembers.find(item => item.id === memberId) : undefined;
  const backend = call?.backendId ?? (!rawMemberId ? (rawAgent?.split('/')[0] as NativeBackendId | undefined) : undefined);
  // A follow-up names what it asked this time; the call's own title is its first request.
  const title = str(input?.prompt)?.split('\n').map(line => line.trim()).find(Boolean) ?? call?.title ?? t`调用 Agent`;
  const runsOn = call && source ? modelLine(call, source.projectId) : undefined;
  const actorName = member?.name ?? call?.memberName ?? (backend ? backendLabel(backend) : 'Agent');
  const name = [actorName, runsOn].filter(Boolean).join(' · ');
  const latest = running && call?.latest ? call.latest : undefined;
  return (
    <div className="flex min-w-0 flex-col">
      <Disclosure
        touchCompact
        opensPage={Boolean(call && source)}
        expandable={false}
        icon={running ? <Spinner className="size-3.5" /> : member ? <MemberAvatar member={member} size={16} /> : backend ? <AgentLogo backend={backend} size={14} /> : <Spinner className="size-3.5" />}
        title={title}
        detail={name}
        inline={state === 'failed' ? <RowOutcome failed /> : undefined}
        status={state === 'input-required' ? <span className="text-xs text-warning">{t`等你确认`}</span> : state === 'cancelled' ? <span className="text-xs text-fg-4">{t`已停止`}</span> : undefined}
        open={false}
        onToggle={() => { if (call) source?.open(call.id); }}
      />
      {latest && <p className="ml-6 min-w-0 truncate text-xs text-fg-3">{latest}</p>}
    </div>
  );
});
