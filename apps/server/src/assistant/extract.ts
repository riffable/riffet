import {
  TEAM_BUDGET,
  defaultMemberCapabilities,
  isAssistantBackend,
  type AgentMemberExtractDraft,
  type AgentMemberScope,
  type AgentMemberSessionMode,
  type AgentMemberTarget,
  type AppSettings,
  type NativeBackendId,
  type Project,
  type Session,
} from '../../../../packages/contracts/src/index.js';
import { complete } from '../auxiliary/gateway.js';
import { auxiliaryEndpoint, resolveAuxiliaryModel, type GatewayProfiles } from '../auxiliary/models.js';
import type { AuxiliaryCallRecorder } from '../auxiliary/telemetry.js';
import type { Store } from '../store.js';

export interface ExtractMemberDeps {
  store: Store;
  settings: () => AppSettings;
  gatewayProfiles: GatewayProfiles;
  transcript: (sessionId: string) => Promise<string>;
  recordAuxiliaryCall?: AuxiliaryCallRecorder;
}

const EXTRACT_SYSTEM_PROMPT = `You distill a recurring Riffet conversation into a reusable Team Member specification.
Return ONLY a single JSON object (no markdown fences, no commentary) matching:
{
  "name": "short role name (2-20 chars, in the conversation's language)",
  "description": "one concise sentence describing this member's ongoing responsibility",
  "scopeKind": "project" | "personal",
  "sessionMode": "fresh" | "continuous",
  "instructions": "Markdown AGENTS.md mandate: responsibilities, workflow, acceptance criteria, and red lines (10-30 lines)",
  "initialMemory": "Markdown notes capturing durable environment facts, IDs, hosts, commands, known pitfalls, and baselines discovered in the conversation (concise bullet points; omit one-off timestamps or transient logs)"
}
Guidelines:
- Choose sessionMode "fresh" for repeatable operational jobs (packaging, release, QA verification, audits) where each run should start with clean context while keeping memory.
- Choose sessionMode "continuous" for long-running domain advisory roles (investing, planning, research) where continuous dialogue is preferred.
- Choose scopeKind "project" when the conversation operates inside a code repository; choose "personal" otherwise.
- Write concrete, actionable facts in initialMemory so the member never repeats initial environment discovery.`;

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* try next */ }
  }
  return undefined;
}

function deterministicDraft(session: Session, project: Project | undefined, transcript: string, fallbackReason?: string): AgentMemberExtractDraft {
  const isCodeProject = Boolean(project && !project.system);
  const scope: AgentMemberScope = isCodeProject
    ? { kind: 'project', projectIds: [project!.id] }
    : { kind: 'personal' };
  const sessionMode: AgentMemberSessionMode = isCodeProject ? 'fresh' : 'continuous';
  const baseName = (session.title || project?.name || '专职成员').trim().slice(0, 24);
  const messages = transcript
    .split(/\n(?=### |\*\*User|\*\*Assistant|User:|Assistant:)/)
    .map(part => part.trim())
    .filter(Boolean);
  const recentSnippets = messages.slice(-6).map(part => part.slice(0, 450)).join('\n\n---\n\n');
  const target: AgentMemberTarget | undefined = isAssistantBackend(session.backendId)
    ? {
      backendId: session.backendId as NativeBackendId,
      ...(session.backendProfileId ? { profileId: session.backendProfileId } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(session.approval ? { permissionMode: session.approval } : {}),
    }
    : undefined;
  return {
    name: baseName,
    description: isCodeProject
      ? `负责 ${project!.name} 的「${baseName}」常规执行与经验沉淀`
      : `专注处理「${baseName}」相关事务并持续积累经验`,
    instructions: [
      `# ${baseName}`,
      '',
      '## 职责',
      `- 延续历史会话「${session.title}」的既定目标与验收标准。`,
      isCodeProject
        ? `- 在项目 \`${project!.name}\` 中执行相关检查、构建或验证流程，遵循仓库规范。`
        : '- 专注本领域分析与推进，不混入无关项目的上下文。',
      '',
      '## 记忆维护',
      '- 每次开始前先阅读 `memory/` 中的既有经验与环境记录。',
      '- 完成后把新发现的环境参数、避坑经验和最新基准写回 `memory/`。',
    ].join('\n'),
    initialMemory: recentSnippets
      ? `由历史会话「${session.title}」提炼（可按需删改）：\n\n${recentSnippets.slice(0, 3_000)}`
      : `由历史会话「${session.title}」创建。请在此补充关键环境信息与注意事项。`,
    scope,
    sessionMode,
    ...(target ? { target } : {}),
    capabilities: defaultMemberCapabilities(scope.kind),
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

/**
 * Distills an existing conversation into a Team Member draft (docs/TEAM.md §5.3).
 * Uses `auxiliaryModels.handoff` when available, falling back deterministically without failing.
 */
export async function extractMemberFromSession(
  deps: ExtractMemberDeps,
  sessionId: string,
  signal?: AbortSignal,
): Promise<AgentMemberExtractDraft> {
  const session = deps.store.getSession(sessionId);
  let project: Project | undefined;
  try { project = deps.store.getProject(session.projectId); } catch { project = undefined; }

  let transcript = '';
  try {
    transcript = (await deps.transcript(sessionId)).slice(-TEAM_BUDGET.extractSourceChars);
  } catch {
    const indexed = deps.store.indexedMessages(sessionId).slice(-30);
    transcript = indexed.map(m => `${m.kind === 'user' ? 'User' : 'Assistant'}: ${m.text.slice(0, 1200)}`).join('\n\n').slice(-TEAM_BUDGET.extractSourceChars);
  }

  const ref = resolveAuxiliaryModel(deps.settings(), 'handoff');
  if (!ref) {
    return deterministicDraft(session, project, transcript, 'No auxiliary model configured');
  }

  const fallback = deterministicDraft(session, project, transcript);
  try {
    const authStart = Date.now();
    const endpoint = await auxiliaryEndpoint(ref, deps.gatewayProfiles, signal);
    const authMs = Math.max(0, Date.now() - authStart);
    const userPrompt = [
      `Conversation title: ${session.title}`,
      project && !project.system ? `Bound code project: ${project.name} (${project.cwd})` : 'Bound code project: none',
      '',
      'Conversation excerpt:',
      transcript || '(empty)',
    ].join('\n');
    const raw = await complete({
      ...endpoint,
      system: EXTRACT_SYSTEM_PROMPT,
      content: userPrompt,
      maxOutputTokens: 2_000,
      timeoutMs: 45_000,
      ...(signal ? { signal } : {}),
      onMetrics: metrics => {
        deps.recordAuxiliaryCall?.({
          kind: 'handoff',
          source: 'live',
          backendId: ref.backendId,
          profileId: ref.profileId,
          model: ref.model,
          transport: endpoint.executeComplete ? 'cli-process' : 'http',
          protocol: endpoint.protocol,
          authMs,
          ...metrics,
        });
      },
    });
    const parsed = parseJsonObject(raw);
    if (!parsed) return { ...fallback, fallbackReason: 'Model returned non-JSON output' };

    const scopeKind = parsed.scopeKind === 'project' && project && !project.system ? 'project' : 'personal';
    const scope: AgentMemberScope = scopeKind === 'project' ? { kind: 'project', projectIds: [project!.id] } : { kind: 'personal' };
    const sessionMode: AgentMemberSessionMode = parsed.sessionMode === 'fresh' || parsed.sessionMode === 'continuous'
      ? parsed.sessionMode
      : fallback.sessionMode;
    return {
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 48) : fallback.name,
      description: typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim().slice(0, 300) : fallback.description,
      instructions: typeof parsed.instructions === 'string' && parsed.instructions.trim() ? parsed.instructions.trim() : fallback.instructions,
      initialMemory: typeof parsed.initialMemory === 'string' && parsed.initialMemory.trim() ? parsed.initialMemory.trim() : fallback.initialMemory,
      scope,
      sessionMode,
      ...(fallback.target ? { target: fallback.target } : {}),
      capabilities: defaultMemberCapabilities(scope.kind),
      generatedBy: `${endpoint.profileName} · ${ref.model}`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Auxiliary model failed';
    return { ...fallback, fallbackReason: reason };
  }
}
