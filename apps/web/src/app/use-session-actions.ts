import { useCallback, useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { Attachment, AttemptGroup, MarkLocation, NativeBackendId, Session, TerminalInfo, ToolGroupId } from '@contracts';
import { api, HttpError, messageContext, restoreNewSessionContext, listNativeCreateRequests, removeNativeCreateRequest, saveNativeCreateRequest, type MessageSearchHit, type NativeSessionCreateInput, type NativeSessionCreateResult, type ProjectRecord, type PromptContextReference, type Bootstrap } from '@/lib/api';
import { isShellTerminal } from '@/lib/backends';
import { promptDialog } from '@/lib/dialogs';
import { LEGACY_DEFAULT_BACKEND_ID } from '@/lib/legacy-identity';
import { toast } from '@/lib/toast';
import { errorMessage, isRecord, newId } from '@/lib/utils';
import { sortSessionsByActivity } from '@/lib/session-order';
import { acknowledgeRecoveredCreationDraft, type ComposerProps } from './session/Composer';
import { requestSessionDeletion } from './SessionDeletion';
import type { SessionAction } from './Sidebar';
import { isAssistantProject } from '@/lib/project-family';
import { NO_PAGE } from './state/navStore';
import { useStores } from './state/stores';
import type { UiState, UiStore } from './state/uiStore';

function nativeCreatePayloadKey(input: NativeSessionCreateInput): string {
  const { commandId: _commandId, ...initialMessage } = input.initialMessage;
  return JSON.stringify({ projectId: input.projectId, projectless: input.projectless === true, backendId: input.backendId ?? LEGACY_DEFAULT_BACKEND_ID, backendProfileId: input.backendProfileId ?? 'default', title: input.title, model: input.model, mode: input.mode, approval: input.approval, toolGroups: input.toolGroups, extensionsOff: input.extensionsOff, initialMessage });
}

function creationWasRejected(error: unknown, body: NativeSessionCreateInput): boolean {
  return error instanceof HttpError && error.status >= 400 && error.status < 500
    && ((isRecord(error.details) && error.details.accepted === false)
      || (!body.projectless && error.status !== 409));
}

export const parseTags = (value: string) => [...new Set(value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];

/**
 * Leaving a conversation or project drops the composer's file references and the file preview. An
 * already empty list is left alone: a fresh `[]` would re-render everything that reads it.
 */
export function clearContext(ui: UiStore): void {
  ui.set((current) => ({ ...(current.references.length ? { references: [] } : {}), previewTarget: undefined }));
}

/**
 * Selecting, opening, creating and editing conversations, plus the native-session upkeep that
 * follows creation: replaying unconfirmed create requests, adopting the PTY, and keeping the
 * first-run seed available until the session view no longer needs it.
 */
export function useSessionActions({ loaded, project, session, sessions, terminals, homeBackendId, homeProfileId, loadBootstrap }: {
  loaded: boolean;
  project: ProjectRecord | undefined;
  session: Session | undefined;
  sessions: Session[];
  terminals: TerminalInfo[];
  nativeRunSeed: UiState['nativeRunSeed'];
  homeBackendId: NativeBackendId;
  homeProfileId: string | undefined;
  loadBootstrap: () => Promise<Bootstrap>;
}) {
  const { t } = useLingui();
  const { lists, nav, ui, handlers, settings: settingsStore, workItems } = useStores();
  const upsertSession = lists.upsertSession;
  const upsertTerminal = lists.upsertTerminal;
  const acceptedCreation = useRef<NativeSessionCreateInput | undefined>(undefined);
  const pendingCreation = useRef<NativeSessionCreateInput | undefined>(undefined);
  const [creationRestore, setCreationRestore] = useState<{ projectId?: string; draft: NonNullable<ComposerProps['restoreDraft']> }>();
  const [pendingCreations, setPendingCreations] = useState<NativeSessionCreateInput[]>([]);
  const nativeCreateRecovery = useRef<Promise<{ results: NativeSessionCreateResult[]; error?: string; navigationRevision: number }> | undefined>(undefined);

  const newSession = useCallback(() => {
    void nav.navigate(() => {
      const current = nav.get();
      const selected = lists.get().projects.find((item) => item.id === current.projectId);
      if (selected?.system === 'task-workspace') nav.rememberTaskProject(null);
      const { projects, projectlessTasks } = lists.get();
      const taskProjects = projects.filter((item) => !item.system && !item.archivedAt);
      // The 助理 has one conversation, so a new session from there is a new task, never its empty page.
      const taskProjectId = projectlessTasks
        ? taskProjects.find((item) => item.id === current.taskProjectId)?.id ?? ''
        : taskProjects.sort((a, b) => (current.projectVisits[b.id] ?? 0) - (current.projectVisits[a.id] ?? 0))[0]?.id ?? '';
      const projectId = selected?.system === 'task-workspace' ? ''
        : selected?.system === 'assistant' ? taskProjectId
        : selected?.system !== 'quick-chat' && projectlessTasks ? current.taskProjectId ?? '' : current.projectId;
      if (projectId !== current.projectId) clearContext(ui);
      nav.set({ projectId, sessionId: '', ...NO_PAGE });
      ui.setMobileSidebar(false);
    });
  }, [nav, ui, lists]);

  useEffect(() => {
    if (!loaded) return;
    let active = true;
    // StrictMode tears down and re-runs effects in development. Share the same exact
    // idempotent recovery work, but let the second setup attach its own live UI handler.
    if (!nativeCreateRecovery.current) {
      nativeCreateRecovery.current = (async () => {
        const navigationRevision = nav.getNavigationRevision();
        const results: NativeSessionCreateResult[] = [];
        for (const body of listNativeCreateRequests()) {
          if (body.invalidReason) continue;
          try {
            const found = (await api.sessions()).find(item => item.id === body.clientSessionId);
            if (!found) continue;
            const run = (await api.runs(found.id, body.initialMessage.commandId)).find(item => item.sessionId === found.id && item.commandId === body.initialMessage.commandId);
            if (!run) continue;
            const result = { session: found, run };
            if (!body.draftCleared && !acknowledgeRecoveredCreationDraft(body)) throw new Error(t`草稿无法保存到浏览器，刷新后会丢失`);
            removeNativeCreateRequest(body.clientSessionId);
            results.push(result);
          } catch (error) {
            return { results, navigationRevision, error: t`暂时无法确认是否已发送` };
          }
        }
        return { results, navigationRevision };
      })();
    }
    void nativeCreateRecovery.current.then(({ results, error, navigationRevision }) => {
      if (!active) return;
      for (const result of results) {
        if (result.project) lists.upsertProject(result.project);
        upsertSession(result.session);
        ui.set({ nativeRunSeed: { sessionId: result.session.id, run: result.run } });
      }
      setPendingCreations(listNativeCreateRequests());
      const destination = results.at(-1)?.session;

      if (error) toast.error(error);
    });
    return () => { active = false; };
  }, [loaded, upsertSession, ui, handlers, lists, nav, t]);

  // Native creation returns before the dispatcher has materialized its PTY. Resolve the exact
  // terminal id as soon as the session reports it so the first accepted run appears live without
  // waiting for the background terminal-list refresh.
  useEffect(() => {
    const terminalId = session?.kind === 'native' ? session.terminalId : undefined;
    if (!session || !terminalId || terminals.some((item) => item.id === terminalId)) return;
    const sessionId = session.id;
    let active = true;
    void api.getTerminal(terminalId).then((found) => {
      if (!active || found.id !== terminalId || found.sessionId !== sessionId || isShellTerminal(found)) return;
      lists.adoptTerminal(found, sessionId);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [session?.id, session?.kind, session?.terminalId, terminals, lists]);

  // The seed stays until another create replaces it. The session view keeps it only while its run
  // is an un-echoed receipt, so a remount can still show the first prompt inline; once the server
  // lists the run or it settles, the seed is ignored.

  const selectProject = useCallback((next: ProjectRecord) => {
    void nav.navigate(() => {
      if (next.id !== nav.get().projectId) clearContext(ui);
      nav.rememberTaskProject(next.system === 'task-workspace' ? null : next.id);
      nav.set({ projectId: next.id, sessionId: '', ...NO_PAGE });
      ui.setMobileSidebar(false);
    });
  }, [nav, ui]);
  const selectNoProject = useCallback(() => {
    void nav.navigate(() => {
      clearContext(ui);
      nav.rememberTaskProject(null);
      nav.set({ projectId: '', sessionId: '', ...NO_PAGE });
      ui.setMobileSidebar(false);
    });
  }, [nav, ui]);
  const selectSession = useCallback((next: Session) => {
    void nav.navigate(() => {
      if (next.id !== nav.get().sessionId) { clearContext(ui); nav.set({ focusMessage: undefined, sessionView: undefined }); }
      nav.set({ projectId: next.projectId, sessionId: next.id, ...NO_PAGE });
      ui.setMobileSidebar(false);
    });
  }, [nav, ui]);

  /**
   * Opens a conversation search result. The conversation is selected first, and the transcript is
   * told which message to show; it scrolls there once that row exists, which may be after the
   * stream arrives or after a page of older history. When the message is older than anything
   * loaded, the transcript pages back for it, and stays on the conversation if it never turns up.
   */
  const openMessageHit = (hit: MessageSearchHit) => {
    const target = lists.get().sessions.find((item) => item.id === hit.sessionId);
    if (!target) return;
    void nav.navigate(() => {
      if (target.id !== nav.get().sessionId) clearContext(ui);
      nav.set({ projectId: target.projectId, sessionId: target.id, ...NO_PAGE, focusMessage: { sessionId: hit.sessionId, focus: { messageId: hit.messageId, ...(hit.runId ? { runId: hit.runId } : {}) } } });
      ui.setMobileSidebar(false);
    });
  };

  /**
   * Opens a 收藏 where it is now: the server re-locates the message (rewriting a stale anchor), and
   * the transcript is focused on it the way a search result is. A mark whose message is gone still
   * opens its conversation, since the conversation is the closest thing left to it.
   */
  const openMark = async (id: string) => {
    let location: MarkLocation;
    try { location = await api.locateMark(id); }
    catch (error) { toast.error(errorMessage(error, t`无法定位这条收藏`)); return; }
    const { mark } = location;
    const target = lists.get().sessions.find((item) => item.id === mark.sessionId);
    if (!target) { toast.info(t`原会话已不存在，只能查看收藏里保存的内容`); return; }
    const focus = location.found ? { messageId: location.messageId, aliases: [mark.anchor.messageId, ...(mark.anchor.aliases ?? [])], ...(mark.quote ? { quote: mark.quote } : {}) } : undefined;
    const moved = await nav.navigate(() => {
      if (target.id !== nav.get().sessionId) clearContext(ui);
      nav.set({ projectId: target.projectId, sessionId: target.id, ...NO_PAGE, focusMessage: focus ? { sessionId: target.id, focus } : undefined });
      ui.setMobileSidebar(false);
    });
    if (moved && !location.found) toast.info(t`原文已找不到，已打开所在会话`);
  };

  /** Opens a conversation the workbench launched on the reader's behalf (fork, handoff, attempt, template). */
  const openLaunched = useCallback((result: NativeSessionCreateResult) => {
    const show = () => {
      if (result.project) lists.upsertProject(result.project);
      upsertSession(result.session);
      // The server marks the source handed off in the same request; reflect it before the next refresh.
      const origin = result.session.origin;
      if (origin?.kind === 'handoff' && origin.sessionId) lists.markHandedOff(origin.sessionId, result.session.id);
      ui.set({ nativeRunSeed: { sessionId: result.session.id, run: result.run } });
      handlers.selectSession(result.session);
    };
    // Isolated templates create a new worktree project along with the session. Opening that
    // session before its project is loaded would render the no-project screen instead.
    if (result.project || lists.get().projects.some((item) => item.id === result.session.projectId)) show();
    else void loadBootstrap().then(show).catch((error) => toast.error(errorMessage(error, t`无法刷新项目列表`)));
  }, [upsertSession, lists, ui, handlers, loadBootstrap, t]);

  const findSession = useCallback((id: string) => sessions.find((item) => item.id === id), [sessions]);
  const openSessionById = useCallback((id: string) => {
    const target = lists.get().sessions.find((item) => item.id === id);
    if (target) handlers.selectSession(target);
    else void loadBootstrap().then((next) => {
      const launched = next.sessions.find((item) => item.id === id);
      if (launched) handlers.selectSession(launched);
    }).catch((error) => toast.error(errorMessage(error, t`无法刷新会话列表`)));
  }, [lists, handlers, loadBootstrap, t]);

  /** An imported conversation may have created its project, so the lists reload before it opens. */
  const openImported = useCallback(async (imported: Session) => {
    upsertSession(imported);
    if (!lists.get().projects.some((item) => item.id === imported.projectId)) await loadBootstrap();
    handlers.selectSession(imported);
  }, [upsertSession, lists, loadBootstrap, handlers]);

  /** Each attempt lives in a new worktree project, so the lists reload before the group page opens. */
  const onAttemptsStarted = useCallback((group: AttemptGroup) => {
    void loadBootstrap().then(() => nav.openAttemptsGroup(group.id)).catch((error) => toast.error(errorMessage(error, t`无法刷新项目列表`)));
  }, [loadBootstrap, nav, t]);

  /** Native creation and first-message acceptance share one idempotent request. */
  /** `projectId` defaults to the selected project. */
  /**
   * `mode` absent takes the backend's saved default. `workItemId` starts that 任务; `follow: false`
   * keeps the reader where they are (the board) instead of opening the new conversation.
   */
  const createNative = async ({ projectId, projectless, title, prompt, attachments, context, mode, model, approval, toolGroups, extensionsOff, backendId, backendProfileId, workItemId, follow = true }: { projectId?: string; projectless?: boolean; title?: string; prompt: string; attachments: Attachment[]; context: PromptContextReference[]; mode?: string; model?: string; approval?: string; toolGroups?: ToolGroupId[]; extensionsOff?: string[]; backendId?: NativeBackendId; backendProfileId?: string | null; workItemId?: string; follow?: boolean }) => {
    const targetProjectId = projectless ? undefined : projectId ?? project?.id;
    if (!targetProjectId && !projectless) return false;
    const targetBackendId = backendId ?? homeBackendId;
    // An explicit null starts without a profile, which is how the quick-chat backend runs.
    const targetProfileId = backendProfileId === null ? undefined : backendProfileId ?? (backendId ? undefined : homeProfileId);
    ui.set({ creating: true });
    try {
      const candidate: NativeSessionCreateInput = {
        clientSessionId: newId(),
        ...(targetProjectId ? { projectId: targetProjectId } : { projectless: true }),
        ...(title ? { title } : {}),
        backendId: targetBackendId,
        ...(targetProfileId ? { backendProfileId: targetProfileId } : {}),
        ...(mode ? { mode } : {}),
        ...(model ? { model } : {}),
        ...(approval ? { approval } : {}),
        ...(toolGroups ? { toolGroups } : {}),
        ...(extensionsOff ? { extensionsOff } : {}),
        ...(workItemId ? { workItemId } : {}),
        initialMessage: {
          commandId: newId(),
          text: prompt.trim(),
          ...(attachments.length ? { attachments: attachments.map(({ id }) => ({ id })) } : {}),
          ...messageContext(context),
        },
      };
      const prior = listNativeCreateRequests();
      const matching = prior.find((item) => nativeCreatePayloadKey(item) === nativeCreatePayloadKey(candidate));
      if (prior.length && !matching) {
        toast.error(t`上一条消息尚未确认，请先检查状态`);
        return false;
      }
      const body = matching ?? candidate;
      saveNativeCreateRequest(body);
      const origin = nav.get();
      const navigationRevision = nav.getNavigationRevision();
      const defaultsRevision = settingsStore.revision();
      try {
        const result = await api.createNativeSession(body);
        acceptedCreation.current = body;
        if (result.project) lists.upsertProject(result.project);
        // Persist the full accepted selector, including effort, even when the first turn used a catalog default.
        // A 助理 conversation's choice is the 助理's (docs/ASSISTANT.md), not the composer's everywhere else.
        if (!matching && targetBackendId !== 'chat' && body.model && isAssistantProject(lists.get().projects.find((item) => item.id === targetProjectId))) settingsStore.rememberAssistant({ backendId: targetBackendId, profileId: result.session.backendProfileId ?? targetProfileId ?? null, model: result.session.model ?? body.model });
        // A 任务's own model is the task's, not a change to the composer's default.
        else if (!matching && !workItemId && targetBackendId !== 'chat' && body.model && settingsStore.revision() === defaultsRevision) settingsStore.remember(targetBackendId, { model: result.session.model ?? body.model, profileId: result.session.backendProfileId ?? targetProfileId });
        upsertSession(result.session);
        ui.set({ nativeRunSeed: { sessionId: result.session.id, run: result.run } });
        // The reader may have moved on while the request was in flight; only follow it if not.
        const current = nav.get();
        if (follow && nav.getNavigationRevision() === navigationRevision && current.projectId === origin.projectId && current.sessionId === origin.sessionId) {
          handlers.selectSession(result.session);
        }
      } catch (error) {
        if (creationWasRejected(error, body)) {
          if (!body.draftCleared) removeNativeCreateRequest(body.clientSessionId);
          else saveNativeCreateRequest({ ...body, rejected: true, invalidReason: errorMessage(error, t`无法创建会话`) });
          setPendingCreations(listNativeCreateRequests());
          toast.error(errorMessage(error, t`无法创建会话`));
          return false;
        }
        pendingCreation.current = body;
        setPendingCreations(listNativeCreateRequests());
        return true;
      }
      return true;
    } catch (error) {
      toast.error(errorMessage(error, t`无法创建会话`));
      return false;
    } finally { ui.set({ creating: false }); }
  };

  const recoverCreation = async (body: NativeSessionCreateInput, retry: boolean | 'restore' = false) => {
    if (ui.get().creating) return;
    ui.set({ creating: true });
    try {
      if (retry === 'restore') {
        if (!body.rejected) throw new Error(t`暂时无法确认是否已发送，请先检查状态`);
        const files = await Promise.all((body.initialMessage.attachments ?? []).map(async ({ id }) => {
          try { return { attachment: await api.attachmentMetadata(id) }; }
          catch (error) { return { missing: { key: `missing:${id}`, attachmentId: id, name: t`附件`, size: 0, image: false, error: error instanceof HttpError && error.status === 404 ? t`请重新选择文件` : t`无法读取附件` } }; }
        }));
        void nav.navigate(() => {
          const available = lists.get().projects.filter(item => !item.archivedAt);
          const original = available.find(item => item.id === body.projectId);
          const current = available.find(item => item.id === nav.get().projectId);
          const projectId = original?.id ?? current?.id ?? '';
          if (nav.get().projectId !== projectId) clearContext(ui);
          nav.set({ projectId, sessionId: '', ...NO_PAGE });
          setCreationRestore({ projectId: projectId || undefined, draft: {
            text: body.initialMessage.text,
            attachments: files.flatMap(item => item.attachment ? [item.attachment] : []),
            context: restoreNewSessionContext(body.initialMessage),
            missingAttachments: files.flatMap(item => item.missing ? [item.missing] : []),
            nonce: Date.now(),
            onPersisted: () => {
              removeNativeCreateRequest(body.clientSessionId);
              setPendingCreations(listNativeCreateRequests());
              setCreationRestore(undefined);
            },
          } });
        });
        return;
      }
      if (body.invalidReason) throw new Error(body.invalidReason);
      let result: NativeSessionCreateResult | undefined;
      if (retry) result = await api.createNativeSession(body);
      else {
        const found = (await api.sessions()).find(item => item.id === body.clientSessionId);
        const run = found ? (await api.runs(found.id, body.initialMessage.commandId)).find(item => item.sessionId === found.id && item.commandId === body.initialMessage.commandId) : undefined;
        if (found && run) result = { session: found, run };
      }
      if (!result) return;
      if (!body.draftCleared && !acknowledgeRecoveredCreationDraft(body)) throw new Error(t`草稿无法保存到浏览器，刷新后会丢失`);
      removeNativeCreateRequest(body.clientSessionId);
      if (result.project) lists.upsertProject(result.project);
      upsertSession(result.session);
      ui.set({ nativeRunSeed: { sessionId: result.session.id, run: result.run } });
      if (retry) handlers.selectSession(result.session);
    } catch (error) {
      if (retry === true && error instanceof HttpError && error.status >= 400 && error.status < 500 && isRecord(error.details) && error.details.accepted === false) {
        try { saveNativeCreateRequest({ ...body, rejected: true, invalidReason: errorMessage(error, t`无法创建会话`) }); }
        catch (storageError) { toast.error(errorMessage(storageError, t`无法保存待发送消息，请检查浏览器存储空间`)); return; }
      }
      toast.error(errorMessage(error, t`无法检查状态，请稍后重试`));
    }
    finally { setPendingCreations(listNativeCreateRequests()); ui.set({ creating: false }); }
  };

  const reopenNative = async (target: Session) => {
    ui.set({ creating: true, startingNativeId: target.id });
    try {
      const opened = await api.startSession<TerminalInfo | { session: Session; terminal?: TerminalInfo }>(target.id);
      if ('session' in opened) { upsertSession(opened.session); if (opened.terminal) upsertTerminal(opened.terminal); }
      else { upsertTerminal(opened); upsertSession({ ...target, terminalId: opened.id, state: 'running' }); }
      ui.set({ startingNativeId: undefined });
      await loadBootstrap();
    }
    catch (error) { toast.error(errorMessage(error, t`无法重新打开终端`)); }
    finally { ui.set({ startingNativeId: undefined, creating: false }); }
  };

  const sessionAction = async (target: Session, action: SessionAction) => {
    try {
      if (action === 'pin') {
        upsertSession(await api.updateSession(target.id, { pinned: !target.pinnedAt }));
      } else if (action === 'rename') {
        const title = await promptDialog({ title: t`重命名会话`, initial: target.title, confirmLabel: t`保存`, multiline: true });
        if (!title?.trim() || title.trim() === target.title) return;
        upsertSession(await api.updateSession(target.id, { title: title.trim() }));
      } else if (action === 'tags') {
        const value = await promptDialog({ title: t`会话标签`, description: t`多个标签用逗号分隔`, initial: (target.tags ?? []).join(', '), confirmLabel: t`保存` });
        if (value === null) return;
        upsertSession(await api.updateSession(target.id, { tags: parseTags(value) }));
      } else if (action === 'delete') {
        await requestSessionDeletion(target);
      } else if (action === 'work-item') {
        const result = await api.setSessionWorkItem(target.id, { workItemId: 'new' });
        upsertSession(result.session);
        if (result.workItem) {
          workItems.accept(result.workItem);
          toast.success(t`已转为任务 #${result.workItem.number}`, { action: { label: t`查看`, onClick: () => { void nav.navigate(() => nav.openPage('tasks')); } } });
        }
      } else {
        const archiving = !target.archivedAt;
        const wasSelected = nav.get().sessionId === target.id;
        if (archiving && wasSelected && !(await nav.navigate(() => {}))) return;
        const updated = await api.updateSession(target.id, { archived: archiving });
        upsertSession(updated);
        // Only if the reader is still on it: switching away while the request ran is not overruled.
        if (archiving && wasSelected && nav.get().sessionId === target.id) {
          // Any of the 助理's conversations leaves you on its page: they are not listed, so none is a
          // neighbour, and a new session would leave the page (docs/ASSISTANT.md).
          if (isAssistantProject(lists.get().projects.find((item) => item.id === target.projectId))) { clearContext(ui); nav.set({ projectId: target.projectId, sessionId: '', ...NO_PAGE }); }
          else {
          // Land on the neighbouring conversation, as the sidebar lists it, rather than an empty composer.
          const siblings = sortSessionsByActivity(lists.get().sessions.filter((item) => item.projectId === target.projectId && (item.id === target.id || !item.archivedAt)));
          const at = siblings.findIndex((item) => item.id === target.id);
          const neighbour = siblings[at + 1] ?? siblings[at - 1];
          if (neighbour) selectSession(neighbour); else newSession();
          }
        }
        const undo = async () => {
          try {
            const restored = await api.updateSession(target.id, { archived: false });
            upsertSession(restored);
            // Through the handler: the closure's selection is from before the archive moved off this conversation.
            // A 助理 conversation restored after another took its place is no longer its page: stay put.
            const replaced = lists.get().projects.some((item) => isAssistantProject(item) && item.id === restored.projectId && item.mainSessionId !== restored.id);
            if (wasSelected && !replaced) handlers.selectSession(restored);
          } catch (error) { toast.error(errorMessage(error, t`撤销失败`)); }
        };
        // Its page's name, not the stored title, as the header shows it.
        const shownTitle = lists.get().projects.some((item) => item.mainSessionId === target.id) ? t`个人助理` : target.title;
        if (archiving) toast.success(t`已归档「${shownTitle}」`, { action: { label: t`撤销`, onClick: () => void undo() } });
      }
    } catch (error) { toast.error(errorMessage(error, t({ message: '操作失败', context: 'workbench-action-failed' }))); }
  };

  return { creationRestore, pendingCreations, recoverCreation, newSession, selectProject, selectNoProject, acknowledgeCreation: (recover = false) => {
    if (pendingCreation.current) {
      const pending = pendingCreation.current;
      if (recover && !acknowledgeRecoveredCreationDraft(pending)) return;
      saveNativeCreateRequest({ ...pending, draftCleared: true });
      pendingCreation.current = undefined;
      setPendingCreations(listNativeCreateRequests());
      return;
    }
    const body = acceptedCreation.current;
    if (!body || (recover && !acknowledgeRecoveredCreationDraft(body))) return;
    removeNativeCreateRequest(body.clientSessionId);
    acceptedCreation.current = undefined;
  }, selectSession, openMessageHit, openMark, openLaunched, findSession, openSessionById, openImported, onAttemptsStarted, createNative, reopenNative, sessionAction };
}
