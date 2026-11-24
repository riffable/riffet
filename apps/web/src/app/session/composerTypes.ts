import type { ReactNode } from 'react';
import type { Attachment, NativeBackendUsage, Session } from '@contracts';
import type { ProjectRecord, PromptContextReference } from '@/lib/api';
import type { ModelParam } from '@/lib/models';
import type { AgentMentionSource } from './agentMentions';
import type { PendingUpload } from './composerAttachmentIntake';
import type { Choice, ContextUsage, SlashCommand } from './model';
import type { ModelProviderChoices } from './ModelPicker';

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
  /** An available agent or provider was clicked to switch directly (see `ModelPicker`). */
  onSelectModelProvider?: (id: string) => void;
  onModelPickerOpenChange?: (open: boolean) => void;
  /** Before the model's name on its trigger, e.g. the agent's mark when the menu also picks the agent. */
  modelLeading?: ReactNode;
  /** Quiet banner at the top of the model menu when agents and models come from a linked server. */
  modelSourceLabel?: string;
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
  /** Triggers manual context compaction via the backend's native command; omit when unsupported. */
  onCompact?: () => Promise<boolean> | boolean;
  compacting?: boolean;
  compactDisabled?: boolean;
  /** The `/` menu: built-in commands and discovered skills. */
  commands?: SlashCommand[];
  /** The backend loads a skill named mid-message, so `/` opens the skill list anywhere in the draft. */
  inlineSkills?: boolean;
  /** Whether `@` opens the file picker; a project-less chat has no files to offer. */
  fileMentions?: boolean;
  sessionMentions?: boolean;
  /** Agents `@` offers to mention, and their model menus: the conversation's Agent may then call them (docs/AGENT-CALLS.md). */
  agentMentions?: AgentMentionSource;
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
  restoreDraft?: { text: string; attachments: Attachment[]; context?: PromptContextReference[]; missingAttachments?: PendingUpload[]; scheduledAt?: Date; onPersisted?: () => void; nonce: number };
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
