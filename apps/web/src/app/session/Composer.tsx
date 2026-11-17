import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowLeft, IconArrowUp, IconAtSign, IconChevronDown, IconChevronRight, IconFileText, IconFolder, IconInfinity, IconListTodo, IconMaximize, IconMessageCircleQuestion, IconMinimize, IconPaperclip, IconPlus, IconSlash, IconSparkles, IconSquare, IconX } from '@/components/icons';
import { isNativeBackendId, type Attachment, type FileEntry, type NativeBackendUsage, type Session } from '@contracts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ToolsPickerInMenu } from './ToolsPicker';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { Spinner, StatusDot } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { api, HttpError, isSessionReference, sameContextReference, restoreContext, mergeRestoredReferences, type NativeSessionCreateInput, type PromptContextReference } from '@/lib/api';
import { cn, errorMessage } from '@/lib/utils';
import { AgentLogo } from '@/components/AgentLogo';
import { backendLabel, sessionBackend } from '@/lib/backends';
import type { ProjectRecord } from '@/lib/api';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { isTextField, keepsComposerFocus, pressTarget } from '@/lib/tap-focus';
import type { ModelParam } from '@/lib/models';
import type { Choice, ContextUsage, SlashCommand } from './model';
import { ModelPicker, type ModelProviderChoices } from './ModelPicker';
import { clipboardFiles, readUploadData, uploadName } from './image-upload';
import { classifyEnterGesture, isComposingKey, primaryEnterHint, readEnterKeyBehavior, resolveEnter, resolveEscapeLayer, type EnterKeyBehavior } from './composerKeyboard';
import { ComposerFullscreen } from './ComposerFullscreen';
import { SendLaterMenu } from '../automations/SendLater';
import { useComposerAutosize } from './useComposerAutosize';
import { useHeld, useLingering, WAIT_GRACE_MS } from './sessionLayout';
import { Collapse } from '@/components/ui/collapse';
import { shouldForwardWheel } from './composerFullscreenGeometry';
import { ComposerAttachments } from './ComposerAttachments';
import { joinQuotes, splitQuotes } from './quotes';
import { attachmentMimeType, planIntake, type CandidateFile, type PendingUpload } from './composerAttachmentIntake';
import { mentionsDeletedSession } from '@/lib/session-deletion';
import { detectSlashTrigger, invokedSlashItems, removeSlashToken, slashCandidates, slashMenuGroups } from './slashMenu';
import { findAnimation } from '@/lib/motion';

const NO_FILES: FileEntry[] = [];

const modeMeta: Record<string, { icon: typeof IconInfinity; description: MessageDescriptor }> = {
  agent: { icon: IconInfinity, description: msg`自主读写文件、执行命令` },
  plan: { icon: IconListTodo, description: msg`先出方案，确认后再动手` },
  ask: { icon: IconMessageCircleQuestion, description: msg`只读问答，不修改文件` },
};

export const compactTokens = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(Math.round(value));

/**
 * Context-window gauge. Renders only what the agent actually reported; when nothing has
 * been reported yet there is no meter at all, which is why it is safe to show nothing
 * rather than an invented number.
 */
const contextLabels: Record<string, MessageDescriptor> = {
  system_prompt: msg`系统提示词`, tools: msg`工具定义`, rules: msg`规则`, skills: msg`Skills`, mcp: msg`MCP 与动态工具`,
  subagents: msg`子 Agent 定义`, summarized_conversation: msg`已压缩的对话`, conversation: msg`对话`,
  cached_input: msg`缓存输入`, cacheRead: msg`缓存读取`, cache_write: msg`缓存写入`, cacheWrite: msg`缓存写入`, reasoning_output: msg`思考输出`,
  systemPrompt: msg`系统提示词`, toolDefinitions: msg`工具定义`, developerMessages: msg`指令`, userMessages: msg`你的消息`,
  assistantMessages: msg`回复`, toolResponses: msg`工具结果`, otherMessages: msg`其他`,
};

function contextPartLabel(id: string, parts: readonly { id: string }[]): string | undefined {
  if (id === 'input') {
    const splitFromCache = parts.some((item) => ['cached_input', 'cacheRead', 'cacheWrite'].includes(item.id));
    return i18n._(splitFromCache ? msg`未缓存输入` : msg`输入`);
  }
  if (id === 'output') return i18n._(parts.some((item) => item.id === 'reasoning_output') ? msg`回复输出` : msg`输出`);
  return contextLabels[id] ? i18n._(contextLabels[id]!) : undefined;
}

const ContextMeter = memo(function ContextMeter({ usage }: { usage: ContextUsage }) {
  const { t } = useLingui();
  const ratio = Math.min(1, Math.max(0, usage.used / usage.size));
  const percent = Math.round(usage.used / usage.size * 100);
  const title = t`上下文用量`;
  // The ring alone, in the toolbar's own ink until the window runs short; the figures live in the
  // tooltip and the popover, so the row never carries a number that changes every turn.
  const color = ratio >= 0.9 ? 'var(--danger)' : ratio >= 0.75 ? 'var(--warning)' : 'currentColor';
  const cost = usage.cost ? ` · ${usage.cost.currency} ${usage.cost.amount.toFixed(2)}` : '';
  const limitLabel = usage.limitKind === 'compaction' ? t`自动压缩阈值` : t`上下文长度`;
  const label = `${title} ${percent}% · ${compactTokens(usage.used)} / ${limitLabel} ${compactTokens(usage.size)} tokens${cost}`;
  // 2πr for r = 6, so the dash length maps directly onto the ratio.
  const circumference = 2 * Math.PI * 6;
  const parts = usage.breakdown?.filter((item) => item.tokens > 0) ?? [];
  const breakdownTotal = parts.reduce((total, item) => total + item.tokens, 0);
  return (
    <Popover>
      <Tip label={`${title} ${percent}%`} side="top">
        <PopoverTrigger
          aria-label={label}
          // The same square as the toolbar's other glyph buttons, so the meter sits one footer gap
          // from the model name exactly as the attach and approval buttons sit from each other.
          className="grid size-11 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus aria-expanded:bg-hover aria-expanded:text-fg md:size-7"
        >
          <svg viewBox="0 0 16 16" className="size-4 shrink-0 -rotate-90" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="var(--line-strong)" strokeWidth="2" />
            <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={`${ratio * circumference} ${circumference}`} />
          </svg>
        </PopoverTrigger>
      </Tip>
      <PopoverContent side="top" align="start" className="w-72 p-3">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium text-fg">{title} <span className="tabular-nums text-fg-3">{percent}%</span></span>
          <span className="tabular-nums text-fg-3">{compactTokens(usage.used)} / {compactTokens(usage.size)}</span>
        </div>
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-line">
          {parts.length && !usage.breakdownEstimated
            ? parts.map((item, index) => <span key={item.id} className="h-full shrink-0" style={{ width: `${ratio * item.tokens / Math.max(1, usage.used, breakdownTotal) * 100}%`, background: color, opacity: 1 - index * (0.7 / parts.length) }} />)
            : <span className="h-full" style={{ width: `${ratio * 100}%`, background: color }} />}
        </div>
        {usage.limitKind === 'compaction' && <div className="mt-2 text-xs text-fg-3"><Trans>自动压缩阈值：{compactTokens(usage.size)} tokens；按最近一次模型响应计量</Trans></div>}
        {parts.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5 text-xs">
            {usage.breakdownEstimated && <li className="text-fg-3"><Trans>内容估算 · ~{compactTokens(breakdownTotal)}</Trans></li>}
            {parts.map((item) => (
              <li key={item.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-fg-2">{contextPartLabel(item.id, parts) ?? item.label}</span>
                <span className="tabular-nums text-fg-3">{usage.breakdownEstimated ? '~' : ''}{compactTokens(item.tokens)}</span>
                <span className="w-10 text-right tabular-nums text-fg-3">{((item.tokens / Math.max(1, breakdownTotal)) * 100).toFixed(0)}%</span>
              </li>
            ))}
          </ul>
        )}
        {usage.cost && <div className="mt-2 text-xs text-fg-3"><Trans>费用 {usage.cost.currency} {usage.cost.amount.toFixed(2)}</Trans></div>}
      </PopoverContent>
    </Popover>
  );
});

const fallbackModes: Choice[] = [
  { id: 'agent', label: 'Agent' },
  { id: 'plan', label: 'Plan' },
  { id: 'ask', label: 'Ask' },
];

export function ModePicker({ modes, value, onChange, disabled, className }: { modes: Choice[]; value?: string; onChange: (id: string) => void; disabled?: boolean; className?: string }) {
  const { t } = useLingui();
  const list = modes.length ? modes : fallbackModes;
  const current = list.find((mode) => mode.id === value) ?? list[0];
  const Icon = modeMeta[current?.id ?? '']?.icon ?? IconInfinity;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger disabled={disabled} className={cn("inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-sm font-medium text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 data-[state=open]:bg-hover data-[state=open]:text-fg", className)}>
        <Icon className="size-3.5" />
        <span>{current?.label ?? t`模式`}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="w-64">
        <DropdownMenuLabel>{t`模式`}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current?.id} onValueChange={onChange}>
          {list.map((mode) => {
            const meta = modeMeta[mode.id];
            const ItemIcon = meta?.icon ?? IconInfinity;
            return (
              <DropdownMenuRadioItem key={mode.id} value={mode.id} className="h-auto items-start py-2">
                <ItemIcon className="mt-0.5" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium">{mode.label}</span>
                  <span className="text-xs text-fg-3">{meta?.description ? i18n._(meta.description) : mode.description ?? mode.id}</span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Trigger = { type: 'slash' | 'mention'; query: string; start: number; leading?: boolean };

function detectTrigger(text: string, caret: number, mentions = true): Trigger | null {
  const before = text.slice(0, caret);
  if (mentions) {
    const mention = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (mention) return { type: 'mention', query: mention[1]!, start: caret - mention[1]!.length - 1 };
  }
  const slash = detectSlashTrigger(text, caret);
  if (slash) return { type: 'slash', query: slash.query, start: slash.start, leading: slash.leading };
  return null;
}

export interface ComposerProps {
  projectId: string;
  variant?: 'dock' | 'hero';
  /** A chat already inside a floating surface needs no second floating-card shadow. */
  embedded?: boolean;
  placeholder?: string;
  /**
   * What Enter does on a physical keyboard, from `AppSettings.composerEnterBehavior`. Cmd/Ctrl+Enter
   * sends either way, so an absent or unreadable value can only change whether plain Enter sends —
   * never whether this composer can send at all.
   */
  enterBehavior?: string;
  disabled?: boolean;
  /** Prevents sending while keeping the draft editable. */
  submitDisabled?: boolean;
  pickersDisabled?: boolean;
  /**
   * Why the pickers are unavailable, shown inside the mobile settings sheet.
   *
   * The sheet's own trigger must stay pressable: a `disabled` button dispatches no pointer events, so
   * the tap neither opened the sheet nor let `holdComposerFocus` hold the field — on a phone that is
   * indistinguishable from a broken control that also stole the keyboard.
   */
  pickersBlockedReason?: string;
  draftKey?: string;
  autoFocus?: boolean;
  /** Embedded conversations only receive file drops in their own pane. */
  windowDrop?: boolean;
  attachmentsAllowed?: boolean;
  models?: Choice[];
  modelsLoading?: boolean;
  /** Why the model catalog could not be read; the picker carries it and its retry. */
  modelsError?: string;
  onRetryModels?: () => void;
  /** Reads account quota and per-model load for the model list, keyed by choice id. */
  loadModelUsage?: (signal: AbortSignal) => Promise<NativeBackendUsage>;
  /** Re-reads the model catalog as the list opens, so membership cannot stay stale all day. */
  refreshCatalog?: (signal: AbortSignal) => Promise<void> | void;
  /** The agent, provider and session behind [loadModelUsage], so a same-id provider switch drops the old figures. */
  usageScopeKey?: string;
  model?: string;
  onModelChange?: (id: string) => void;
  /** Every provider the new session may draw models from; absent for an open session, whose provider is fixed. */
  providers?: ModelProviderChoices[];
  activeProviderId?: string;
  /** A provider other than the active one was previewed in the model menu (see `ModelPicker`). */
  onPreviewModelProvider?: (id: string) => void;
  /** Before the model's name on its trigger, e.g. the agent's mark when the menu also picks the agent. */
  modelLeading?: ReactNode;
  /**
   * The left group of pickers: how the agent should behave (mode, approval). The context meter and
   * the model sit on the right, next to the send button, because they describe what the message will
   * run as rather than how it was requested.
  */
  toolbar?: ReactNode;
  /** The heading `toolbar` gets in the mobile settings sheet; it is not always a permission. */
  toolbarLabel?: string;
  /** Optional current-value summary for opaque custom pickers shown in the mobile settings sheet. */
  mobileSettingsLabel?: string;
  /** Shown before `mobileSettingsLabel`, e.g. the approval mode's short name. */
  mobileSettingsPrefix?: ReactNode;
  /**
   * A picker shown immediately before the model, for a choice the model depends on. The agent
   * sits here when a session is being created: it decides which models exist, so it reads first.
   */
  startPickers?: ReactNode;
  /** The conversation's skills and tools: inline after `toolbar`, and its own section in the mobile settings sheet. */
  toolsPicker?: ReactNode;
  /** Current-value summary for `startPickers` in the mobile settings sheet. */
  startPickersLabel?: string;
  /** A picker that belongs with the model on the right, e.g. the CLI's own model control. */
  endPickers?: ReactNode;
  /**
   * Fullscreen editing (§4), owned by the host.
   *
   * The host has to know, because fullscreen makes the conversation behind the card `inert` — that
   * is the host's markup to change, and a composer that expanded without it would leave Tab walking
   * a column the user can no longer see. Passing both halves keeps one owner: a host that does not
   * offer them gets no expand toggle, rather than a button that pretends to change the layout.
   */
  fullscreen?: boolean;
  onFullscreenChange?: (open: boolean) => void;
  /** Lets the host spend a wheel gesture once the draft reaches its scrolling edge. */
  onTranscriptWheel?: (deltaY: number, deltaMode: number) => boolean;
  /** Shown next to a typed slash command that is not in `commands`. */
  unknownCommandHint?: string;
  modelParams?: ModelParam[];
  onModelParamChange?: (id: string, value: string) => void;
  /** Context-window usage reported by the agent; omit to render no meter. */
  usage?: ContextUsage;
  /** The `/` menu: built-in commands and discovered skills. */
  commands?: SlashCommand[];
  /** The backend loads a skill named mid-message, so `/` opens the skill list anywhere in the draft. */
  inlineSkills?: boolean;
  /** Whether `@` opens the file picker; a project-less chat has no files to offer. */
  fileMentions?: boolean;
  sessionMentions?: boolean;
  referenceSessions?: Session[];
  referenceProjects?: ProjectRecord[];
  recipientSessionId?: string;
  onOpenReferenceSession?: (id: string) => void;
  /** Shared task/chat drafts keep task references while the chat neither displays nor sends them. */
  referencesEnabled?: boolean;
  /** The task directory those references belong to when the upload/submit project is a quick chat. */
  referenceProjectId?: string;
  /** Called as the `/` menu opens, so the host can refresh a stale catalog. */
  onSlashMenuOpen?: () => void;
  references: PromptContextReference[];
  onReferencesChange: (references: PromptContextReference[]) => void;
  /**
   * Whether this draft keeps the references. The host's list is one list; a second composer showing
   * it (the attempts dialog over the home page) must not save it under its own key and bring back,
   * on its next opening, references the first one has since removed.
   */
  persistReferences?: boolean;
  running?: boolean;
  onStop?: () => void;
  stopping?: boolean;
  stopDisabled?: boolean;
  /** Background agents still working while the main turn is idle. */
  backgroundCount?: number;
  /** Puts a message (e.g. one taken back from the queue) into the draft; a new `nonce` applies it again. */
  restoreDraft?: { text: string; attachments: Attachment[]; context?: PromptContextReference[]; missingAttachments?: PendingUpload[]; onPersisted?: () => void; nonce: number };
  /** Adds a quote taken from the transcript to the draft; a new `nonce` adds it again. */
  quote?: { text: string; nonce: number };
  /** Dock cards rendered directly above the input card (todos, outgoing queue). */
  dock?: ReactNode;
  /** Delivery and other blocking feedback must remain reachable in fullscreen editing. */
  feedback?: ReactNode;
  /** Whether the last dock card is attached to the input card and squares off its top edge. */
  dockAttached?: boolean;
  /** The host routes the ordinary send action; this only describes its accessible label. */
  submitIntent?: 'queue' | 'steer';
  /** A durable draft update acknowledges a previously accepted creation request. */
  onSubmitPersisted?: (recover?: boolean) => void;
  /** Lets the host react to an unsent draft without receiving its contents. */
  onDraftChange?: (hasContent: boolean) => void;
  onSubmit: (prompt: string, attachments: Attachment[], context: PromptContextReference[], onStored?: () => boolean) => Promise<boolean>;
  /** Queue the message for a later time instead of sending it; shows a clock beside Send. */
  onSendLater?: (prompt: string, attachments: Attachment[], context: PromptContextReference[], at: Date) => Promise<boolean>;
  onError: (message: string) => void;
}

/**
 * How deep the current file drag is inside the window, counted across every mounted composer.
 *
 * `dragenter`/`dragleave` fire for each element the pointer crosses, so a per-component boolean
 * flickers off whenever the pointer moves onto a child of the very element that armed it.
 */
let windowDragDepth = 0;

const NO_COMMANDS: SlashCommand[] = [];

/**
 * What a draft keeps in `sessionStorage`: the text, the attachments as the server recorded them, and
 * the file references — with the project they name paths in, since a draft can follow the reader to
 * another project (the new-session draft does) and references do not travel.
 */
/** `keys` holds each attachment's duplicate-check key by id, so the same file dropped again after a reload is still recognized. */
interface StoredDraft { text: string; attachments: Attachment[]; references: PromptContextReference[]; projectId?: string; keys?: Record<string, string>; pendingUploads?: PendingUpload[] }

const isAttachment = (value: unknown): value is Attachment => {
  const item = value as Partial<Attachment> | null;
  return typeof item?.id === 'string' && typeof item.name === 'string' && typeof item.mimeType === 'string' && typeof item.path === 'string' && typeof item.size === 'number';
};
const isReference = (value: unknown): value is PromptContextReference => {
  const item = value as Partial<PromptContextReference> | null;
  return item?.kind === 'session' ? typeof item.sessionId === 'string' && Boolean(item.sessionId) && (item.fromRunId === undefined || typeof item.fromRunId === 'string' && Boolean(item.fromRunId)) && (item.title === undefined || typeof item.title === 'string') && (item.backendId === undefined || isNativeBackendId(item.backendId)) : typeof item?.path === 'string' && (item.line === undefined || typeof item.line === 'number');
};

const recoveredCreationEvent = 'riffet:acknowledge-creation-draft';

function creationDraftRemainder(draft: StoredDraft, body: NativeSessionCreateInput): StoredDraft {
  const submittedIds = new Set(body.initialMessage.attachments?.map(({ id }) => id) ?? []);
  const submittedReferences = restoreContext(body.initialMessage);
  return {
    ...draft,
    text: draft.text.trim() === body.initialMessage.text.trim() ? '' : draft.text,
    attachments: draft.attachments.filter(({ id }) => !submittedIds.has(id)),
    references: body.backendId !== 'chat'
      ? draft.references.filter(reference => (!isSessionReference(reference) && draft.projectId !== body.projectId) || !submittedReferences.some(item => sameContextReference(item, reference)))
      : draft.references,
    ...(draft.keys ? { keys: Object.fromEntries(Object.entries(draft.keys).filter(([id]) => !submittedIds.has(id))) } : {}),
  };
}

/** Synchronize the mounted composer before navigating, then acknowledge its persisted sent text. */
export function acknowledgeRecoveredCreationDraft(body: NativeSessionCreateInput): boolean {
  const detail = { body, handled: false, saved: true };
  window.dispatchEvent(new CustomEvent(recoveredCreationEvent, { detail }));
  if (detail.handled) return detail.saved;
  if (!detail.saved) return false;
  const key = 'riffet.draft.new:home';
  try { sessionStorage.getItem(key); } catch { return false; }
  const draft = readDraft(key);
  return writeDraft(key, creationDraftRemainder(draft, body));
}

/** Never throws: storage can be unavailable (private browsing, a policy), and a draft is best effort. */
function readDraft(key: string): StoredDraft {
  const empty: StoredDraft = { text: '', attachments: [], references: [] };
  let raw: string | null = null;
  try { raw = key ? sessionStorage.getItem(key) : null; } catch { return empty; }
  if (!raw) return key === 'riffet.draft.new:home' ? mergeQuickChatDraft(empty) : empty;
  try {
    const value = JSON.parse(raw) as Partial<StoredDraft> | null;
    if (value && typeof value.text === 'string' && Array.isArray(value.attachments) && Array.isArray(value.references)) {
      const draft: StoredDraft = {
        text: value.text,
        attachments: value.attachments.filter(isAttachment),
        references: value.references.filter(isReference),
        ...(Array.isArray(value.pendingUploads) ? { pendingUploads: value.pendingUploads.filter(item => typeof item.key === 'string' && typeof item.name === 'string').map(item => ({ ...item, error: i18n._(msg`请重新选择文件`) })) } : {}),
        ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
        ...(value.keys && typeof value.keys === 'object' ? { keys: Object.fromEntries(Object.entries(value.keys).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } : {}),
      };
      return key === 'riffet.draft.new:home' ? mergeQuickChatDraft(draft) : draft;
    }
  } catch { /* the bare text drafts were stored as before attachments and references were kept */ }
  const draft = { ...empty, text: raw };
  return key === 'riffet.draft.new:home' ? mergeQuickChatDraft(draft) : draft;
}

/** Retire the old separate chat draft only after both drafts are safely stored together. */
function mergeQuickChatDraft(task: StoredDraft): StoredDraft {
  const legacyKey = 'riffet.draft.quick-chat:home';
  const chat = readDraft(legacyKey);
  if (!chat.text && !chat.attachments.length) return task;
  const merged: StoredDraft = {
    ...task,
    text: [task.text, chat.text !== task.text ? chat.text : ''].filter(Boolean).join('\n\n'),
    attachments: [...task.attachments, ...chat.attachments.filter((item) => !task.attachments.some((other) => other.id === item.id))],
    keys: { ...chat.keys, ...task.keys },
  };
  if (writeDraft('riffet.draft.new:home', merged)) {
    try { sessionStorage.removeItem(legacyKey); } catch { /* Keep the old copy until storage is writable again. */ }
  }
  return merged;
}

/** Whether the write went through; an empty draft removes its key. */
function writeDraft(key: string, draft: StoredDraft): boolean {
  // A conversation deleted meanwhile must not get its draft back from a pending flush.
  if (mentionsDeletedSession(key)) return true;
  try {
    if (draft.text || draft.attachments.length || draft.references.length || draft.pendingUploads?.length) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Keys whose failed write was already reported: a full storage fails every 400ms of typing. */
const unsavedDrafts = new Set<string>();

const FOLLOW_ID = 'composer-feedback-resize';
/** `--duration-base`. */
const FOLLOW_MS = 200;

/**
 * Ref for the box around the notices above the card. `Collapse` moves only as the area opens and
 * closes; a swap while it stays open (the catalog's loading line turning into an error) slides this
 * box from the old height to the new one instead of moving the card in a single frame. A width
 * change reflows at once, like the text it holds.
 */
function followContentHeight(frame: HTMLDivElement | null) {
  const content = frame?.firstElementChild;
  if (!frame || !(content instanceof HTMLElement)) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let last: { width: number; height: number } | undefined;
  const observer = new ResizeObserver(([entry]) => {
    const size = entry?.borderBoxSize[0];
    if (!size) return;
    const next = { width: size.inlineSize, height: size.blockSize };
    const previous = last;
    last = next;
    // `Collapse` clips its box while closed or moving: opening and closing are its move, and sliding
    // this box too would run two animations on one edge.
    const moving = frame.parentElement && getComputedStyle(frame.parentElement).overflow !== 'visible';
    if (!previous || moving || previous.width !== next.width || Math.abs(previous.height - next.height) < 1 || reducedMotion.matches) return;
    // A swap mid-slide starts from where the box is now, not from where the last one began.
    const running = findAnimation(frame, FOLLOW_ID);
    const from = running ? frame.getBoundingClientRect().height : previous.height;
    running?.cancel();
    frame.animate([{ height: `${from}px`, overflow: 'hidden' }, { height: `${next.height}px`, overflow: 'hidden' }], { id: FOLLOW_ID, duration: FOLLOW_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
  });
  observer.observe(content);
  return () => observer.disconnect();
}

/**
 * Memoized: a streaming conversation renders its host on every frame, and a host that keeps its
 * props stable (callbacks, picker elements, the dock) lets the composer sit those frames out.
 */
export const Composer = memo(function Composer(props: ComposerProps) {
  const { t } = useLingui();
  const { projectId, referenceProjectId = projectId, referencesEnabled = true, variant = 'dock', disabled, draftKey, references, onReferencesChange, persistReferences = true, running, commands = NO_COMMANDS, onError, fileMentions = true, sessionMentions = false } = props;
  const visibleReferences = referencesEnabled ? references : [];
  const openReferenceSession = (id: string) => {
    if (storageKey) {
      pendingDraftRef.current = { key: storageKey, draft: currentDraft() };
      flushDraft();
      if (unsavedDrafts.has(storageKey)) { onError(t`草稿无法保存到浏览器，刷新后会丢失`); return; }
    }
    props.onOpenReferenceSession?.(id);
  };
  const storageKey = draftKey ? `riffet.draft.${draftKey}` : '';
  const [, refreshDraftPersistence] = useState(0);
  const draftWarningId = useId();
  const enterBehavior = readEnterKeyBehavior(props.enterBehavior);
  // A stored draft keeps its quotes as the block quotes its text starts with (quotes.ts).
  const [text, setText] = useState(() => splitQuotes(readDraft(storageKey).text).body);
  const [quotes, setQuotes] = useState<string[]>(() => splitQuotes(readDraft(storageKey).text).quotes);
  const [attachments, setAttachments] = useState<Attachment[]>(() => readDraft(storageKey).attachments);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>(() => readDraft(storageKey).pendingUploads ?? []);
  const pendingUploadsRef = useRef(pendingUploads);
  const uploadFilesRef = useRef(new Map<string, File>());
  const activeUploadKeysRef = useRef(new Set<string>());
  const reselectUploadKeyRef = useRef<string | undefined>(undefined);
  const updatePendingUploads = (update: (current: PendingUpload[]) => PendingUpload[]) => {
    pendingUploadsRef.current = update(pendingUploadsRef.current);
    setPendingUploads(pendingUploadsRef.current);
  };
  const uploading = pendingUploads.length > 0;
  const draftAtRisk = unsavedDrafts.has(storageKey) && Boolean(text || quotes.length || attachments.length || (persistReferences && references.length));
  const [submitting, setSubmitting] = useState(false);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [highlight, setHighlight] = useState(0);
  /** The project an `@` menu has been stepped into, tied to the `@` it was opened from. */
  const [browse, setBrowse] = useState<{ start: number; projectId: string } | null>(null);
  // Results carry the project and query they answer, so what is on screen is always known to belong to a (possibly earlier) query.
  const [found, setFound] = useState<{ project: string; query: string; entries: FileEntry[] }>();
  const [dragging, setDragging] = useState(false);
  /**
   * Whole-window drag target: a file dragged anywhere over the page is on its way to this composer.
   * The shared depth counter above decides when the drag has really left; this is only its face.
   */
  const [windowDragging, setWindowDragging] = useState(false);
  const [attachmentsExpanded, setAttachmentsExpanded] = useState(false);
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  useEffect(() => {
    setTrigger(null);
    setMobileSettingsOpen(false);
  }, [projectId, fileMentions, sessionMentions]);
  const [viewportHeight, setViewportHeight] = useState(() => typeof window === 'undefined' ? 0 : window.visualViewport?.height ?? window.innerHeight);
  /**
   * Fullscreen editing (§4). The state only decides layout and the draft's cap — the card, the draft
   * and every listener below are the same objects in both modes, which is what keeps the caret.
   *
   * Never on a phone: the card already spans the screen there, and taking the composer out of the
   * column would cost the dock cards their place above the keyboard.
   */
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const fullscreenToggleRef = useRef<HTMLButtonElement>(null);
  /** `undefined` means the host does not offer fullscreen; `false` means it does and it is closed. */
  const fullscreenOffered = props.onFullscreenChange !== undefined;
  const fullscreenRequested = props.fullscreen ?? fullscreenOpen;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionBlurTimerRef = useRef<number | undefined>(undefined);
  const transcriptWheelRef = useRef(props.onTranscriptWheel);
  transcriptWheelRef.current = props.onTranscriptWheel;
  const dismissedTriggerRef = useRef<{ text: string; caret: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef(text);
  const textRevisionRef = useRef(0);
  const attachmentsRef = useRef(attachments);
  /**
   * Dedupe key per accepted attachment id. Draft attachments are plain `Attachment` records, which
   * carry no `lastModified`, so the key `validateIntake`/`newCandidates` work with is the one the
   * `File` produced — kept here rather than on the record so nothing downstream has to know about it.
   */
  const attachmentKeysRef = useRef(new Map<string, string>());
  const pendingAttachmentKeysRef = useRef(new Set<string>());
  const draftGenerationRef = useRef(0);
  const referencesRef = useRef(references);
  const referencesRevisionRef = useRef(0);
  const submittingRef = useRef(false);
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  /*
   * Fullscreen is a desktop affordance: the card already spans a phone's screen, and lifting it out
   * of the column there would cost the dock cards their place above the keyboard. Gating on the
   * media query as well as the state also means a window resized down to phone width leaves
   * fullscreen instead of stranding the card in a panel sized for a desktop.
   */
  const fullscreen = fullscreenRequested && !isMobile;
  /** One setter for the toggle, the scrim and the close button, so the host never sees two owners. */
  const setFullscreen = (open: boolean) => {
    setFullscreenOpen(open);
    props.onFullscreenChange?.(open);
  };
  useEffect(() => {
    if (isMobile && fullscreenRequested) {
      setFullscreenOpen(false);
      props.onFullscreenChange?.(false);
    }
  }, [isMobile, fullscreenRequested, props.onFullscreenChange]);
  const wasMobileRef = useRef(isMobile);
  const cardRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const blurTimerRef = useRef<number | undefined>(undefined);
  const compact = isMobile && variant === 'dock' && !focused && !mobileSettingsOpen && !dragging
    && !text && !quotes.length && !attachments.length && !references.length && !uploading && !draftAtRisk;
  /**
   * Entrance motion for the controls the compact/full toggle adds.
   *
   * The card cannot tween between the two states — it collapses from a row into a column, and a
   * content-sized height has nothing to interpolate — so the reflow itself stays instant. What is
   * worth softening is the controls teleporting into place: those are either mounted conditionally
   * or switched off with `hidden`, and both take the element out of the box tree, which restarts a
   * CSS animation on the way back. An entrance animation therefore works where a transition cannot,
   * and it is covered by the `prefers-reduced-motion` rule in the stylesheet.
   *
   * Scoped to the dock on mobile, which is the only place the toggle exists: everywhere else it
   * would fire once on first paint for no reason.
   */
  const toggleEntrance = isMobile && variant === 'dock' && !compact ? 'animate-in fade-in-0 duration-[var(--duration-base)] ease-[var(--ease-decelerate)]' : undefined;

  const updateText = (next: string) => {
    textRef.current = next;
    textRevisionRef.current += 1;
    setText(next);
  };

  const quotesRef = useRef(quotes);
  /** Quotes are part of the text that is sent, so a change to them is a change to the text. */
  const updateQuotes = (next: string[]) => {
    quotesRef.current = next;
    textRevisionRef.current += 1;
    setQuotes(next);
  };

  const updateAttachments = (next: Attachment[] | ((current: Attachment[]) => Attachment[])) => {
    const value = typeof next === 'function' ? next(attachmentsRef.current) : next;
    const ids = new Set(value.map((item) => item.id));
    for (const id of attachmentKeysRef.current.keys()) {
      if (!ids.has(id)) attachmentKeysRef.current.delete(id);
    }
    attachmentsRef.current = value;
    setAttachments(value);
  };

  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const updateReferences = (next: PromptContextReference[]) => {
    referencesRef.current = next;
    referencesRevisionRef.current += 1;
    onReferencesChange(next);
  };

  /*
   * A draft key brings its whole draft back: text, attachments and references.
   *
   * The attachments are shown at once and checked against the server behind them; one it no longer
   * has (cleaned up, another machine's) leaves the draft, and the reader is told. The references
   * return through the host, which clears its list when the conversation changes — in the same
   * update that changes this key, so this effect runs after that clear, not before it.
   *
   * A project change alone takes nothing: attachments are server-wide records
   * (`/api/attachments/:id`), usable from any project, and the text is the reader's.
   */
  useEffect(() => {
    draftGenerationRef.current += 1;
    const generation = draftGenerationRef.current;
    pendingAttachmentKeysRef.current = new Set();
    const stored = readDraft(storageKey);
    uploadFilesRef.current.clear();
    activeUploadKeysRef.current.clear();
    updatePendingUploads(() => stored.pendingUploads ?? []);
    const storedText = splitQuotes(stored.text);
    updateText(storedText.body);
    updateQuotes(storedText.quotes);
    updateAttachments(stored.attachments);
    for (const item of stored.attachments) if (stored.keys?.[item.id]) attachmentKeysRef.current.set(item.id, stored.keys[item.id]!);
    dismissedTriggerRef.current = null;
    setTrigger(null);
    const current = referencesRef.current;
    const restored = persistReferences
      ? stored.references.filter(item => isSessionReference(item) || stored.projectId === referenceProjectId).filter((item) => !current.some((other) => sameContextReference(other, item)))
      : [];
    if (restored.length) updateReferences([...current, ...restored]);
    if (!stored.attachments.length) return;
    void Promise.all(stored.attachments.map((item) => api.attachmentMetadata(item.id).then(
      (fresh) => [item.id, fresh] as const,
      // Only "not found" means unusable; a server that is merely unreachable keeps the draft as it is.
      (error: unknown) => [item.id, error instanceof HttpError && error.status === 404 ? null : item] as const,
    ))).then((checked) => {
      if (generation !== draftGenerationRef.current) return;
      const verdict = new Map<string, Attachment | null>(checked);
      const gone = checked.filter(([, value]) => !value).length;
      if (!gone) return;
      updatePendingUploads(current => [...current, ...attachmentsRef.current.filter(item => verdict.get(item.id) === null).map(item => ({ key: `missing:${item.id}`, name: item.name, size: item.size, image: item.mimeType.startsWith('image/'), attachmentId: item.id, error: t`请重新选择文件` }))]);
      updateAttachments(items => items.filter(item => verdict.get(item.id) !== null));
    });
  }, [storageKey]);

  const referenceScope = useRef(referenceProjectId);
  useLayoutEffect(() => {
    if (referenceScope.current !== referenceProjectId) {
      referenceScope.current = referenceProjectId;
      if (referencesRef.current.some(item => !isSessionReference(item))) updateReferences(referencesRef.current.filter(isSessionReference));
      return;
    }
    if (referencesRef.current === references) return;
    referencesRef.current = references;
    referencesRevisionRef.current += 1;
  }, [referenceProjectId, references]);

  /*
   * The draft is mirrored to sessionStorage on a short debounce rather than per keystroke: a
   * synchronous storage write on every key is measurable on a long draft. Whatever is still pending
   * is written when the key changes, on unmount, and when the page is hidden, so nothing typed is
   * lost to a session switch, a reload or a backgrounded tab. A failed write leaves a local warning
   * until storage accepts the draft again, without repeating a toast on every pause in typing.
   */
  const pendingDraftRef = useRef<{ key: string; draft: StoredDraft } | null>(null);
  const draftTimerRef = useRef<number | undefined>(undefined);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const saveDraft = useRef((key: string, draft: StoredDraft) => {
    const wasUnsaved = unsavedDrafts.has(key);
    const saved = writeDraft(key, draft);
    if (saved) unsavedDrafts.delete(key);
    else unsavedDrafts.add(key);
    if (wasUnsaved !== !saved) refreshDraftPersistence((revision) => revision + 1);
  }).current;
  const flushDraft = useRef(() => {
    window.clearTimeout(draftTimerRef.current);
    const pending = pendingDraftRef.current;
    pendingDraftRef.current = null;
    if (pending) saveDraft(pending.key, pending.draft);
  }).current;
  /** The draft as it stands, read from the refs the updaters keep current ahead of the next render. */
  const currentDraft = (): StoredDraft => ({
    text: joinQuotes(quotesRef.current, textRef.current), attachments: attachmentsRef.current, references: persistReferences ? referencesRef.current : [], projectId: referenceScope.current,
    ...(pendingUploadsRef.current.length ? { pendingUploads: pendingUploadsRef.current } : {}),
    keys: Object.fromEntries(attachmentsRef.current.flatMap((item) => { const key = attachmentKeysRef.current.get(item.id); return key ? [[item.id, key]] : []; })),
  });
  useEffect(() => {
    if (!storageKey) return;
    pendingDraftRef.current = { key: storageKey, draft: currentDraft() };
    window.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = window.setTimeout(flushDraft, 400);
  }, [storageKey, text, quotes, attachments, references, pendingUploads, referenceProjectId, flushDraft]);
  // Cleanups run before the next commit's effects, so the old key is written before the reset reads the new one.
  useEffect(() => flushDraft, [storageKey, flushDraft]);
  useEffect(() => {
    const onHidden = () => { if (document.visibilityState === 'hidden') flushDraft(); };
    window.addEventListener('pagehide', flushDraft);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flushDraft);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [flushDraft]);

  const restoreDraft = props.restoreDraft;
  useEffect(() => {
    if (!restoreDraft) return;
    const current = textRef.current;
    const restored = splitQuotes(restoreDraft.text);
    updateText(current.trim() ? `${restored.body}\n${current}` : restored.body);
    if (restored.quotes.length) updateQuotes([...restored.quotes, ...quotesRef.current]);
    updateAttachments((existing) => [...restoreDraft.attachments.filter((item) => !existing.some((other) => other.id === item.id)), ...existing]);
    if (restoreDraft.context) updateReferences(mergeRestoredReferences(referencesRef.current, restoreDraft.context));
    if (restoreDraft.missingAttachments) updatePendingUploads(current => [...current, ...restoreDraft.missingAttachments!.filter(item => !current.some(other => other.key === item.key))]);
    if (storageKey) {
      saveDraft(storageKey, currentDraft());
      if (!unsavedDrafts.has(storageKey)) restoreDraft.onPersisted?.();
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [restoreDraft]);

  const quote = props.quote;
  useEffect(() => {
    if (!quote) return;
    updateQuotes([...quotesRef.current, quote.text]);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [quote]);

  useEffect(() => {
    props.onDraftChange?.(Boolean(text.trim() || quotes.length || attachments.length));
  }, [attachments.length, props.onDraftChange, quotes.length, text]);

  const heldFeedback = useHeld(props.feedback);
  const minimumHeight = variant === 'hero' ? 76 : compact ? 44 : 52;
  const maximumHeight = props.embedded ? 120 : variant === 'hero' ? 320 : 240;
  const composerPlaceholder = props.placeholder ?? t`输入消息…`;
  useComposerAutosize({
    textareaRef,
    text,
    placeholder: composerPlaceholder,
    minimum: minimumHeight,
    maximum: Math.min(maximumHeight, Math.max(minimumHeight, isMobile && viewportHeight ? Math.floor(viewportHeight * 0.32) : maximumHeight)),
    enabled: !fullscreen,
  });

  useEffect(() => () => { window.clearTimeout(blurTimerRef.current); window.clearTimeout(mentionBlurTimerRef.current); }, []);

  useEffect(() => {
    if (storageKey !== 'riffet.draft.new:home') return;
    const acknowledge = (event: Event) => {
      const detail = (event as CustomEvent<{ body: NativeSessionCreateInput; handled: boolean; saved: boolean }>).detail;
      if (detail.handled) return;
      detail.handled = true;
      const remaining = creationDraftRemainder(currentDraft(), detail.body);
      if (remaining.text !== textRef.current) updateText(remaining.text);
      updateAttachments(remaining.attachments);
      if (remaining.references !== referencesRef.current) updateReferences(remaining.references);
      pendingDraftRef.current = null;
      window.clearTimeout(draftTimerRef.current);
      detail.saved = writeDraft(storageKey, currentDraft());
    };
    window.addEventListener(recoveredCreationEvent, acknowledge);
    return () => window.removeEventListener(recoveredCreationEvent, acknowledge);
  }, [storageKey]);

  /**
   * A wheel the draft cannot spend belongs to the transcript.
   *
   * The draft's scroll port is the only scrolling box in the composer, so once it is at an edge the
   * gesture would otherwise die there and the reader would have to move the pointer off the card to
   * keep reading (DeepSeek Harness learned the same thing — `docs/COMPOSER.md` §4.0).
   */
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0) return;
      if (!shouldForwardWheel({ scrollTop: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, deltaY: event.deltaY })) return;
      if (transcriptWheelRef.current?.(event.deltaY, event.deltaMode)) event.preventDefault();
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);
  const onCardFocus = () => {
    window.clearTimeout(blurTimerRef.current);
    setFocused(true);
  };
  // Collapse only once focus has settled outside the card: on iOS a tapped button does not take
  // focus, so collapsing on the textarea's blur would move the button before its click lands.
  const onCardBlur = () => {
    window.clearTimeout(blurTimerRef.current);
    blurTimerRef.current = window.setTimeout(() => {
      const active = document.activeElement;
      if (!active || !cardRef.current?.contains(active)) setFocused(false);
    }, 150);
  };
  /**
   * A press on the composer's own chrome — the dock above it included — must not move focus to
   * `<body>`, which on a phone dismisses the keyboard mid-sentence. The card's inert surface is the
   * only thing swallowed, and only while a field here holds focus: a control keeps its own press
   * (the default is what fires it and places a caret), and an unfocused card is left alone so its
   * text stays drag-selectable. `pointerdown` covers touch, `mousedown` the mouse, where cancelling
   * the pointer event does not reliably suppress the focus default.
   */
  const holdComposerFocus = (event: ReactPointerEvent<HTMLDivElement> | ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const root = event.currentTarget;
    const active = root.ownerDocument.activeElement;
    const composerFocused = Boolean(active && active !== root && root.contains(active) && isTextField(active));
    if (keepsComposerFocus({ target: pressTarget(event.target as Element | null), composerFocused })) event.preventDefault();
  };

  useEffect(() => {
    const wasMobile = wasMobileRef.current;
    wasMobileRef.current = isMobile;
    if (props.autoFocus && !isMobile && !wasMobile) textareaRef.current?.focus();
  }, [props.autoFocus, storageKey, isMobile]);

  useEffect(() => { if (!isMobile) setMobileSettingsOpen(false); }, [isMobile]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      setViewportHeight(Math.round(viewport?.height ?? window.innerHeight));
    };
    resize();
    viewport?.addEventListener('resize', resize);
    window.addEventListener('resize', resize);
    return () => {
      viewport?.removeEventListener('resize', resize);
      window.removeEventListener('resize', resize);
    };
  }, []);

  /**
   * Leaving fullscreen must not strand the focus that was in the draft.
   *
   * The card stays the same node and the textarea usually keeps focus by itself, but a click on the
   * scrim moves focus to `<body>` — so if focus is no longer inside the card, it goes to the toggle
   * that opened the mode, which is where a keyboard user will look for it.
   */
  useEffect(() => {
    if (fullscreen) return;
    const active = document.activeElement;
    if (!active || active === document.body) fullscreenToggleRef.current?.focus({ preventScroll: true });
  }, [fullscreen]);

  /**
   * Entering fullscreen puts the caret back in the draft, without stealing it from a control the
   * user just pressed.
   *
   * The card is the same node in both modes, so the usual case is that focus never left — this only
   * covers the paths that move it (a scrim click, the toggle itself on a touch device, a click on
   * the panel's chrome).
   */
  useEffect(() => {
    if (!fullscreen) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && cardRef.current?.contains(active) && isTextField(active)) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [fullscreen]);

  /** Commands while the token opens the message; mid-message only skills, and only where the backend loads them there. */
  const slashGroups = useMemo(() => {
    if (trigger?.type !== 'slash') return [];
    return slashMenuGroups(slashCandidates(commands, trigger.leading === true, props.inlineSkills === true), trigger.query);
  }, [trigger, commands, props.inlineSkills]);
  const slashItems = useMemo(() => slashGroups.flatMap((group) => group.items), [slashGroups]);
  const commandsByName = useMemo(() => new Map(commands.map((item) => [item.name, item])), [commands]);
  const invokedItems = useMemo(() => invokedSlashItems(text, commandsByName, props.inlineSkills === true), [text, commandsByName, props.inlineSkills]);

  const slashQuery = trigger?.type === 'slash' ? trigger.query.trim() : '';
  /**
   * The menu lists the commands the caller advertises. Commands it does not list
   * (the CLI's TUI-only ones, e.g. /summarize) are still sendable as ordinary prompt text,
   * so offer that explicitly instead of silently showing an empty menu. Only for the leading
   * token: mid-message a slash is just as likely a path.
   */
  const unknownSlashCommand = trigger?.type === 'slash' && trigger.leading === true && Boolean(slashQuery) && !slashItems.some((command) => command.name === slashQuery);
  const slashMenuOpen = trigger?.type === 'slash';
  const onSlashMenuOpen = props.onSlashMenuOpen;
  useEffect(() => { if (slashMenuOpen) onSlashMenuOpen?.(); }, [slashMenuOpen, onSlashMenuOpen]);

  const mentionQuery = trigger?.type === 'mention' ? trigger.query : undefined;
  if (browse && (trigger?.type !== 'mention' || trigger.start !== browse.start)) setBrowse(null);
  const browsing = sessionMentions && trigger?.type === 'mention' && browse?.start === trigger.start ? browse.projectId : undefined;
  const browsingName = browsing ? props.referenceProjects?.find(item => item.id === browsing)?.name ?? '' : '';
  const searchable = fileMentions && Boolean(mentionQuery) && !browsing;
  const foundHere = found?.project === projectId ? found : undefined;
  // The previous query's results stay up while the next loads; "no match" only speaks for a settled query.
  const files = searchable && foundHere ? foundHere.entries : NO_FILES;
  const searching = searchable && foundHere?.query !== mentionQuery;
  const showSearching = useLingering(searching, WAIT_GRACE_MS);
  useEffect(() => {
    if (!searchable || !mentionQuery) return;
    let active = true;
    const settle = (entries: FileEntry[]) => { if (active) setFound({ project: projectId, query: mentionQuery, entries }); };
    const timer = window.setTimeout(() => {
      api.find(projectId, mentionQuery)
        .then((result) => {
          const entries = Array.isArray(result) ? result : result.entries ?? [];
          settle(entries.filter((entry) => entry.kind === 'file').slice(0, 10));
        })
        .catch(() => settle([]));
    }, 140);
    return () => { active = false; window.clearTimeout(timer); };
  }, [projectId, mentionQuery, searchable]);

  const referenceCandidates = useMemo(() => (props.referenceSessions ?? []).filter(item => item.id !== props.recipientSessionId), [props.referenceSessions, props.recipientSessionId]);
  const sessionFiles = useMemo(() => {
    if (!sessionMentions || mentionQuery === undefined) return [];
    const query = mentionQuery.toLocaleLowerCase();
    const projects = new Map(props.referenceProjects?.map(item => [item.id, item.name]));
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
  }, [sessionMentions, mentionQuery, browsing, referenceCandidates, props.referenceProjects, projectId]);
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
    return (props.referenceProjects ?? []).filter(item => !item.system && latest.has(item.id) && (!query || item.name.toLocaleLowerCase().includes(query)))
      .sort((a, b) => Number(b.id === projectId) - Number(a.id === projectId) || latest.get(b.id)!.localeCompare(latest.get(a.id)!)).slice(0, query ? 5 : 50);
  }, [sessionMentions, mentionQuery, browsing, referenceCandidates, props.referenceProjects, projectId]);
  const menuLength = trigger?.type === 'slash' ? slashItems.length + (unknownSlashCommand ? 1 : 0) : files.length + sessionFiles.length + projectRows.length;
  const highlightScope = `${trigger?.type}|${trigger?.query}|${browsing}|${files.length}|${sessionFiles.length}|${projectRows.length}`;
  const [highlightedScope, setHighlightedScope] = useState(highlightScope);
  if (highlightedScope !== highlightScope) { setHighlightedScope(highlightScope); setHighlight(0); }
  const menuListRef = useRef<HTMLDivElement>(null);
  // The textarea stays focused while the menu is open, so the active row is announced through
  // `aria-activedescendant` (the CommandPalette pattern) rather than by moving focus.
  const menuId = useId();
  const optionId = (index: number) => `${menuId}-option-${index}`;
  useEffect(() => {
    menuListRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const syncTrigger = (value: string, caret: number) => {
    const dismissed = dismissedTriggerRef.current;
    if (dismissed?.text === value && dismissed.caret === caret) return;
    dismissedTriggerRef.current = null;
    setTrigger(detectTrigger(value, caret, fileMentions || sessionMentions));
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
      else if (unknownSlashCommand) { setTrigger(null); void submit(); }
    } else {
      const file = files[index];
      const selected = sessionFiles[index - files.length]?.session;
      const project = projectRows[index - files.length - sessionFiles.length];
      if (project) { browseInto(project.id); return; }
      if (file) {
        const reference = { path: file.path };
        if (!referencesRef.current.some(item => sameContextReference(item, reference))) updateReferences([...referencesRef.current, reference]);
      } else if (selected) {
        const reference = { kind: 'session' as const, sessionId: selected.id, title: selected.title, backendId: sessionBackend(selected) };
        if (!referencesRef.current.some(item => sameContextReference(item, reference))) {
          if (referencesRef.current.filter(isSessionReference).length >= 5) { onError(t`最多引用 5 个会话`); return; }
          updateReferences([...referencesRef.current, reference]);
        }
      } else return;
      replaceRange(trigger.start, caret, '');
    }
  };

  /**
   * The one intake path for every source: the picker, a paste, the card's drop and the window's.
   *
   * The decisions — refuse the batch, drop duplicates, or upload these files — belong to
   * `planIntake`, which is pure and tested; this function holds the side effects: reading, uploading
   * and appending to the draft. A refused batch is refused whole, before a single byte is read, so
   * the user learns now instead of after 19 files have uploaded and the server rejects the message.
   */
  const ingestFiles = async (list: FileList | File[] | null, replaceKey?: string) => {
    if (disabled || props.attachmentsAllowed === false) return;
    const items = list ? Array.from(list) : [];
    if (!items.length) return;
    const candidates: CandidateFile[] = items.map((file) => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified }));
    const pending = pendingAttachmentKeysRef.current;
    const generation = draftGenerationRef.current;
    const plan = planIntake(candidates, attachmentsRef.current.length + pendingUploadsRef.current.filter(upload => upload.key !== replaceKey).length, new Set([...attachmentKeysRef.current.values(), ...pending]));
    if (plan.kind === 'rejected') { onError(plan.reason); return; }
    if (plan.kind === 'empty') return;
    if (replaceKey) { uploadFilesRef.current.delete(replaceKey); pending.delete(replaceKey); }
    // Reserve the whole batch before the first await, including its dedupe keys.
    for (const entry of plan.entries) pending.add(entry.key);
    updatePendingUploads(current => [...current.filter(upload => upload.key !== replaceKey), ...plan.entries.map(entry => {
      const file = items[entry.index]!;
      uploadFilesRef.current.set(entry.key, file);
      return { key: entry.key, name: file.name, size: file.size, image: attachmentMimeType(file).startsWith('image/') };
    })]);
    // Each file settles independently. A failed neighbour never discards an uploaded attachment.
    for (const entry of plan.entries) {
      if (generation !== draftGenerationRef.current) return;
      await uploadFile(entry.key, items[entry.index]!, generation);
    }
  };

  const uploadFile = async (key: string, original: File, generation = draftGenerationRef.current) => {
    if (activeUploadKeysRef.current.has(key)) return;
    activeUploadKeysRef.current.add(key);
    updatePendingUploads(current => current.map(item => item.key === key ? { ...item, error: undefined } : item));
    try {
      const mimeType = attachmentMimeType(original);
      const file = mimeType === original.type ? original : new File([original], original.name, { type: mimeType, lastModified: original.lastModified });
      const data = await readUploadData(file);
      const attachment = await api.upload(projectId, {
        name: uploadName(file, data.mimeType), mimeType: data.mimeType, dataBase64: data.dataBase64,
        ...(data.width && data.height ? { width: data.width, height: data.height } : {}),
      });
      if (generation !== draftGenerationRef.current) return;
      attachmentKeysRef.current.set(attachment.id, key);
      updateAttachments(current => [...current, attachment]);
      updatePendingUploads(current => current.filter(item => item.key !== key));
      uploadFilesRef.current.delete(key);
    } catch (error) {
      if (generation === draftGenerationRef.current) updatePendingUploads(current => current.map(item => item.key === key ? { ...item, error: errorMessage(error, t`上传失败`) } : item));
    } finally {
      if (generation === draftGenerationRef.current) { pendingAttachmentKeysRef.current.delete(key); activeUploadKeysRef.current.delete(key); }
    }
  };

  const retryUpload = async (key: string) => {
    const file = uploadFilesRef.current.get(key);
    if (file) { await uploadFile(key, file); return; }
    const upload = pendingUploadsRef.current.find(item => item.key === key);
    if (upload?.attachmentId) {
      const generation = draftGenerationRef.current;
      if (activeUploadKeysRef.current.has(key)) return;
      activeUploadKeysRef.current.add(key);
      try {
        const attachment = await api.attachmentMetadata(upload.attachmentId);
        if (generation !== draftGenerationRef.current || !pendingUploadsRef.current.some(item => item.key === key)) return;
        updateAttachments(current => current.some(item => item.id === attachment.id) ? current : [...current, attachment]);
        updatePendingUploads(current => current.filter(item => item.key !== key));
        return;
      } catch (error) {
        if (generation !== draftGenerationRef.current) return;
        if (!(error instanceof HttpError && error.status === 404)) {
          updatePendingUploads(current => current.map(item => item.key === key ? { ...item, error: errorMessage(error, t`无法读取附件`) } : item));
          return;
        }
      } finally { activeUploadKeysRef.current.delete(key); }
    }
    // Browser reloads retain metadata, but cannot promise access to the original local file.
    reselectUploadKeyRef.current = key;
    fileInputRef.current?.click();
  };

  const removeUpload = (key: string) => {
    uploadFilesRef.current.delete(key);
    pendingAttachmentKeysRef.current.delete(key);
    updatePendingUploads(current => current.filter(item => item.key !== key));
  };

  /**
   * After a chip or tile goes, its ✕ goes with it. The rail moves focus to a neighbour (§7.3); with
   * none, the caret returns to the draft rather than `<body>`. Not on a phone, where focusing the
   * draft would raise a keyboard the tap did not ask for.
   */
  const refocusDraft = () => requestAnimationFrame(() => {
    const active = document.activeElement;
    if ((!active || active === document.body) && !window.matchMedia(MOBILE_LAYOUT_QUERY).matches) textareaRef.current?.focus({ preventScroll: true });
  });

  /** Drop one draft attachment, and the key that identified it, together. */
  const removeAttachment = (id: string) => {
    attachmentKeysRef.current.delete(id);
    updateAttachments((current) => current.filter((item) => item.id !== id));
    refocusDraft();
  };
  const removeReference = (index: number) => {
    updateReferences(referencesRef.current.filter((_, itemIndex) => itemIndex !== index));
    refocusDraft();
  };
  const removeQuote = (index: number) => {
    updateQuotes(quotesRef.current.filter((_, itemIndex) => itemIndex !== index));
    refocusDraft();
  };

  /*
   * The rail is memoized, so it gets callbacks that never change and forward to this render's
   * handlers — the ones above close over the host's latest props.
   */
  const railHandlersRef = useRef({ removeAttachment, removeReference, removeQuote, ingestFiles });
  railHandlersRef.current = { removeAttachment, removeReference, removeQuote, ingestFiles };
  const [railHandlers] = useState(() => ({
    onRemoveAttachment: (id: string) => railHandlersRef.current.removeAttachment(id),
    onRemoveReference: (index: number) => railHandlersRef.current.removeReference(index),
    onRemoveQuote: (index: number) => railHandlersRef.current.removeQuote(index),
    onDropFiles: (dropped: File[]) => { void railHandlersRef.current.ingestFiles(dropped); },
    onError: (message: string) => onErrorRef.current(message),
  }));

  /*
   * The window is a drop target, not just the card.
   *
   * Two things have to be true at once: the browser must not navigate to the dropped file (its own
   * default for a drop anywhere on the page), and the drop that lands on the transcript — where the
   * user is actually looking — must reach this composer. `cardRef.contains(target)` is what keeps
   * the card's own handler authoritative: it already cancelled the event, and ingesting here too
   * would upload every file twice or race itself.
   *
   * The depth counter is shared by every mounted composer so one `dragenter` on a child does not
   * read as "left the window"; it is reset on drop and on dragend, because a drag can end outside
   * the window without ever firing the matching `dragleave`.
   */
  useEffect(() => {
    if (disabled || props.windowDrop === false || props.attachmentsAllowed === false) return;
    const draggingFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onDragEnter = (event: DragEvent) => {
      if (!draggingFiles(event)) return;
      windowDragDepth += 1;
      setWindowDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      // Without this the browser refuses the drop and opens the file instead.
      if (draggingFiles(event)) event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!draggingFiles(event)) return;
      windowDragDepth = Math.max(0, windowDragDepth - 1);
      if (!windowDragDepth) setWindowDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      windowDragDepth = 0;
      setWindowDragging(false);
      const target = event.target instanceof Node ? event.target : null;
      if (target instanceof Element && target.closest('[data-composer-drop="none"]')) { event.preventDefault(); return; }
      if (target && cardRef.current?.contains(target)) return;
      const dropped = Array.from(event.dataTransfer?.files ?? []);
      if (!dropped.length || event.defaultPrevented) return;
      event.preventDefault();
      void ingestFiles(dropped);
    };
    const onDragEnd = () => {
      windowDragDepth = 0;
      setWindowDragging(false);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', onDragEnd);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', onDragEnd);
      windowDragDepth = 0;
    };
  }, [disabled, projectId, storageKey, props.windowDrop, props.attachmentsAllowed]);

  const canSubmit = Boolean(text.trim()) && !disabled && !props.submitDisabled && !submitting && !uploading;
  const submit = async (later?: Date) => {
    const body = textRef.current;
    const prompt = joinQuotes(quotesRef.current, body);
    if (!body.trim() || disabled || props.submitDisabled || submittingRef.current || pendingUploadsRef.current.length > 0) return;
    if (later && !props.onSendLater) return;
    const submittedTextRevision = textRevisionRef.current;
    const submittedAttachments = [...attachmentsRef.current];
    const submittedReferences = referencesEnabled ? [...referencesRef.current] : [];
    if (submittedReferences.some(isSessionReference) && !sessionMentions) { onError(t`当前 Agent 无法读取会话引用`); return; }
    const submittedReferencesRevision = referencesRevisionRef.current;
    let stored = false;
    let draftSaved = true;
    // A durable Outbox takes ownership before POST. HTTP latency must not keep a second sendable copy.
    const onStored = () => {
      if (stored) return draftSaved;
      stored = true;
      if (textRevisionRef.current === submittedTextRevision) {
        updateText('');
        if (quotesRef.current.length) updateQuotes([]);
        setTrigger(null);
      }
      if (submittedAttachments.length) {
        const submittedIds = new Set(submittedAttachments.map((attachment) => attachment.id));
        updateAttachments((current) => current.filter((attachment) => !submittedIds.has(attachment.id)));
      }
      // Once this composer is gone the host's list belongs to whichever one replaced it (a
      // conversation opened while the send was on its way); only this draft's copy is cleared.
      if (referencesEnabled && referencesRevisionRef.current === submittedReferencesRevision) {
        if (mountedRef.current) updateReferences([]); else referencesRef.current = [];
      }
      // Store what is left here rather than leaving it to the debounced effect: a submit that
      // navigates away unmounts this composer first, its unmount flush already wrote the sent
      // draft, and that draft would come back under the same key.
      if (storageKey) {
        pendingDraftRef.current = null;
        window.clearTimeout(draftTimerRef.current);
        if (!mountedRef.current && props.onSubmitPersisted) {
          // Another home composer may now own this key. It acknowledges against the accepted
          // request and synchronizes its own fresh input before the old receipt is removed.
          props.onSubmitPersisted(true);
        } else {
          saveDraft(storageKey, currentDraft());
          if (!unsavedDrafts.has(storageKey)) props.onSubmitPersisted?.();
        }
      }
      // Tapping Send on a phone dismisses the keyboard; give the transcript its space back.
      const ownerDocument = textareaRef.current?.ownerDocument;
      if (isMobile && ownerDocument && ownerDocument.activeElement !== textareaRef.current) {
        (ownerDocument.activeElement as HTMLElement | null)?.blur();
        window.clearTimeout(blurTimerRef.current);
        setFocused(false);
      }
      draftSaved = !storageKey || !unsavedDrafts.has(storageKey);
      return draftSaved;
    };
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const ok = later
        ? await props.onSendLater!(prompt, submittedAttachments, submittedReferences, later)
        : await props.onSubmit(prompt, submittedAttachments, submittedReferences, onStored);
      // Hosts without an Outbox retain their existing acknowledgement-after-success behavior.
      if (ok && !stored) onStored();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const menuOpen = Boolean(trigger && (trigger.type === 'mention' || slashItems.length || unknownSlashCommand));
  const hero = variant === 'hero';
  const currentModel = props.models?.find((item) => item.id === props.model)?.label ?? props.model ?? t`默认模型`;
  const settingsSummary = (props.mobileSettingsLabel ?? ([
    props.toolbar ? (props.toolbarLabel ?? t`权限`) : undefined,
    props.startPickersLabel,
    props.onModelChange ? currentModel : props.endPickers ? t`模型` : undefined,
  ].filter(Boolean).join(' · '))) || t`发送设置`;
  // The sheet hides the model picker, so its trigger carries what the picker would say: a catalog
  // still loading, one that failed, or an empty one, which is also why sending can be held.
  const modelsIssue = props.modelsLoading ? '' : props.modelsError?.trim() || (props.onModelChange && props.models && !props.models.length ? t`没有可用模型` : '');
  const attachable = props.attachmentsAllowed !== false;
  const toolsInMenu = !isMobile && Boolean(props.toolsPicker);
  const hasMobileSettings = Boolean(props.toolbar || props.toolsPicker || props.onModelChange || props.startPickers || props.endPickers || props.usage);
  const showStop = Boolean(props.onStop && (props.stopping || (running || props.backgroundCount) && !text.trim()));
  const referenceCount = visibleReferences.length + quotes.length;
  const attachedSummary = [
    referenceCount ? t`${referenceCount} 个引用` : '',
    attachments.length ? t`${attachments.length} 个附件` : '',
    uploading ? t`上传中` : '',
  ].filter(Boolean).join(' · ');
  /*
   * A button that also picks the agent (a new session) opens the row: the agent is the first choice,
   * and its menu reads left to right from it (agent, provider, model). Inside a session the agent is
   * fixed, so the button only tunes the model and stays by the send button.
   */
  const modelLeadsRow = !isMobile && Boolean(props.modelLeading);
  const renderModelPicker = () => props.onModelChange ? (
    <ModelPicker align={isMobile || modelLeadsRow ? 'start' : 'end'} models={props.models ?? []} value={props.model} params={props.modelParams} onChange={props.onModelChange} onParamChange={props.onModelParamChange} disabled={disabled || props.pickersDisabled} loading={props.modelsLoading} error={props.modelsError} onRetry={props.onRetryModels} side={hero ? 'bottom' : 'top'} inlineParams={isMobile} loadUsage={props.loadModelUsage} refreshCatalog={props.refreshCatalog} usageScopeKey={props.usageScopeKey} providers={props.providers} activeProviderId={props.activeProviderId} onPreviewProvider={props.onPreviewModelProvider} leading={props.modelLeading} />
  ) : null;

  return (
    <div className={cn('relative', fullscreen && 'flex min-h-0 flex-1 flex-col')} onPointerDown={holdComposerFocus} onMouseDown={holdComposerFocus}>
      {/* Keep the menus, dock and editor in the same stable portal in both layouts. */}
      <ComposerFullscreen
        open={fullscreen}
        title={t`编辑消息`}
        label={t`编辑消息`}
        onExit={() => setFullscreen(false)}
      >
        {/*
          The card stops growing where the panel's chrome begins: the draft is the part that
          stretches, so fullscreen spends its extra height on the text and never pushes the toolbar
          or the attachment rail past the panel's edge.
        */}
        <div
          className={cn('relative', fullscreen && 'flex min-h-0 flex-1 flex-col')}
        >
          {menuOpen && trigger && (
            <div className={cn('inset-x-0 z-(--z-dock) overflow-hidden rounded-xl bg-popover shadow-pop animate-in fade-in-0 duration-[var(--duration-fast)] ease-[var(--ease-decelerate)]', fullscreen ? 'absolute bottom-14 mx-3 mb-2' : isMobile ? 'relative mb-2' : hero ? 'absolute top-full mt-2 slide-in-from-top-1' : 'absolute bottom-full mb-2 slide-in-from-bottom-1')}>
              <div className="flex h-8 items-center gap-1.5 edge-b px-3 text-xs text-fg-3">
                {trigger.type === 'slash'
                  ? <><IconSlash className="size-3" />{slashGroups.length > 1 ? t`命令与 Skills` : slashGroups[0]?.kind === 'skill' ? t`Skills` : t({ message: '命令', context: 'session-commands-label' })}</>
                  : browsing
                    ? <button type="button" tabIndex={-1} aria-label={t`返回`} onMouseDown={event => { event.preventDefault(); browseInto(undefined); }} className="-mx-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-hover hover:text-fg-2"><IconArrowLeft className="size-3 shrink-0" /><span className="truncate">{browsingName}</span></button>
                    : <><IconAtSign className="size-3" />{sessionMentions ? t`引用` : t`引用文件`}{showSearching && <Spinner className="ml-auto size-3" />}</>}
              </div>
              {/* File results arrive per keystroke in varying counts, so their list keeps one height
                  from the moment `@` opens it; the phone's menu is in the flow above the card. */}
              <div ref={menuListRef} id={menuId} className={cn('overflow-y-auto overscroll-contain p-1', trigger.type === 'mention' ? 'h-64 max-md:h-[min(144px,calc(var(--app-height,100dvh)*0.28))]' : 'max-h-64 max-md:max-h-[min(144px,calc(var(--app-height,100dvh)*0.28))]')} role="listbox" aria-label={trigger.type === 'slash' ? t({ message: '命令', context: 'session-commands-label' }) : sessionMentions ? t`引用` : t`引用文件`}>
                {trigger.type === 'slash' && slashGroups.map((group, groupIndex) => {
                  const offset = slashGroups.slice(0, groupIndex).reduce((total, previous) => total + previous.items.length, 0);
                  return (
                    <div key={group.kind} role="group" aria-label={group.kind === 'skill' ? t`Skills` : t({ message: '命令', context: 'session-commands-label' })}>
                      {slashGroups.length > 1 && <div className="px-2 pb-0.5 pt-1.5 text-2xs font-medium text-fg-4">{group.kind === 'skill' ? t`Skills` : t({ message: '命令', context: 'session-commands-label' })}</div>}
                      {group.items.map((command, itemIndex) => {
                        const index = offset + itemIndex;
                        return (
                          <button key={command.name} id={optionId(index)} type="button" tabIndex={-1} role="option" aria-selected={index === highlight} title={command.description} onPointerMove={() => setHighlight(index)} onMouseDown={(event) => { event.preventDefault(); choose(index); }} className={cn('flex min-h-11 w-full items-center gap-3 md:min-h-8 rounded-lg px-2 py-1.5 text-left text-sm', index === highlight && 'bg-hover')}>
                            <span className="max-w-[60%] shrink-0 truncate font-mono text-fg">/{command.name}</span>
                            <span className="min-w-0 truncate text-xs text-fg-3">{command.description ?? command.hint}</span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {trigger.type === 'slash' && unknownSlashCommand && (
                  <button id={optionId(slashItems.length)} type="button" tabIndex={-1} role="option" aria-selected={highlight === slashItems.length} onPointerMove={() => setHighlight(slashItems.length)} onMouseDown={(event) => { event.preventDefault(); choose(slashItems.length); }} className={cn('flex min-h-11 w-full items-center gap-3 md:min-h-8 rounded-lg px-2 py-1.5 text-left text-sm', highlight === slashItems.length && 'bg-hover')}>
                    <span className="shrink-0 font-mono text-fg">/{slashQuery}</span>
                    <span className="min-w-0 truncate text-xs text-fg-3">{props.unknownCommandHint ?? t`将作为普通消息原样发送`}</span>
                  </button>
                )}
                {trigger.type === 'mention' && files.length > 0 && sessionMentions && <div className="px-2 pb-0.5 pt-1.5 text-2xs font-medium text-fg-4"><Trans>文件</Trans></div>}
                {trigger.type === 'mention' && files.map((file, index) => (
                  <button key={file.path} id={optionId(index)} type="button" tabIndex={-1} role="option" aria-selected={index === highlight} onPointerMove={() => setHighlight(index)} onMouseDown={(event) => { event.preventDefault(); choose(index); }} className={cn('flex h-11 w-full items-center gap-2 md:h-8 rounded-lg px-2 text-left text-sm', index === highlight && 'bg-hover')}>
                    <IconFileText className="size-3.5 shrink-0 text-fg-3" />
                    <span className="max-w-[50%] shrink-0 truncate text-fg">{file.name}</span>
                    <span className="min-w-0 truncate font-mono text-2xs text-fg-3">{file.path}</span>
                  </button>
                ))}
                {trigger.type === 'mention' && sessionFiles.length > 0 && <div role="group" aria-label={t`会话`}>
                  <div className="px-2 pb-0.5 pt-1.5 text-2xs font-medium text-fg-4"><Trans>会话</Trans></div>
                  {sessionFiles.map(({ session: item, project }, itemIndex) => {
                    const index = files.length + itemIndex;
                    const selected = references.some(reference => isSessionReference(reference) && reference.sessionId === item.id);
                    const blocked = !selected && references.filter(isSessionReference).length >= 5;
                    return <button key={item.id} id={optionId(index)} type="button" tabIndex={-1} role="option" aria-selected={index === highlight} disabled={blocked} onPointerMove={() => setHighlight(index)} onMouseDown={event => { event.preventDefault(); choose(index); }} className={cn('flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm disabled:opacity-50 md:h-8', index === highlight && 'bg-hover')}>
                      <AgentLogo backend={sessionBackend(item)} size={14} className="shrink-0 text-fg-3" />
                      <span className="min-w-0 flex-1 truncate text-fg">{item.title}</span>
                      <span className="max-w-[45%] truncate text-2xs text-fg-3">{[browsing ? '' : project, backendLabel(sessionBackend(item)), item.archivedAt ? t`已归档` : '', props.referenceSessions?.some(other => other.id !== item.id && other.title === item.title) ? item.id.slice(0, 8) : ''].filter(Boolean).join(' · ')}</span>
                    </button>;
                  })}
                </div>}
                {trigger.type === 'mention' && projectRows.length > 0 && <div role="group" aria-label={t({ message: '项目', context: 'mention-projects' })}>
                  <div className="px-2 pb-0.5 pt-1.5 text-2xs font-medium text-fg-4">{t({ message: '项目', context: 'mention-projects' })}</div>
                  {projectRows.map((item, itemIndex) => {
                    const index = files.length + sessionFiles.length + itemIndex;
                    return <button key={item.id} id={optionId(index)} type="button" tabIndex={-1} role="option" aria-selected={index === highlight} title={item.cwd} onPointerMove={() => setHighlight(index)} onMouseDown={event => { event.preventDefault(); choose(index); }} className={cn('flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm md:h-8', index === highlight && 'bg-hover')}>
                      <IconFolder className="size-3.5 shrink-0 text-fg-3" />
                      <span className="min-w-0 flex-1 truncate text-fg">{item.name}</span>
                      <IconChevronRight className="size-3.5 shrink-0 text-fg-3" />
                    </button>;
                  })}
                </div>}
                {trigger.type === 'mention' && !files.length && !sessionFiles.length && !projectRows.length && trigger.query && <div className="px-2 py-3 text-sm text-fg-3">{searching ? t`搜索中…` : browsing ? t`没有匹配的会话` : sessionMentions ? t`没有匹配的会话或文件` : t`没有匹配的文件`}</div>}
              </div>
            </div>
          )}
        {/* Notices above the card come and go with the session's state; they grow in rather than
            pushing the card and the transcript's bottom edge in a single frame. */}
        <Collapse open={Boolean(props.feedback)} className={cn(fullscreen && 'max-h-[35%] min-h-0 shrink-0')}>
          <div ref={followContentHeight} className={cn(fullscreen && 'flex max-h-full flex-col')}>
            <div inert={!props.feedback} aria-hidden={!props.feedback || undefined} className={cn('flex flex-col gap-2 pb-2', fullscreen && 'min-h-0 overflow-y-auto overscroll-contain')}>
              {heldFeedback}
            </div>
          </div>
        </Collapse>
        {props.dock}

        <div
          ref={cardRef}
          onFocus={onCardFocus}
          onBlur={onCardBlur}
          className={cn(
            // `relative` keeps the card above the dock stack: a dock is a flex item, and a flex item's
            // box-shadow paints after a block-level box's background, so without this the dock's own
            // soft shadow lands *inside* the card as a dark band under the seam — worst on the phone's
            // bordered cards and in dark, where that shadow is black at 70%. Raised, only the card's
            // hairline and the dock's top half of the shadow survive: one stack, one shadow.
            'relative flex bg-elevated transition-[border-color,box-shadow] duration-[var(--duration-base)] ease-[var(--ease-standard)]',
            'max-md:rounded-3xl max-md:border max-md:border-line-strong max-md:shadow-soft max-md:focus-within:border-fg-4/55 max-md:focus-within:shadow-focus',
            'md:rounded-2xl md:shadow-composer md:focus-within:shadow-composer-focus',
            props.embedded && 'rounded-xl! border border-line bg-subtle shadow-none! focus-within:border-fg-4/55 focus-within:shadow-none!',
            compact ? 'flex-row items-center' : 'flex-col',
            fullscreen && 'min-h-0 flex-1 rounded-none! border-0! bg-transparent shadow-none!',
            props.dockAttached && 'rounded-t-none! border-t-0!',
            dragging && 'border-accent! ring-3 ring-accent/15',
            disabled && 'opacity-70',
          )}
          onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); if (!disabled) setDragging(true); } }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); setDragging(false); void ingestFiles(event.dataTransfer.files); } }}
        >
          {(visibleReferences.length > 0 || quotes.length > 0 || attachments.length > 0 || uploading) && <>
            {/*
              Desktop shows the rail outright; a phone keeps the one-line summary and its expand
              toggle it has always had, because the rail would push the textarea off a small screen.
              Both variants come from one component, so a draft can never look different on the two.
            */}
            {(!isMobile || attachmentsExpanded) && <ComposerAttachments
              variant="rail"
              attachments={attachments}
              references={visibleReferences}
              quotes={quotes}
              onOpenReferenceSession={props.onOpenReferenceSession ? openReferenceSession : undefined}
              pending={pendingUploads}
              onRetryUpload={retryUpload}
              onRemoveUpload={removeUpload}
              disabled={disabled}
              {...railHandlers}
            />}
            <button type="button" className="flex min-h-11 items-center gap-2 px-3 pt-2 text-left text-xs text-fg-3 md:hidden" aria-expanded={attachmentsExpanded} onClick={() => setAttachmentsExpanded((value) => !value)}>
              <IconPaperclip className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{attachedSummary}</span>
              <IconChevronDown className={cn('size-3.5 shrink-0 transition-transform', attachmentsExpanded && 'rotate-180')} />
            </button>

          </>}

          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            disabled={disabled}
            data-composer-input
            aria-label={t`输入消息`}
            aria-describedby={draftAtRisk ? draftWarningId : undefined}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            aria-activedescendant={menuOpen && highlight < menuLength ? optionId(highlight) : undefined}
            placeholder={composerPlaceholder}
            className={cn('w-full resize-none bg-transparent px-4 text-base leading-6 text-fg outline-none placeholder:text-fg-4', hero ? 'min-h-[76px] pt-4 pb-1' : compact ? 'min-h-[44px] min-w-0 flex-1 py-2.5' : 'min-h-[52px] pt-3.5 pb-1', fullscreen && 'min-h-0 flex-1 overflow-y-auto pt-3 pb-1')}
            onChange={(event) => { updateText(event.target.value); syncTrigger(event.target.value, event.target.selectionStart); }}
            onSelect={(event) => syncTrigger(event.currentTarget.value, event.currentTarget.selectionStart)}
            onFocus={() => window.clearTimeout(mentionBlurTimerRef.current)}
            onBlur={() => { window.clearTimeout(mentionBlurTimerRef.current); mentionBlurTimerRef.current = window.setTimeout(() => setTrigger(null), 120); }}
            onPaste={(event) => {
              const pasted = clipboardFiles(event.clipboardData);
              if (!pasted.length || disabled || props.attachmentsAllowed === false) return;
              // Native text insertion preserves the selection and undo history for mixed pastes.
              if (!event.clipboardData.getData('text/plain')) event.preventDefault();
              void ingestFiles(pasted);
            }}
            onKeyDown={(event) => {
              // Both composition signals once: the legacy one (229) is what some engines report
              // instead of `isComposing`, so checking only the standard flag ships a known IME bug.
              const composing = isComposingKey({ isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode });
              // The IME's Enter picks a candidate, and the menu keys below are ours: neither may be
              // adjudicated while a composition is open.
              if (composing) return;
              // Inside a project, ← or ⌫ on an empty query steps back out instead of leaving the `@`.
              if (browsing && !trigger?.query && (event.key === 'ArrowLeft' || event.key === 'Backspace') && event.currentTarget.selectionStart === event.currentTarget.selectionEnd) {
                event.preventDefault(); browseInto(undefined); return;
              }
              if (projectRows.length && event.key === 'ArrowRight' && highlight >= files.length + sessionFiles.length && highlight < menuLength) {
                event.preventDefault(); choose(highlight); return;
              }
              if (menuOpen && menuLength) {
                if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((value) => (value + 1) % menuLength); return; }
                if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((value) => (value - 1 + menuLength) % menuLength); return; }
                if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); choose(highlight); return; }
              }
              /*
               * Escape closes the innermost layer and nothing else (`resolveEscapeLayer`). The menu is
               * this composer's own; the fullscreen panel is not — `ComposerFullscreen` owns that key,
               * because it also has to stand aside for a picker portalled above the panel and for the
               * lightbox, which this handler cannot see.
               */
              if (event.key === 'Escape' && resolveEscapeLayer({ menuOpen, fullscreen: false }) === 'menu') {
                event.preventDefault();
                dismissedTriggerRef.current = { text: textRef.current, caret: event.currentTarget.selectionStart };
                setTrigger(null);
                return;
              }
              if (event.key !== 'Enter') return;
              /*
               * One policy for both the keyboard and the Send button (`resolveEnter`), so the button
               * can never do something the key it advertises would not.
               *
               * A phone keeps the behavior it has always had — a hardware Enter sends — because the
               * setting is described as applying to the desktop's physical keyboard, and a soft
               * keyboard's Return never reaches keydown at all. Anything else would make a paired
               * phone change behavior when the desktop user flips a switch.
               */
              const outcome = resolveEnter({
                kind: classifyEnterGesture({
                  key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
                  composing: false, repeat: event.repeat,
                }),
                composing: false,
                repeat: event.repeat,
                hasDraft: Boolean(textRef.current.trim()),
              }, isMobile ? 'send' : enterBehavior);
              if (outcome.preventDefault) event.preventDefault();
              if (outcome.action === 'send') void submit();
            }}
          />

          {/* What the draft will invoke, read back from the text itself: the token is the reference,
              so removing a chip removes the token, and editing the token out drops the chip. */}
          {!compact && invokedItems.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 px-3 pt-1" aria-label={t`将调用`}>
              {invokedItems.map((item) => (
                <span key={item.name} title={item.description} className="inline-flex min-h-11 max-w-full items-center gap-1 rounded-md bg-accent/10 pl-1.5 pr-0.5 text-xs text-accent md:min-h-6">
                  {item.kind === 'skill' ? <IconSparkles className="size-3 shrink-0" /> : <IconSlash className="size-3 shrink-0" />}
                  <span className="min-w-0 truncate font-mono">{item.name}</span>
                  <button type="button" aria-label={t`移除 /${item.name}`} disabled={disabled} onClick={() => { updateText(removeSlashToken(textRef.current, item.name)); refocusDraft(); }} className="grid size-11 shrink-0 place-items-center rounded text-accent/70 outline-none hover:bg-accent/15 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/35 md:size-5">
                    <IconX className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div id={draftWarningId}>
            <FeedbackNotice scope={storageKey ?? props.draftKey ?? draftWarningId} message={draftAtRisk && t`草稿无法保存到浏览器，刷新后会丢失`} recovered={!draftAtRisk}
              className="px-4 pt-1 pb-2" icon={null} noticeClassName={cn('bg-transparent! p-0! text-xs', draftAtRisk ? 'text-warning' : 'text-fg-3')} />
          </div>
          <div className={cn('flex items-center gap-1', compact ? cn('shrink-0 flex-nowrap py-0.5 pr-1', !running && !props.backgroundCount && 'hidden') : 'flex-wrap px-2 pb-2 pt-1 md:flex-nowrap')}>
            {/* Skills and tools live in the + menu on a pointer device rather than as a button of their
                own on the row; the phone's settings sheet keeps its own section for them. */}
            {(attachable || toolsInMenu) && <>{attachable && <input ref={fileInputRef} className="sr-only" type="file" multiple tabIndex={-1} disabled={disabled} onChange={(event) => { const replaceKey = reselectUploadKeyRef.current; reselectUploadKeyRef.current = undefined; void ingestFiles(event.target.files, replaceKey); event.target.value = ''; }} />}
            {sessionMentions || toolsInMenu ? <DropdownMenu>
              <DropdownMenuTrigger aria-label={attachable ? t`添加附件` : t`技能与工具`} disabled={disabled || (uploading && !toolsInMenu)} className={cn('grid size-11 shrink-0 place-items-center rounded-md text-fg-3 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:size-7', compact ? 'hidden' : toggleEntrance)}><IconPlus className="size-[18px]" /></DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start">
                {attachable && <DropdownMenuItem disabled={uploading} onSelect={() => fileInputRef.current?.click()}><IconPaperclip /><Trans>添加图片或文件</Trans></DropdownMenuItem>}
                {sessionMentions && (
                  <DropdownMenuItem onSelect={() => { const caret = textareaRef.current?.selectionStart ?? textRef.current.length; const prefix = caret > 0 && !/\s/.test(textRef.current[caret - 1]!) ? ' @' : '@'; updateText(textRef.current.slice(0, caret) + prefix + textRef.current.slice(caret)); setTrigger({ type: 'mention', query: '', start: caret + prefix.length - 1 }); requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(caret + prefix.length, caret + prefix.length); }); }}><IconAtSign /><Trans>引用会话</Trans></DropdownMenuItem>
                )}
                {toolsInMenu && <>
                  {(attachable || sessionMentions) && <DropdownMenuSeparator />}
                  <ToolsPickerInMenu.Provider value>{props.toolsPicker}</ToolsPickerInMenu.Provider>
                </>}
              </DropdownMenuContent>
            </DropdownMenu> : <Tip label={t`添加图片或文件`}>
              <button type="button" aria-label={t`添加附件`} disabled={disabled || uploading} onClick={() => fileInputRef.current?.click()} className={cn('grid size-11 shrink-0 place-items-center rounded-md text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:size-7', compact ? 'hidden' : toggleEntrance)}>
                <IconPlus className="size-[18px]" />
              </button>
            </Tip>}</>}
            {props.onSendLater && !compact && <SendLaterMenu disabled={!canSubmit} onPick={(at) => void submit(at)} />}
            <Dialog open={mobileSettingsOpen} onOpenChange={setMobileSettingsOpen}>
              {/* Shrinkable, or a backend that names a permission in a whole sentence pushes the
                  model and send controls off the row instead of truncating itself. */}
              <div className="hidden min-w-0 items-center gap-1 md:flex">
                {modelLeadsRow && props.onModelChange && <span className="inline-flex min-w-0">{renderModelPicker()}</span>}
                {!isMobile && props.toolbar}
                {!isMobile && fullscreenOffered && (text.trim() || fullscreen) && (
                  <Tip label={fullscreen ? t`退出全屏编辑` : t`全屏编辑`}>
                    <button
                      ref={fullscreenToggleRef}
                      type="button"
                      aria-label={fullscreen ? t`退出全屏编辑` : t`全屏编辑`}
                      aria-pressed={fullscreen}
                      disabled={disabled}
                      onClick={() => setFullscreen(!fullscreen)}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
                    >
                      {fullscreen ? <IconMinimize className="size-4" /> : <IconMaximize className="size-4" />}
                    </button>
                  </Tip>
                )}
              </div>
              {hasMobileSettings && <>
                {isMobile && props.usage && !compact && <ContextMeter usage={props.usage} />}
                <DialogTrigger asChild>
                  <button type="button" aria-label={t`发送设置`} aria-description={modelsIssue || undefined} aria-busy={props.modelsLoading || undefined} title={modelsIssue || undefined} disabled={disabled} className={cn('inline-flex h-11 min-w-0 max-w-none flex-1 items-center gap-1 rounded-full px-2 text-sm font-medium text-fg-2 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 md:hidden md:flex-initial', modelsIssue && 'text-danger', compact ? 'hidden' : toggleEntrance)}>
                    {props.mobileSettingsPrefix}
                    <span className="min-w-0 truncate">{settingsSummary}</span>
                    {modelsIssue && <StatusDot tone="warning" />}
                    {props.modelsLoading && <Spinner className="size-3 shrink-0 text-fg-4" />}
                  </button>
                </DialogTrigger>
                <DialogContent mobileSheet aria-describedby={undefined} className="max-h-[min(78dvh,560px)] w-full max-w-none rounded-b-none rounded-t-2xl p-0 md:hidden">
                  <DialogHeader className="shrink-0 px-4 pb-3 pt-4 pr-14">
                    <DialogTitle className="text-base"><Trans>发送设置</Trans></DialogTitle>
                  </DialogHeader>
                  {props.pickersDisabled && props.pickersBlockedReason && (
                    <p className="shrink-0 px-4 pb-3 -mt-1 text-xs text-warning">{props.pickersBlockedReason}</p>
                  )}
                  <div className="min-h-0 overflow-y-auto px-4 pb-6">
                    {isMobile && props.toolbar && <section className="flex flex-col gap-2 edge-t py-3">
                      <h4 className="text-xs font-medium text-fg-3"><Trans>权限</Trans></h4>
                      <div className="[&>button]:!h-11 [&>button]:!w-full [&>button]:!justify-between [&>button]:!rounded-xl [&>button]:!border [&>button]:!border-line-strong [&>button]:!px-3 [&>button]:!text-base">{props.toolbar}</div>
                    </section>}
                    {isMobile && props.toolsPicker && <section className="flex flex-col gap-2 edge-t py-3">
                      <h4 className="text-xs font-medium text-fg-3"><Trans>技能与工具</Trans></h4>
                      <div className="[&>button]:!h-11 [&>button]:!w-full [&>button]:!justify-between [&>button]:!rounded-xl [&>button]:!border [&>button]:!border-line-strong [&>button]:!px-3 [&>button]:!text-base">{props.toolsPicker}</div>
                    </section>}
                    {isMobile && props.startPickers && <section className="flex flex-col gap-2 edge-t py-3">
                      <h4 className="text-xs font-medium text-fg-3">Agent</h4>
                      <div className="min-w-0">{props.startPickers}</div>
                    </section>}
                    {isMobile && props.onModelChange && <section className="flex flex-col gap-2 edge-t py-3">
                      <h4 className="text-xs font-medium text-fg-3"><Trans>模型与参数</Trans></h4>
                      {renderModelPicker()}
                    </section>}
                    {isMobile && props.endPickers && <section className="flex flex-col gap-2 edge-t py-3">
                      <h4 className="text-xs font-medium text-fg-3"><Trans>模型与参数</Trans></h4>
                      <div className="min-w-0">{props.endPickers}</div>
                    </section>}
                  </div>
                </DialogContent>
              </>}
            </Dialog>

            {/*
              Each slot renders only when it has content. The wrappers used to be unconditional, and
              an empty one is still a flex item — so two absent pickers between the context meter and
              the model added 12px of nothing to the row's own 6px gap, which is why the meter looked
              stranded from the model while the send button sat right against it.
            */}
            <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1 md:flex-nowrap">
              {!isMobile && props.usage && <span className="hidden md:inline-flex"><ContextMeter usage={props.usage} /></span>}
              {!isMobile && props.startPickers && <span className="hidden min-w-0 md:inline-flex">{props.startPickers}</span>}
              {!isMobile && !modelLeadsRow && props.onModelChange && <span className="hidden min-w-0 md:inline-flex">{renderModelPicker()}</span>}
              {!isMobile && props.endPickers && <span className="hidden min-w-0 md:inline-flex">{props.endPickers}</span>}
              {(!compact || showStop) && (
                <Tip
                  label={showStop ? props.stopping ? t`正在停止` : running ? t`停止` : t`停止后台任务` : props.submitIntent === 'steer' ? t`补充到当前任务` : running ? t`加入队列` : t`发送`}
                  kbd={showStop ? undefined : primaryEnterHint(enterBehavior)}
                >
                  <button
                    type="button"
                    aria-label={showStop ? props.stopping ? t`正在停止` : running ? t`停止` : t`停止后台任务` : props.submitIntent === 'steer' ? t`补充到当前任务` : running ? t`排队发送` : t`发送`}
                    aria-busy={showStop && props.stopping || undefined}
                    disabled={showStop ? props.stopping || props.stopDisabled || submitting : !canSubmit}
                    onClick={showStop ? props.onStop : () => void submit()}
                    className={cn(
                      // The phone's circle is 36 like iOS; the tap area reaches 44 around it.
                      'relative grid size-9 shrink-0 place-items-center rounded-full transition-[background-color,color,transform] duration-[var(--duration-base)] ease-[var(--ease-standard)] before:absolute before:-inset-1 active:scale-90 disabled:active:scale-100 md:size-8 md:before:hidden',
                      showStop ? 'bg-primary text-primary-fg hover:bg-primary-hover disabled:opacity-50' : 'bg-primary text-primary-fg hover:bg-primary-hover disabled:bg-fg/[0.08] disabled:text-fg-4',
                    )}
                  >
                    {showStop ? props.stopping ? <Spinner className="size-4 text-current" /> : <IconSquare className="size-3 fill-current" /> : submitting ? <Spinner className="size-4 text-current" /> : <IconArrowUp className="size-4" strokeWidth={2.4} />}
                  </button>
                </Tip>
              )}
            </div>
          </div>
        </div>
        </div>
      </ComposerFullscreen>

      {/*
        A file is being dragged somewhere over the page. No dashed border and no backdrop: the point
        is to say where the file will land, not to dim the work behind it, and a translucent scrim
        over a transcript the user is reading mid-sentence costs more than the hint is worth.
      */}
      {windowDragging && !dragging && (
        <div className="pointer-events-none fixed inset-0 z-(--z-drop) p-3">
          <div className="flex h-full items-center justify-center rounded-2xl ring-2 ring-inset ring-accent/40">
            <span className="inline-flex items-center gap-2 rounded-full bg-elevated px-3 py-1.5 text-sm text-fg-2 shadow-soft">
              <IconPaperclip className="size-4 text-fg-3" />
              <Trans>添加为附件</Trans>
            </span>
          </div>
        </div>
      )}


    </div>
  );
});
