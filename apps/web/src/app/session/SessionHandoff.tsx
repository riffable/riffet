import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowRightLeft, IconCheck, IconRotateCw, IconSparkles } from '@/components/icons';
import type { HandoffDraft, NativeBackendCatalogEntry, NativeBackendId, Session } from '@contracts';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, HttpError, type NativeSessionCreateResult } from '@/lib/api';
import { sessionBackend, useBackendLabel } from '@/lib/backends';
import { MOBILE_LAYOUT_QUERY } from '@/lib/use-media-query';
import { toast } from '@/lib/toast';
import { cn, errorMessage, newId } from '@/lib/utils';
import { useLists } from '../state/stores';
import { AutomationEditor, type AutomationEditorState } from '../tasks/AutomationEditor';
import { LaunchTargetBar, launchTargetOf, useBackendCatalogs, type LaunchTargetShape } from './LaunchTargetBar';

/**
 * Backends as cards rather than a dropdown: these launches are about *which* agent, so every choice
 * stays in view with why it cannot be picked. `selected` is a list so the same grid serves the
 * single choice of a handoff and the several of a parallel attempt. The source backend stays in
 * the list: handing back to the same Agent is a fresh conversation carrying only the summary.
 */
export function BackendCards({ backends, selected, onToggle }: {
  backends: NativeBackendCatalogEntry[];
  selected: NativeBackendId[];
  onToggle: (backendId: NativeBackendId) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {backends.map((entry) => {
        const on = selected.includes(entry.backendId);
        return (
          <button
            key={entry.backendId}
            type="button"
            disabled={!entry.available}
            aria-pressed={on}
            onClick={() => onToggle(entry.backendId)}
            className={cn(
              'flex min-h-11 items-center gap-3 rounded-lg border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              on ? 'border-accent bg-accent-soft' : 'border-line enabled:hover:bg-hover',
            )}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-fg">{entry.label}</span>
              {!entry.available && entry.reason && <span className="line-clamp-2 text-xs text-fg-3">{entry.reason}</span>}
            </span>
            {on && <IconCheck className="ml-auto size-4 shrink-0 text-accent" />}
          </button>
        );
      })}
    </div>
  );
}

export function HandoffDialog({ open, onOpenChange, session, backends, working, onLaunched, onError }: {
  open: boolean; onOpenChange: (open: boolean) => void; session: Session; backends: NativeBackendCatalogEntry[];
  /** A turn in flight would keep changing what the brief describes, so the server refuses it too. */
  working: boolean;
  onLaunched: (result: NativeSessionCreateResult) => void; onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const label = useBackendLabel();
  const source = sessionBackend(session);
  const [target, setTarget] = useState<LaunchTargetShape>({});
  const { catalogs, pending, refresh } = useBackendCatalogs(session.projectId, [target]);
  const [goal, setGoal] = useState('');
  /** Kept when the target or goal changes: the text does not depend on the target, and 重新生成 applies a new goal. */
  const [draft, setDraft] = useState<HandoffDraft>();
  const [text, setText] = useState('');
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const launchIds = useRef({ clientSessionId: newId(), commandId: newId() });
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const generation = useRef<AbortController>(undefined);
  const stopGenerating = () => {
    generation.current?.abort();
    generation.current = undefined;
    setGenerating(false);
  };
  // Another Agent stays the default (switching is the usual reason to hand off); the same one
  // is only the fallback when nothing else is available, but stays selectable afterwards.
  const defaultBackend = backends.find((entry) => entry.available && entry.backendId !== source)?.backendId ?? backends.find((entry) => entry.available)?.backendId;
  // Each opening starts over in its own first render, so a reopened dialog never shows the last handoff. The target
  // starts over too: a backend/model chosen for one conversation must not ride into another session's handoff.
  const [opened, setOpened] = useState<{ open: boolean; sessionId: string }>();
  if (opened?.open !== open || opened.sessionId !== session.id) {
    setOpened({ open, sessionId: session.id });
    if (open) { setGoal(''); setTarget({ backendId: defaultBackend }); setDraft(undefined); setText(''); }
  }
  if (open && target.backendId !== defaultBackend && !backends.some((entry) => entry.available && entry.backendId === target.backendId)) setTarget({ backendId: defaultBackend });
  useEffect(() => {
    if (!open) return;
    launchIds.current = { clientSessionId: newId(), commandId: newId() };
    return stopGenerating;
  }, [open, session.id]);
  const busyError = (error: unknown, fallback: string) =>
    onError(error instanceof HttpError && error.code === 'SESSION_BUSY' ? t`先停止当前任务再交接` : errorMessage(error, fallback));
  const generate = async () => {
    if (!target.backendId || generating || busy || working) return;
    generation.current?.abort();
    const controller = new AbortController();
    generation.current = controller;
    setGenerating(true);
    try {
      const result = await api.handoffDraft(session.id, { target: launchTargetOf(target), ...(goal.trim() ? { goal: goal.trim() } : {}) }, controller.signal);
      if (generation.current !== controller) return;
      setDraft(result);
      setText(result.text);
    } catch (error) {
      if (!controller.signal.aborted) busyError(error, t`无法生成交接摘要`);
    } finally {
      if (generation.current === controller) { generation.current = undefined; setGenerating(false); }
    }
  };
  const submit = async () => {
    if (!target.backendId || !draft || !text.trim() || busy || generating || working) return;
    setBusy(true);
    try {
      const result = await api.handoffSession(session.id, { ...launchIds.current, target: launchTargetOf(target), text: text.trim() });
      onOpenChange(false);
      onLaunched(result);
      toast.success(t`已交接给 ${label(target.backendId)}`);
    } catch (error) {
      busyError(error, t`无法交接会话`);
    } finally { setBusy(false); }
  };
  const origin = (() => {
    if (!draft) return '';
    if (draft.generatedBy) {
      const { profileName, model } = draft.generatedBy;
      return t`由 ${profileName} · ${model} 生成`;
    }
    const reason = draft.fallbackReason;
    return reason ? t`摘要模型不可用，已改用对话记录：${reason}` : t`由对话记录拼成`;
  })();
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent
        aria-describedby={undefined}
        size={draft ? 'content' : 'form'}
        onOpenAutoFocus={(event) => {
          // Otherwise Radix focuses the first backend card, and its :focus-visible ring reads as
          // a second selection beside the real one. On phones DialogContent focuses the sheet
          // itself instead, so the keyboard stays down until the field is tapped.
          if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) return;
          event.preventDefault();
          goalRef.current?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader>
          <DialogTitle><Trans>交接会话</Trans></DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <BackendCards backends={backends} selected={target.backendId ? [target.backendId] : []} onToggle={(backendId) => setTarget({ backendId })} />
          {target.backendId && (
            <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
              <LaunchTargetBar showBackend={false} showMode={false} value={target} onChange={(patch) => setTarget((current) => ({ ...current, ...patch }))} backends={backends} catalogs={catalogs} pending={pending} projectId={session.projectId} disabled={busy || generating} refreshCatalog={(backendId, profileId) => refresh({ backendId, profileId })} />
            </div>
          )}
          <Field label={t`后续任务`}>
            <Textarea ref={goalRef} value={goal} disabled={busy || generating} onChange={(event) => setGoal(event.target.value)} placeholder={t`先确认现状和未完成的部分，然后继续完成它`} />
          </Field>
          {draft && (
            <div className="flex flex-col gap-1.5">
              <Textarea aria-label={t`交接摘要`} value={text} disabled={busy || generating} onChange={(event) => setText(event.target.value)} className="min-h-80" />
              <p className="text-xs text-fg-3">{origin}</p>
            </div>
          )}
          {working && <p className="text-xs text-warning"><Trans>{label(source)} 还在运行，先停止当前任务再交接。</Trans></p>}
        </DialogBody>
        <DialogFooter>
          {draft ? <>
            <Button variant="ghost" disabled={busy || working} onClick={() => void generate()} busy={generating}><IconRotateCw /><Trans>重新生成</Trans></Button>
            <Button variant="primary" disabled={generating || working || !text.trim()} onClick={() => void submit()} busy={busy}><IconArrowRightLeft /><Trans>交接</Trans></Button>
          </> : <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}><Trans context="session-cancel-action">取消</Trans></Button>
            <Button variant="primary" disabled={working || !target.backendId} onClick={() => void generate()} busy={generating}><IconSparkles /><Trans>生成</Trans></Button>
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Save as scheduled task": the full editor, opened with this conversation's opening request, agent and project. */
export function SaveAutomationDialog({ open, onOpenChange, session, backends, onError }: {
  open: boolean; onOpenChange: (open: boolean) => void; session: Session; backends: NativeBackendCatalogEntry[]; onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const projects = useLists((state) => state.projects);
  const [state, setState] = useState<AutomationEditorState>();
  useEffect(() => {
    if (!open) { setState(undefined); return; }
    let current = true;
    const seed: NonNullable<AutomationEditorState['seed']> = {
      name: session.title, projectId: session.projectId,
      target: { backendId: sessionBackend(session), ...(session.backendProfileId ? { backendProfileId: session.backendProfileId } : {}), ...(session.model ? { model: session.model } : {}), mode: session.mode, ...(session.approval ? { approval: session.approval } : {}) },
    };
    // The opening request is what a repeat of this conversation would start from; follow-ups that
    // steered a running turn only make sense inside it. The editor opens once, with it filled in.
    void api.runs(session.id)
      .then((runs) => runs.find((run) => run.native?.intent !== 'steer' && run.prompt.trim())?.prompt)
      .catch(() => undefined)
      .then((prompt) => { if (current) setState({ seed: { ...seed, ...(prompt ? { prompt } : {}) } }); });
    return () => { current = false; };
  }, [open, session.id]);
  return (
    <AutomationEditor
      state={state}
      projects={projects.filter((project) => !project.archivedAt && !project.system)}
      backends={backends}
      onClose={() => onOpenChange(false)}
      onSaved={() => toast.success(t`已保存`)}
      onError={onError}
    />
  );
}
