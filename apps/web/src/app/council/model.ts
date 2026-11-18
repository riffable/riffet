import type { CouncilModelParticipant } from '@contracts';

const FAMILY_COLORS: Record<string, string> = {
  claude: 'var(--agent-claude)',
  codex: 'var(--agent-codex)',
  dsh: 'var(--agent-dsh)',
};

const FALLBACK_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

export function participantColor(participant: Pick<CouncilModelParticipant, 'backendId' | 'model'>, index = 0): string {
  const lower = participant.model.toLowerCase();
  if (lower.includes('claude')) return 'var(--agent-claude)';
  if (lower.includes('gpt') || lower.includes('codex') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) return 'var(--agent-codex)';
  if (lower.includes('deepseek')) return 'var(--agent-dsh)';
  if (lower.includes('gemini')) return 'var(--chart-4)';
  return FAMILY_COLORS[participant.backendId] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length]!;
}

export function modelFamilyKey(participant: Pick<CouncilModelParticipant, 'backendId' | 'model'>): string {
  const lower = participant.model.toLowerCase();
  if (lower.includes('claude')) return 'anthropic';
  if (lower.includes('gpt') || lower.includes('codex') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) return 'openai';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('gemini')) return 'google';
  return participant.backendId;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function formatTokens(total: number): string {
  if (total >= 1000) return `${(total / 1000).toFixed(1)}K tokens`;
  return `${total} tokens`;
}
