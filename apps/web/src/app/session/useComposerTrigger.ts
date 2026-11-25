import { useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { useLingui } from '@lingui/react/macro';
import { AGENT_CALL_BUDGET, type FileEntry, type Session } from '@contracts';
import { api, isAgentReference, isSessionReference, sameContextReference, type ProjectRecord, type PromptContextReference } from '@/lib/api';
import { backendLabel, sessionBackend } from '@/lib/backends';
import { agentMentionCandidates, inlineMentionRanges, mentionText, type AgentMentionSource } from './agentMentions';
import type { SlashCommand } from './model';
import { useLingering, WAIT_GRACE_MS } from './sessionLayout';
import { detectSlashTrigger, slashCandidates, slashMenuGroups, slashTokenRanges } from './slashMenu';

export type Trigger = { type: 'slash' | 'mention'; query: string; start: number; leading?: boolean };

const NO_FILES: FileEntry[] = [];
/** ASCII local-part / identifier chars that precede `@` in emails or handles (`alice@example.com`), never a mention trigger. */
const MENTION_BEFORE_REJECT = /[A-Za-z0-9._%+-]/;

function detectMentionTrigger(text: string, caret: number, committed: readonly { start: number; end: number }[]): Trigger | null {
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = text[index]!;
    if (/\s/.test(char)) return null;
    if (char !== '@') continue;
    // A `@` that already opens a committed inline mention must not reopen autocomplete (e.g. `@Claude` or `@理财帮我看下`).
    if (committed.some(range => index >= range.start && index < range.end)) return null;
    if (index > 0 && MENTION_BEFORE_REJECT.test(text[index - 1]!) && !committed.some(range => range.end === index)) return null;
    return { type: 'mention', query: text.slice(index + 1, caret), start: index };
  }
  return null;
}

function detectTrigger(text: string, caret: number, references: readonly PromptContextReference[], mentions = true): Trigger | null {
  if (mentions) {
    const committed = inlineMentionRanges(text, references);
    const mention = detectMentionTrigger(text, caret, committed);
    if (mention) return mention;
  }
  const slash = detectSlashTrigger(text, caret);
  if (slash) return { type: 'slash', query: slash.query, start: slash.start, leading: slash.leading };
  return null;
}

export function useComposerTrigger({
  projectId,
  text,
  textRef,
  textareaRef,
  disabled,
  commands,
  inlineSkills,
  fileMentions,
  sessionMentions,
  agentMentions,
  referenceSessions,
  referenceProjects,
  recipientSessionId,
  referencesRef,
  onSlashMenuOpen,
  updateText,
  updateReferences,
  onError,
  onSubmitUnknownSlash,
}: {
  projectId: string;
  text: string;
  textRef: MutableRefObject<string>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
  commands: SlashCommand[];
  inlineSkills?: boolean;
  fileMentions: boolean;
  sessionMentions: boolean;
  agentMentions?: AgentMentionSource;
  referenceSessions?: Session[];
  referenceProjects?: ProjectRecord[];
  recipientSessionId?: string;
  referencesRef: MutableRefObject<PromptContextReference[]>;
  onSlashMenuOpen?: () => void;
  updateText: (next: string) => void;
  updateReferences: (next: PromptContextReference[]) => void;
  onError: (message: string) => void;
  onSubmitUnknownSlash: () => void;
}) {
  const { t } = useLingui();
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [highlight, setHighlight] = useState(0);
  /** The project an `@` menu has been stepped into, tied to the `@` it was opened from. */
  const [browse, setBrowse] = useState<{ start: number; projectId: string } | null>(null);
  // Results carry the project and query they answer, so what is on screen is always known to belong to a (possibly earlier) query.
  const [found, setFound] = useState<{ project: string; query: string; entries: FileEntry[] }>();
  const dismissedTriggerRef = useRef<{ text: string; caret: number } | null>(null);
  const mentionBlurTimerRef = useRef<number | undefined>(undefined);
  const menuListRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const optionId = (index: number) => `${menuId}-option-${index}`;

  useEffect(() => {
    setTrigger(null);
  }, [projectId, fileMentions, sessionMentions]);

  useEffect(() => () => {
    window.clearTimeout(mentionBlurTimerRef.current);
  }, []);

  /** Commands while the token opens the message; mid-message only skills, and only where the backend loads them there. */
  const slashGroups = useMemo(() => {
    if (trigger?.type !== 'slash') return [];
    return slashMenuGroups(slashCandidates(commands, trigger.leading === true, inlineSkills === true), trigger.query);
  }, [trigger, commands, inlineSkills]);
  const slashItems = useMemo(() => slashGroups.flatMap((group) => group.items), [slashGroups]);
  const commandsByName = useMemo(() => new Map(commands.map((item) => [item.name, item])), [commands]);
  const invokedSlashRanges = useMemo(() => slashTokenRanges(text, commandsByName, inlineSkills === true), [text, commandsByName, inlineSkills]);

  const slashQuery = trigger?.type === 'slash' ? trigger.query.trim() : '';
  /**
   * The menu lists the commands the caller advertises. Commands it does not list
   * (the CLI's TUI-only ones, e.g. /summarize) are still sendable as ordinary prompt text,
   * so offer that explicitly instead of silently showing an empty menu. Only for the leading
   * token: mid-message a slash is just as likely a path.
   */
  const unknownSlashCommand = trigger?.type === 'slash' && trigger.leading === true && Boolean(slashQuery) && !slashItems.some((command) => command.name === slashQuery);
  const slashMenuOpen = trigger?.type === 'slash';
  useEffect(() => { if (slashMenuOpen) onSlashMenuOpen?.(); }, [slashMenuOpen, onSlashMenuOpen]);

  const mentionQuery = trigger?.type === 'mention' ? trigger.query : undefined;
  if (browse && (trigger?.type !== 'mention' || trigger.start !== browse.start)) setBrowse(null);
  const browsing = sessionMentions && trigger?.type === 'mention' && browse?.start === trigger.start ? browse.projectId : undefined;
  const browsingName = browsing ? referenceProjects?.find(item => item.id === browsing)?.name ?? '' : '';
  const searchable = fileMentions && Boolean(mentionQuery) && !browsing;
  const foundHere = found?.project === projectId ? found : undefined;
  // The previous query's results stay up while the next loads; "no match" only speaks for a settled query.
  const files = searchable && foundHere ? foundHere.entries : NO_FILES;
  const searching = searchable && foundHere?.query !== mentionQuery;
  const showSearching = useLingering(searching, WAIT_GRACE_MS);

  useEffect(() => {
    if (!searchable || !mentionQuery) return;
    let active = true;
    const controller = new AbortController();
    const settle = (entries: FileEntry[]) => { if (active) setFound({ project: projectId, query: mentionQuery, entries }); };
    const timer = window.setTimeout(() => {
      api.find(projectId, mentionQuery, controller.signal)
        .then((result) => {
          const entries = Array.isArray(result) ? result : result.entries ?? [];
          settle(entries.filter((entry) => entry.kind === 'file').slice(0, 10));
        })
        .catch(() => settle([]));
    }, 140);
    return () => { active = false; controller.abort(); window.clearTimeout(timer); };
  }, [projectId, mentionQuery, searchable]);

  const activeMemberIds = useMemo(
    () => new Set((agentMentions?.members ?? []).filter(member => !member.archivedAt).map(member => member.id)),
    [agentMentions?.members],
  );
  const referenceCandidates = useMemo(
    () => (referenceSessions ?? []).filter(item => item.id !== recipientSessionId && (!item.agentMemberId || !activeMemberIds.has(item.agentMemberId) || Boolean(browsing))),
    [referenceSessions, recipientSessionId, activeMemberIds, browsing],
  );
  const sessionFiles = useMemo(() => {
    if (!sessionMentions || mentionQuery === undefined) return [];
    const query = mentionQuery.toLocaleLowerCase();
    const projects = new Map(referenceProjects?.map(item => [item.id, item.name]));
    // An empty `@` lists this project's latest sessions; every project, this one included, opens to its full list.
    const here = !browsing && !query && referenceCandidates.some(item => item.projectId === projectId);
    const scope = browsing ?? (here ? projectId : undefined);
    return referenceCandidates.filter(item => scope === undefined || item.projectId === scope).map(item => {
      const project = projects.get(item.projectId) ?? '';
      const title = item.title.toLocaleLowerCase();
      const other = `${browsing ? '' : project} ${backendLabel(sessionBackend(item))}`.toLocaleLowerCase();
      const score = !query ? 0 : title === query ? 4 : title.startsWith(query) ? 3 : title.includes(query) ? 2 : other.includes(query) ? 1 : -1;
      return { session: item, project, score };
    }).filter(item => item.score >= 0 && (query || !item.session.archivedAt)).sort((a, b) => b.score - a.score
      || Number(Boolean(a.session.archivedAt)) - Number(Boolean(b.session.archivedAt))
      || Number(b.session.projectId === projectId) - Number(a.session.projectId === projectId)
      || (b.session.lastActivityAt ?? b.session.updatedAt).localeCompare(a.session.lastActivityAt ?? a.session.updatedAt)).slice(0, browsing ? undefined : 10);
  }, [sessionMentions, mentionQuery, browsing, referenceCandidates, referenceProjects, projectId]);

  const agentCandidates = useMemo(
    () => agentMentions ? agentMentionCandidates(agentMentions.backends, agentMentions.members, agentMentions.currentMemberId) : [],
    [agentMentions],
  );
  const agentRows = useMemo(() => {
    if (!agentCandidates.length || mentionQuery === undefined || browsing) return [];
    const query = mentionQuery.toLocaleLowerCase();
    return agentCandidates.filter(item => !query
      || item.label.toLocaleLowerCase().includes(query)
      || item.backendId.toLocaleLowerCase().includes(query)
      || (item.member?.description?.toLocaleLowerCase().includes(query) ?? false));
  }, [agentCandidates, mentionQuery, browsing]);

  /** Projects with a live session, this one first (its full list is one step in), then most recently active; a query narrows them by name. */
  const projectRows = useMemo(() => {
    if (!sessionMentions || mentionQuery === undefined || browsing) return [];
    const query = mentionQuery.toLocaleLowerCase();
    const latest = new Map<string, string>();
    for (const item of referenceCandidates) {
      if (item.archivedAt) continue;
      const at = item.lastActivityAt ?? item.updatedAt;
      if ((latest.get(item.projectId) ?? '') < at) latest.set(item.projectId, at);
    }
    return (referenceProjects ?? []).filter(item => !item.system && latest.has(item.id) && (!query || item.name.toLocaleLowerCase().includes(query)))
      .sort((a, b) => Number(b.id === projectId) - Number(a.id === projectId) || latest.get(b.id)!.localeCompare(latest.get(a.id)!)).slice(0, query ? 5 : 50);
  }, [sessionMentions, mentionQuery, browsing, referenceCandidates, referenceProjects, projectId]);

  const menuLength = trigger?.type === 'slash' ? slashItems.length + (unknownSlashCommand ? 1 : 0) : files.length + agentRows.length + sessionFiles.length + projectRows.length;
  const highlightScope = `${trigger?.type}|${trigger?.query}|${browsing}|${files.length}|${agentRows.length}|${sessionFiles.length}|${projectRows.length}`;
  const [highlightedScope, setHighlightedScope] = useState(highlightScope);
  if (highlightedScope !== highlightScope) { setHighlightedScope(highlightScope); setHighlight(0); }

  useEffect(() => {
    menuListRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const syncTrigger = (value: string, caret: number) => {
    const dismissed = dismissedTriggerRef.current;
    if (dismissed?.text === value && dismissed.caret === caret) return;
    dismissedTriggerRef.current = null;
    setTrigger(detectTrigger(value, caret, referencesRef.current, fileMentions || sessionMentions || agentCandidates.length > 0));
  };

  const replaceRange = (start: number, end: number, insert: string) => {
    const current = textRef.current;
    const next = current.slice(0, start) + insert + current.slice(end);
    updateText(next);
    setTrigger(null);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      const caret = start + insert.length;
      element.setSelectionRange(caret, caret);
    });
  };

  /** Step into a project's sessions (or back out); the typed query is cleared, the `@` stays. */
  const browseInto = (next: string | undefined) => {
    if (!trigger || trigger.type !== 'mention') return;
    const caret = textareaRef.current?.selectionStart ?? textRef.current.length;
    const from = trigger.start + 1;
    if (caret > from) updateText(textRef.current.slice(0, from) + textRef.current.slice(caret));
    setTrigger({ type: 'mention', query: '', start: trigger.start });
    setBrowse(next ? { start: trigger.start, projectId: next } : null);
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(from, from));
  };

  const choose = (index: number) => {
    if (disabled || !trigger) return;
    const caret = textareaRef.current?.selectionStart ?? textRef.current.length;
    if (trigger.type === 'slash') {
      const command = slashItems[index];
      // Only the typed token is replaced, so a skill picked mid-message keeps the words around it.
      if (command) replaceRange(trigger.start, caret, /^\s/.test(textRef.current.slice(caret)) ? `/${command.name}` : `/${command.name} `);
      // Index past the advertised list is the "send verbatim" row.
      else if (unknownSlashCommand) { setTrigger(null); onSubmitUnknownSlash(); }
    } else {
      const file = files[index];
      const agent = agentRows[index - files.length];
      const selected = sessionFiles[index - files.length - agentRows.length]?.session;
      const project = projectRows[index - files.length - agentRows.length - sessionFiles.length];
      if (project) { browseInto(project.id); return; }
      const suffix = /^\s/.test(textRef.current.slice(caret)) ? '' : ' ';
      if (agent) {
        const reference = {
          kind: 'agent' as const,
          backendId: agent.backendId,
          label: agent.label,
          ...(agent.member ? { memberId: agent.member.id } : {}),
        };
        if (!referencesRef.current.some(item => sameContextReference(item, reference))) {
          if (referencesRef.current.filter(isAgentReference).length >= AGENT_CALL_BUDGET.mentions) { onError(t`最多提到 ${AGENT_CALL_BUDGET.mentions} 个 Agent`); return; }
          updateReferences([...referencesRef.current, reference]);
        }
        // The mention is written where the `@` was, so the sentence reads as the request it is.
        replaceRange(trigger.start, caret, `${mentionText(agent.label)}${suffix}`);
        return;
      } else if (file) {
        const reference = { path: file.path, inline: true as const };
        if (!referencesRef.current.some(item => sameContextReference(item, reference))) updateReferences([...referencesRef.current, reference]);
        replaceRange(trigger.start, caret, `${mentionText(file.path)}${suffix}`);
        return;
      } else if (selected) {
        const reference = { kind: 'session' as const, sessionId: selected.id, title: selected.title, backendId: sessionBackend(selected), inline: true as const };
        if (!referencesRef.current.some(item => sameContextReference(item, reference))) {
          if (referencesRef.current.filter(isSessionReference).length >= 5) { onError(t`最多引用 5 个会话`); return; }
          updateReferences([...referencesRef.current, reference]);
        }
        replaceRange(trigger.start, caret, `${mentionText(selected.title || selected.id)}${suffix}`);
        return;
      } else return;
    }
  };

  const resetTrigger = () => {
    dismissedTriggerRef.current = null;
    setTrigger(null);
  };

  const dismissTrigger = (caret: number) => {
    dismissedTriggerRef.current = { text: textRef.current, caret };
    setTrigger(null);
  };

  const clearBlurTimer = () => window.clearTimeout(mentionBlurTimerRef.current);
  const scheduleBlurClose = () => {
    window.clearTimeout(mentionBlurTimerRef.current);
    mentionBlurTimerRef.current = window.setTimeout(() => setTrigger(null), 120);
  };

  const menuOpen = Boolean(trigger && (trigger.type === 'mention' || slashItems.length || unknownSlashCommand));

  return {
    trigger,
    setTrigger,
    highlight,
    setHighlight,
    browsing,
    browsingName,
    searching,
    showSearching,
    files,
    agentCandidates,
    agentRows,
    sessionFiles,
    projectRows,
    slashGroups,
    slashItems,
    invokedSlashRanges,
    slashQuery,
    unknownSlashCommand,
    menuOpen,
    menuLength,
    menuListRef,
    menuId,
    optionId,
    syncTrigger,
    browseInto,
    choose,
    resetTrigger,
    dismissTrigger,
    clearBlurTimer,
    scheduleBlurClose,
  };
}
