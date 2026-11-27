import { useCallback, useEffect, useState } from 'react';
import { msg } from '@lingui/core/macro';
import { i18n } from '@lingui/core';
import type { Attachment, NativeTurnTarget, NativeStopRequest, NativeRunRecovery, Run, Session, SessionControlSnapshot } from '@contracts';
import { api, HttpError, messageContext, restoreContext, listNativeSendRequests, removeNativeSendRequest, saveNativeSendRequest, submitNativeSendRequest, type NativeMessageInput, type NativeSendOutboxEntry, type PromptContextReference } from '@/lib/api';
import { onSessionCommand } from '@/lib/session-commands';
import { errorMessage, newId } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { inQueue, nativeTaskOutcome } from './delivery';
import { canRestoreUnsentRun } from './model';
import { isUncertainRequest, mergeRun, optimisticRun, settleQueuedSource, snapshotWithLocalOutbox } from './nativeOutbox';
import { setRunActionPending, updateRuns, type NativeSessionLatest, type NativeSessionStore, type NativeSessionTracking } from './nativeSessionStore';

interface NativeRunCommandOptions {
  session: Session;
  store: NativeSessionStore;
  tracking: NativeSessionTracking;
  latest: { readonly current: NativeSessionLatest };
  /** The server's control snapshot as of now; absent from an older server. */
  control: { readonly current: SessionControlSnapshot | undefined };
}

type RequestWorkbenchConnection = () => Promise<string | undefined> | undefined;

/** The server could not hand the steer to its turn and queued it as the next message instead (`requeueSteer`). */
const steerQueuedInstead = (run: Run) => run.native?.intent !== 'steer' && run.native?.stage === 'steer_fallback';
const steerQueuedNotice = () => i18n._(msg`未能补充到当前任务，已排为下一条消息`);

/**
 * What the reader can do to a conversation's runs: send, steer, interrupt, and settle a send whose
 * outcome is unknown. Every command reads the store when it runs rather than a rendered copy, and
 * drops its answer once the view has moved to another conversation.
 */
export function useNativeRunCommands({ session, store, tracking, latest, control }: NativeRunCommandOptions) {
  const [recoveries, setRecoveries] = useState<Record<string, NativeRunRecovery>>({});
  const updateRun = useCallback((run: Run) => {
    if (tracking.sessionId !== session.id || run.sessionId !== session.id) return;
    updateRuns(store, tracking, (current) => mergeRun(current, run));
  }, [session.id, store, tracking]);

  const submitPrompt = useCallback(async (text: string, attachments: Attachment[], references: PromptContextReference[], steerTarget?: NativeTurnTarget & { ownerRunId?: string }, sourceRun?: Run, onStored?: () => boolean, requestWorkbenchConnection?: RequestWorkbenchConnection) => {
    const prompt = text.trim();
    if (!prompt || tracking.sendInFlight || store.get().interrupting || store.get().runs.some((run) => run.native?.delivery === 'uncertain' && run.native.stage === 'http_unknown') || tracking.sessionId !== session.id) return false;
    const { connected, status } = store.get();
    if (steerTarget && (!connected || status.connection?.state && status.connection.state !== 'connected' || status.phase !== 'busy' || status.interaction || store.get().runs.some(run => run.native?.delivery === 'uncertain' && !run.native.queueReleasedAt))) { latest.current.onError(i18n._(msg`暂时无法补充当前任务，输入已保留`)); return false; }
    if (sourceRun && (!inQueue(sourceRun, control.current) || listNativeSendRequests(session.id).some(entry => entry.sourceRunId === sourceRun.id && !entry.invalidReason))) return false;
    const body: NativeMessageInput = {
      commandId: newId(),
      text: prompt,
      ...(sourceRun?.native ? { attachments: sourceRun.native.input.attachmentIds.map(id => ({ id })), context: sourceRun.native.input.context, ...(sourceRun.native.input.references ? { references: sourceRun.native.input.references } : {}), ...(sourceRun.native.input.agents ? { agents: sourceRun.native.input.agents } : {}) } : { ...(attachments.length ? { attachments: attachments.map(({ id }) => ({ id })) } : {}),
      ...messageContext(references) }),
      ...(steerTarget ? {} : { expectedConfigRevision: session.configRevision ?? 0 }),
    };
    const entry: NativeSendOutboxEntry = { sessionId: session.id, body, createdAt: new Date().toISOString(), ...(sourceRun ? { sourceRunId: sourceRun.id } : {}), ...(steerTarget ? { version: 2 as const, steerTarget: { nativeSessionId: steerTarget.nativeSessionId, turnId: steerTarget.turnId }, ownerRunId: steerTarget.ownerRunId } : {}) };
    try { saveNativeSendRequest(entry); }
    catch (error) { latest.current.onError(errorMessage(error, i18n._(msg`无法保存待发送消息，请检查浏览器存储空间`))); return false; }
    tracking.sendInFlight = true;
    store.set({ sending: true });
    updateRuns(store, tracking, (current) => mergeRun(current, optimisticRun(session, body, entry.createdAt, false, entry)));
    try {
      if (onStored && !onStored()) throw new HttpError(409, i18n._(msg`草稿无法保存到浏览器，刷新后会丢失`), 'CLIENT_DRAFT_NOT_PERSISTED');
      // Keep the draft/outbox handoff synchronous even when the appearance
      // channel needs to open a new connection before the POST.
      const connection = requestWorkbenchConnection && await requestWorkbenchConnection();
      const accepted = await submitNativeSendRequest(entry, connection);
      removeNativeSendRequest(session.id, body.commandId);
      if (tracking.sessionId === session.id) updateRuns(store, tracking, (current) => mergeRun(settleQueuedSource(current, sourceRun?.id), accepted));
      if (steerTarget && accepted.state === 'failed') {
        const unsent = canRestoreUnsentRun(accepted);
        if (tracking.sessionId === session.id) latest.current.onError(accepted.error ?? (unsent ? i18n._(msg`补充未发送，输入已保留`) : i18n._(msg`任务失败`)));
        return !unsent;
      }
      if (steerTarget && steerQueuedInstead(accepted) && tracking.sessionId === session.id) latest.current.onError(steerQueuedNotice());
      return true;
    } catch (error) {
      const received = tracking.sessionId === session.id
        ? store.get().runs.find(run => run.commandId === body.commandId && run.native?.fingerprint !== 'client-pending')
        : undefined;
      if (received) {
        // The stream can acknowledge this exact command before its POST loses the response.
        // It is already accepted; keep that receipt and clear the submitted draft normally.
        removeNativeSendRequest(session.id, body.commandId);
        if (sourceRun) updateRuns(store, tracking, current => settleQueuedSource(current, sourceRun.id));
        if (steerTarget && received.state === 'failed') {
          const unsent = canRestoreUnsentRun(received);
          latest.current.onError(received.error ?? (unsent ? i18n._(msg`补充未发送，输入已保留`) : i18n._(msg`任务失败`)));
          return !unsent;
        }
        if (steerTarget && steerQueuedInstead(received)) latest.current.onError(steerQueuedNotice());
        return true;
      }
      if (!isUncertainRequest(error)) {
        const rejected = { ...entry, invalidReason: errorMessage(error, i18n._(msg`发送失败，可恢复内容后重试`)) };
        try { saveNativeSendRequest(rejected); } catch { /* The original durable submission remains recoverable. */ }
        if (tracking.sessionId === session.id) {
          updateRuns(store, tracking, current => mergeRun(current, optimisticRun(session, body, entry.createdAt, false, rejected)));
          latest.current.onError(rejected.invalidReason);
        }
        return true;
      }
      if (tracking.sessionId === session.id) updateRuns(store, tracking, (current) => mergeRun(current, optimisticRun(session, body, entry.createdAt, true, entry)));
      // The saved submission owns this input even when the HTTP response is lost.
      return true;
    } finally {
      tracking.sendInFlight = false;
      if (tracking.sessionId === session.id) store.set({ sending: false });
    }
  }, [session, store, tracking, latest]);

  useEffect(() => {
    let active = true;
    // Look up saved identities exactly. A missing recent-list row never authorizes a resend.
    for (const entry of listNativeSendRequests(session.id)) {
      if (entry.invalidReason) continue;
      void api.runs(session.id, entry.body.commandId).then(matches => {
        const match = matches.find(item => item.sessionId === session.id && item.commandId === entry.body.commandId);
        if (!active || tracking.sessionId !== session.id || !match) return;
        removeNativeSendRequest(session.id, entry.body.commandId);
        updateRuns(store, tracking, current => mergeRun(settleQueuedSource(current, entry.sourceRunId), match));
      }).catch(() => {});
    }
    const changed = (event: StorageEvent) => {
      if (!event.key?.startsWith('riffet.outbox.v1.')) return;
      for (const entry of listNativeSendRequests(session.id)) updateRuns(store, tracking, current => mergeRun(current, optimisticRun(session, entry.body, entry.createdAt, true, entry)));
    };
    window.addEventListener('storage', changed);
    return () => { active = false; window.removeEventListener('storage', changed); };
  }, [session.id, store, tracking]);

  const send = useCallback((text: string, attachments: Attachment[], references: PromptContextReference[], onStored?: () => boolean, requestWorkbenchConnection?: RequestWorkbenchConnection) => submitPrompt(text, attachments, references, undefined, undefined, onStored, requestWorkbenchConnection), [submitPrompt]);

  const steer = useCallback((text: string, attachments: Attachment[], references: PromptContextReference[], onStored?: () => boolean) => {
    const target = store.get().status.activeTurn;
    if (!target) { latest.current.onError(i18n._(msg`当前任务已结束或尚未同步，请检查会话后重试`)); return Promise.resolve(false); }
    return submitPrompt(text, attachments, references, target, undefined, onStored);
  }, [store, latest, submitPrompt]);

  const steerQueued = useCallback((run: Run) => {
    const current = store.get().runs.find(item => item.id === run.id);
    const target = store.get().status.activeTurn;
    if (!current || !target) return Promise.resolve(false);
    return submitPrompt(current.native?.input.text ?? current.prompt, [], [], target, current);
  }, [store, submitPrompt]);
  const hasPendingQueuedSteer = useCallback((runId: string) => listNativeSendRequests(session.id).some(entry => entry.sourceRunId === runId && !entry.invalidReason), [session.id]);

  const sendQueuedNow = useCallback(async (run: Run) => {
    const current = store.get().runs.find((item) => item.id === run.id);
    if (hasPendingQueuedSteer(run.id) || !current || !inQueue(current, control.current) || tracking.sendInFlight || store.get().interrupting || store.get().runActionIds.has(run.id) || tracking.sessionId !== session.id
      || store.get().runs.some((item) => item.native?.delivery === 'uncertain' && item.native.stage === 'http_unknown')) return;
    store.set({ interrupting: true });
    setRunActionPending(store, run.id, true);
    const key = `riffet.stop.${session.id}.${run.id}`;
    try {
      // Promote the server's accepted run: its prompt, attachments and command ID stay intact.
      const saved = localStorage.getItem(key);
      if (saved && !(await api.sessionCatalog(session.id)).capabilities.supportsTargetedStop) throw new Error(i18n._(msg`服务器版本过旧，请更新后重试`));
      const stop: NativeStopRequest = saved ? JSON.parse(saved) : await stopTarget();
      localStorage.setItem(key, JSON.stringify(stop));
      if (localStorage.getItem(key) !== JSON.stringify(stop)) throw new Error(i18n._(msg`无法保存待发送消息，请检查浏览器存储空间`));
      const updated = await api.sendQueuedNativeRunNow(session.id, run.id, stop);
      try { localStorage.removeItem(key); } catch { /* Keep the known server result. */ }
      if (tracking.sessionId === session.id) updateRun(updated);
    } catch (error) {
      if (!isUncertainRequest(error)) {
        try { localStorage.removeItem(key); } catch { /* Keep the queued message regardless of storage access. */ }
      }
      if (isUncertainRequest(error)) {
        const revision = tracking.runsRevision;
        const snapshot = await api.runs(session.id).catch(() => undefined);
        if (snapshot && tracking.sessionId === session.id && tracking.runsRevision === revision) updateRuns(store, tracking, () => snapshotWithLocalOutbox(session, snapshot));
      }
      if (tracking.sessionId === session.id) latest.current.onError(errorMessage(error, i18n._(msg`无法停止并发送，排队消息已保留`)));
    } finally {
      if (tracking.sessionId === session.id) {
        store.set({ interrupting: false });
        setRunActionPending(store, run.id, false);
      }
    }
  }, [session, store, tracking, latest, updateRun, hasPendingQueuedSteer]);

  const retryNativeRun = useCallback(async (run: Run, requestWorkbenchConnection?: RequestWorkbenchConnection) => {
    if (run.native?.stage !== 'http_unknown' || run.native.delivery !== 'uncertain' || store.get().runActionIds.has(run.id) || tracking.sessionId !== session.id) return;
    const entry = listNativeSendRequests(session.id).find((item) => item.body.commandId === run.commandId);
    if (!entry) { latest.current.onError(i18n._(msg`发送记录缺失，无法重试`)); return; }
    if (entry.invalidReason) { latest.current.onError(entry.invalidReason); return; }
    setRunActionPending(store, run.id, true);
    try {
      // The explicit retry can be the first POST the server receives. A duplicate
      // command returns its original receipt without changing its workbench binding.
      const connection = requestWorkbenchConnection && !entry.steerTarget && entry.version === undefined && !entry.sourceRunId && !entry.mode
        ? await requestWorkbenchConnection() : undefined;
      if (tracking.sessionId !== session.id) return;
      const accepted = await submitNativeSendRequest(entry, connection);
      removeNativeSendRequest(session.id, entry.body.commandId);
      if (tracking.sessionId === session.id) {
        updateRuns(store, tracking, current => mergeRun(settleQueuedSource(current, entry.sourceRunId), accepted));
        if (entry.steerTarget && accepted.state === 'failed') latest.current.onError(accepted.error ?? (canRestoreUnsentRun(accepted) ? i18n._(msg`补充未发送，可恢复内容后重试`) : i18n._(msg`任务失败`)));
        else if (entry.steerTarget && steerQueuedInstead(accepted)) latest.current.onError(steerQueuedNotice());
      }
    } catch (error) {
      const received = tracking.sessionId === session.id
        ? store.get().runs.find(item => item.commandId === entry.body.commandId && item.native?.fingerprint !== 'client-pending')
        : undefined;
      if (received) {
        removeNativeSendRequest(session.id, entry.body.commandId);
        if (entry.sourceRunId) updateRuns(store, tracking, current => settleQueuedSource(current, entry.sourceRunId));
        if (entry.steerTarget && received.state === 'failed') latest.current.onError(received.error ?? (canRestoreUnsentRun(received) ? i18n._(msg`补充未发送，可恢复内容后重试`) : i18n._(msg`任务失败`)));
        else if (entry.steerTarget && steerQueuedInstead(received)) latest.current.onError(steerQueuedNotice());
        return;
      }
      if (!isUncertainRequest(error)) {
        // A rejected retry must retain content after the original submitted draft was cleared.
        const rejected = { ...entry, invalidReason: errorMessage(error, i18n._(msg`发送失败，可恢复内容后重试`)) };
        try { saveNativeSendRequest(rejected); } catch { /* Preserve the in-memory recovery row. */ }
        if (tracking.sessionId === session.id) updateRuns(store, tracking, current => mergeRun(current, optimisticRun(session, rejected.body, rejected.createdAt, false, rejected)));
        if (tracking.sessionId === session.id) latest.current.onError(errorMessage(error, i18n._(msg`发送失败，可恢复内容后重试`)));
      } else if (tracking.sessionId === session.id) {
        updateRuns(store, tracking, (current) => mergeRun(current, optimisticRun(session, entry.body, entry.createdAt, true, entry)));
      }
    } finally {
      if (tracking.sessionId === session.id) setRunActionPending(store, run.id, false);
    }
  }, [session, store, tracking, latest]);

  const cancelNativeRun = useCallback(async (run: Run): Promise<boolean> => {
    if (hasPendingQueuedSteer(run.id) || store.get().runActionIds.has(run.id) || tracking.sessionId !== session.id) return false;
    setRunActionPending(store, run.id, true);
    try {
      const updated = await api.cancelNativeRun(session.id, run.id);
      removeNativeSendRequest(session.id, run.commandId);
      if (tracking.sessionId === session.id) updateRun(updated);
      return updated.state === 'cancelled';
    } catch (error) {
      if (tracking.sessionId === session.id) latest.current.onError(errorMessage(error, i18n._(msg`无法取消排队消息`)));
      return false;
    } finally {
      if (tracking.sessionId === session.id) setRunActionPending(store, run.id, false);
    }
  }, [session.id, store, tracking, latest, updateRun, hasPendingQueuedSteer]);

  const recoverNativeRun = useCallback(async (run: Run) => {
    if (run.sessionId !== session.id || !run.native || !canRestoreUnsentRun(run) || store.get().runActionIds.has(run.id) || tracking.sessionId !== session.id) return;
    setRunActionPending(store, run.id, true);
    try {
      const entry = listNativeSendRequests(session.id).find(item => item.body.commandId === run.commandId);
      if (entry && !entry.invalidReason) throw new Error(i18n._(msg`暂时无法确认是否已发送，请先检查状态`));
      const attachments = await Promise.all(run.native.input.attachmentIds.map(id => api.attachmentMetadata(id)));
      const sourceRunId = run.native.sourceRunId ?? entry?.sourceRunId;
      if (sourceRunId) {
        // A refused conversion leaves its original queue entry intact. Re-read it before
        // restoring a second sendable copy; a stale local row is not proof of cancellation.
        const snapshot = await api.runs(session.id);
        if (tracking.sessionId !== session.id) return;
        const accepted = snapshot.find(item => item.commandId === run.commandId);
        if (accepted && !canRestoreUnsentRun(accepted)) throw new Error(i18n._(msg`消息可能已执行，无法恢复为新消息`));
        const source = snapshot.find(item => item.id === sourceRunId);
        if (source && source.native?.delivery !== 'cancelled' && source.state !== 'cancelled') {
          if (source.state !== 'queued' || source.native?.delivery !== 'queued' || source.native.intent || !await cancelNativeRun(source)) throw new Error(i18n._(msg`无法取回排队消息，请检查状态后重试`));
        } else if (!source) {
          // /runs is a recent window plus unfinished work. Absence alone does not prove deletion.
          if (hasPendingQueuedSteer(sourceRunId)) throw new Error(i18n._(msg`暂时无法确认是否已发送，请先检查状态`));
          try {
            const updated = await api.cancelNativeRun(session.id, sourceRunId);
            if (tracking.sessionId === session.id) updateRun(updated);
            if (updated.state !== 'cancelled') throw new Error(i18n._(msg`原排队消息可能已经执行，不能恢复为新消息`));
          } catch (error) {
            if (!(error instanceof HttpError && error.status === 404 && error.code === 'RUN_NOT_FOUND')) throw error;
          }
        }
      }
      if (tracking.sessionId !== session.id) return;
      return { text: run.native.input.text, attachments, context: restoreContext({ context: run.native.input.context, references: run.native.input.references, agents: run.native.input.agents }, run), onPersisted: () => {
        removeNativeSendRequest(session.id, run.commandId);
        if (tracking.sessionId === session.id && run.native?.fingerprint === 'client-pending') updateRuns(store, tracking, current => current.filter(item => item.id !== run.id));
      } };
    } catch (error) {
      if (tracking.sessionId === session.id) latest.current.onError(errorMessage(error, i18n._(msg`无法恢复内容，消息已保留`)));
    } finally {
      if (tracking.sessionId === session.id) setRunActionPending(store, run.id, false);
    }
  }, [session.id, store, tracking, latest, cancelNativeRun, hasPendingQueuedSteer, updateRun]);

  const checkNativeRun = useCallback(async (run: Run) => {
    if (store.get().runActionIds.has(run.id) || tracking.sessionId !== session.id) return;
    setRunActionPending(store, run.id, true);
    try {
      const catalog = await api.sessionCatalog(session.id);
      if (!catalog.capabilities.supportsRecovery) throw new Error(i18n._(msg`服务器版本过旧，请更新后重试`));
      let accepted = run;
      if (run.native?.fingerprint === 'client-pending') {
        const matches = await api.runs(session.id, run.commandId);
        if (tracking.sessionId !== session.id) return;
        // A stream receipt can replace the local copy while the query is still returning an empty list.
        const match = matches.find(item => item.sessionId === session.id && item.commandId === run.commandId)
          ?? store.get().runs.find(item => item.sessionId === session.id && item.commandId === run.commandId && item.native && item.native.fingerprint !== 'client-pending');
        // Absence never permits a new identity or a second editable draft.
        if (!match) { toast.info(i18n._(msg`仍无法确认当前状态`)); return; }
        accepted = match;
        removeNativeSendRequest(session.id, run.commandId);
        updateRun(accepted);
      }
      const result = await api.checkNativeRun(session.id, accepted.id);
      if (tracking.sessionId !== session.id) return;
      updateRun(result.run);
      setRecoveries(current => ({ ...current, [result.run.id]: result }));
      const checked = store.get().runs.find(item => item.id === result.run.id) ?? result.run;
      if (!result.canContinue && !checked.native?.queueReleasedAt && (checked.native?.delivery === 'uncertain' || checked.native?.stage === 'acknowledged' || nativeTaskOutcome(checked) === 'unknown')) {
        toast.info(i18n._(msg`仍无法确认当前状态`));
      }
    } catch (error) {
      if (tracking.sessionId === session.id) latest.current.onError(errorMessage(error, i18n._(msg`无法检查状态，请稍后重试`)));
    } finally {
      if (tracking.sessionId === session.id) setRunActionPending(store, run.id, false);
    }
  }, [session.id, store, tracking, latest, updateRun]);

  const continueNativeRun = useCallback(async (run: Run) => {
    const recovery = recoveries[run.id];
    if (!recovery?.canContinue || store.get().runActionIds.has(run.id) || tracking.sessionId !== session.id) return;
    setRunActionPending(store, run.id, true);
    try {
      updateRun(await api.resolveNativeRun(session.id, run.id, recovery.queuedRunIds));
      setRecoveries(current => { const next = { ...current }; delete next[run.id]; return next; });
    } catch (error) {
      if (tracking.sessionId === session.id) latest.current.onError(errorMessage(error, i18n._(msg`无法继续对话，请重新检查状态`)));
    } finally {
      if (tracking.sessionId === session.id) setRunActionPending(store, run.id, false);
    }
  }, [session.id, store, tracking, latest, updateRun, recoveries]);

  const stopTarget = async (requireTargeted = true): Promise<NativeStopRequest> => {
    const catalog = await api.sessionCatalog(session.id);
    const supported = requireTargeted ? catalog.capabilities.supportsTargetedStop : catalog.capabilities.supportsInterrupt;
    if (!supported) throw new Error(i18n._(msg`服务器版本过旧，请更新后重试`));
    const active = store.get().status.activeTurn;
    const nativeSessionId = active?.nativeSessionId ?? session.nativeSessionId;
    if (!nativeSessionId) throw new Error(i18n._(msg`当前任务尚未同步，请检查会话后重试`));
    const terminal = session.terminalId ? await api.getTerminal(session.terminalId) : undefined;
    return { requestId: newId(), nativeSessionId, ...(active?.turnId ? { turnId: active.turnId } : {}), ...(terminal ? { terminalId: terminal.id, terminalEpoch: terminal.epoch } : {}) };
  };

  const keys = useCallback(async (list: string[]) => {
    try { await api.nativeKeys(session.id, list); }
    catch (error) { latest.current.onError(errorMessage(error, i18n._(msg`无法发送按键`))); }
  }, [session.id, store, tracking, latest]);

  const cancel = useCallback(async () => {
    if (tracking.sendInFlight || store.get().interrupting || tracking.sessionId !== session.id) return;
    store.set({ interrupting: true });
    const key = `riffet.stop.${session.id}`;
    try {
      const saved = localStorage.getItem(key);
      if (saved && !(await api.sessionCatalog(session.id)).capabilities.supportsInterrupt) throw new Error(i18n._(msg`服务器版本过旧，请更新后重试`));
      const stopOnce = async (target: NativeStopRequest) => {
        localStorage.setItem(key, JSON.stringify(target));
        if (localStorage.getItem(key) !== JSON.stringify(target)) throw new Error(i18n._(msg`无法保存待发送消息，请检查浏览器存储空间`));
        const result = await api.cancelSession(session.id, target);
        try { localStorage.removeItem(key); } catch { /* Replaying the same completed operation remains safe. */ }
        if (result.run) updateRun(result.run);
      };
      try {
        await stopOnce(saved ? JSON.parse(saved) : await stopTarget(false));
      } catch (error) {
        // The server refused because the turn it runs is not the one this request named (a stale status or
        // a replayed target). Nothing was stopped, so aim at the current turn once; a turn that ended needs nothing.
        if (!(error instanceof HttpError && error.code === 'NATIVE_STOP_TARGET_CHANGED')) throw error;
        localStorage.removeItem(key);
        const phase = store.get().status.phase;
        if (tracking.sessionId !== session.id || (phase !== 'busy' && phase !== 'attention')) return;
        await stopOnce(await stopTarget(false));
      }
    }
    catch (error) {
      if (!isUncertainRequest(error)) localStorage.removeItem(key);
      if (tracking.sessionId === session.id) latest.current.onError(errorMessage(error, i18n._(msg({ message: '无法停止', context: 'session-stop-failed' }))));
    }
    finally { if (tracking.sessionId === session.id) { store.set({ interrupting: false }); } }
  }, [session, store, tracking, latest, updateRun]);
  useEffect(() => onSessionCommand(session.id, (command) => { if (command === 'stop') void cancel(); }), [session.id, cancel]);

  return { send, steer, steerQueued, hasPendingQueuedSteer, sendQueuedNow, retryNativeRun, cancelNativeRun, recoverNativeRun, checkNativeRun, continueNativeRun, recoveries, keys, cancel };
}
