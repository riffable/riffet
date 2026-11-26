import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useVisibleInterval } from '@/lib/use-visible-interval';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconCheck, IconColumns2, IconGitMerge, IconPlus, IconX } from '@/components/icons';
import type { AttemptComparison, AttemptGroup, LaunchTarget, NativeBackendCatalogEntry, NativeBackendId, Session } from '@contracts';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { Badge, Field, Input, Segmented, Spinner, StatusDot } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tip } from '@/components/ui/tooltip';
import type { Attachment } from '@contracts';
import { api, HttpError, isSessionReference, type PromptContextReference } from '@/lib/api';
import { useBackendLabel } from '@/lib/backends';
import { OverlayScopeContext, useOverlayState } from '@/lib/overlay-navigation';
import { toast } from '@/lib/toast';
import { cn, errorMessage, newId } from '@/lib/utils';
import { MergeDialog } from '../panels/PublishSection';
import { Composer } from './Composer';
import { LaunchTargetBar, launchTargetOf } from './LaunchTargetBar';
import { useAgentModels } from './agentModels';
import { ASSEMBLY_MS, useHeld, useLingering } from './sessionLayout';
import type { SlashCommand } from './model';
import { boundedCache } from '@/lib/bounded-cache';
import { registerBounded } from '@/lib/cache-registry';

const MAX_ATTEMPTS = 4;
const activeStates = new Set<Session['state']>(['starting', 'running', 'waiting', 'cancelling']);
const terminalStates = new Set<Session['state']>(['idle', 'failed', 'interrupted', 'archived']);

interface TargetRow { backendId: NativeBackendId; profileId?: string; model?: string; mode?: string; approval?: string }

const rowKey = (row: TargetRow) => `${row.backendId}|${row.profileId ?? ''}|${row.model ?? ''}|${row.mode ?? ''}|${row.approval ?? ''}`;
const attemptStripCache = boundedCache<string, { group: AttemptGroup; attempts: AttemptComparison[] }>({ limit: 64 });
registerBounded('attempt-strips', attemptStripCache, 64);
/** Each project's attempt groups as last read, so a home opened again starts with its list in place. */
const attemptHistoryCache = boundedCache<string, AttemptGroup[]>({ limit: 32 });
registerBounded('attempt-history', attemptHistoryCache, 32);

function useAttemptLabel() {
  const label = useBackendLabel();
  return (attempt: AttemptComparison) => {
    const base = attempt.target.backendId ? label(attempt.target.backendId) : i18n._(msg`默认`);
    return attempt.target.model ? `${base} · ${attempt.target.model}` : base;
  };
}
interface Adoption { visit: string; attempt: AttemptComparison; into?: string; dirty: boolean; directory: boolean }

/** What the merge dialog needs: the branch merged into, or that the origin is a directory outside Git. */
async function readAdoption(group: AttemptGroup, attempt: AttemptComparison): Promise<Adoption> {
  const [into, status] = await Promise.all([
    api.gitBranch(group.projectId).then((branch) => branch.branch, (error: unknown) => error instanceof HttpError && error.code === 'NOT_A_GIT_REPOSITORY' ? null : undefined),
    api.gitStatus(attempt.projectId),
  ]);
  return { visit: newId(), attempt, ...(into ? { into } : {}), dirty: status.entries.length > 0, directory: into === null };
}
const aliveAttempts = (group: AttemptGroup, attempts: AttemptComparison[]) => attempts.filter((attempt) => !group.attempts.find((item) => item.sessionId === attempt.sessionId)?.discardedAt);

function stateDot(state: Session['state'] | undefined) {
  if (state && activeStates.has(state)) return <StatusDot tone={state === 'waiting' ? 'warning' : 'accent'} pulse={state !== 'waiting'} label={state === 'waiting' ? i18n._(msg`等待处理`) : i18n._(msg`运行中`)} />;
  if (state === 'failed' || state === 'interrupted') return <StatusDot tone="danger" label={i18n._(msg`未完成`)} />;
  return <StatusDot tone="success" shape="ring" label={i18n._(msg({ message: '已完成', context: 'session-status-finished' }))} />;
}

export function AttemptsDialog({ open, onOpenChange, projectId, directory, backends, backendId, references, onReferencesChange, commands, inlineSkills, onSlashMenuOpen, enterBehavior, onStarted, onError }: {
  open: boolean; onOpenChange: (open: boolean) => void; projectId: string;
  /** The project is a directory outside Git: attempts start from what is on disk, with no commit to pick. */
  directory?: boolean;
  backends: NativeBackendCatalogEntry[];
  /** The backend picked on the home page, which the selection starts from. */
  backendId: NativeBackendId;
  references: PromptContextReference[];
  onReferencesChange: (references: PromptContextReference[]) => void;
  commands?: SlashCommand[];
  inlineSkills?: boolean;
  onSlashMenuOpen?: () => void;
  enterBehavior?: string;
  onStarted: (group: AttemptGroup) => void; onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const [rows, setRows] = useState<TargetRow[]>([]);
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  // One id per opening, so a retried submit after a dropped response finds the group it already made.
  const [requestId, setRequestId] = useState('');
  useEffect(() => {
    if (!open) return;
    setRequestId(newId());
  }, [open, projectId]);
  const available = backends.filter((entry) => entry.available);
  // Defaults are set in the render that opens the dialog (or whose backends change), so the first frame already has its rows.
  const [seeded, setSeeded] = useState<{ open: boolean; backends: typeof backends; backendId: NativeBackendId }>();
  if (seeded?.open !== open || seeded.backends !== backends || seeded.backendId !== backendId) {
    setSeeded({ open, backends, backendId });
    if (open) {
      const first = available.find((entry) => entry.backendId === backendId) ?? available[0];
      const second = available.find((entry) => entry.backendId !== first?.backendId);
      setRows([first, second].filter((entry): entry is NativeBackendCatalogEntry => Boolean(entry)).map((entry) => ({ backendId: entry.backendId })));
    }
  }
  const duplicate = rows.length !== new Set(rows.map(rowKey)).size;
  const agentModels = useAgentModels(projectId);
  const defaultProfileOf = (id: NativeBackendId) => {
    const profiles = available.find((entry) => entry.backendId === id)?.profiles ?? [];
    return profiles.find((profile) => profile.isDefault)?.id ?? profiles[0]?.id;
  };
  const { load: loadAgentModels } = agentModels;
  const rowCatalogTargets = rows.map((row) => `${row.backendId}:${row.profileId ?? defaultProfileOf(row.backendId) ?? ''}`).join('|');
  useEffect(() => {
    if (!open) return;
    loadAgentModels(backendId, defaultProfileOf(backendId));
    for (const row of rows) loadAgentModels(row.backendId, row.profileId ?? defaultProfileOf(row.backendId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, backendId, rowCatalogTargets, loadAgentModels]);
  const modelsOf = (row: { backendId?: NativeBackendId; profileId?: string }) => (row.backendId ? agentModels.read(row.backendId, row.profileId ?? defaultProfileOf(row.backendId)) ?? [] : []);

  const presetMulti = () => setRows(available.slice(0, 3).map((entry) => ({ backendId: entry.backendId })));
  const presetModels = () => {
    const entry = available.find((item) => item.backendId === backendId) ?? available[0];
    if (!entry) return;
    setRows(modelsOf({ backendId: entry.backendId }).slice(0, 3).map((model) => ({ backendId: entry.backendId, model: model.value })));
  };
  const addRow = () => {
    if (rows.length >= MAX_ATTEMPTS) return;
    const unused = available.find((entry) => !rows.some((row) => row.backendId === entry.backendId));
    const first = rows[0];
    const nextModel = first && !unused ? modelsOf(first).find((model) => !rows.some((row) => row.model === model.value))?.value : undefined;
    setRows([...rows, unused ? { backendId: unused.backendId } : { backendId: first?.backendId ?? backendId, ...(nextModel ? { model: nextModel } : {}) }]);
  };

  const submit = async (prompt: string, attachments: Attachment[], context: PromptContextReference[]) => {
    if (busy || duplicate || rows.length < 2) return false;
    if (context.some(isSessionReference)) { onError(t`并行尝试暂不接受会话引用`); return false; }
    setBusy(true);
    try {
      const { group, warnings } = await api.createAttempts(projectId, { prompt: prompt.trim(), targets: rows.map(launchTargetOf), ...(!directory && base.trim() ? { base: base.trim() } : {}), requestId, attachments, context });
      onOpenChange(false);
      onStarted(group);
      for (const warning of warnings) toast.info(warning);
      return true;
    } catch (error) {
      onError(error instanceof HttpError && error.code === 'INVALID_BASE' ? t`这个项目还没有提交，无法从同一起点切出 Worktree` : errorMessage(error, t`无法开始并行尝试`));
      return false;
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent size="content">
        <DialogHeader>
          <DialogTitle><Trans>并行尝试</Trans></DialogTitle>
          <DialogDescription>{directory ? <Trans>各尝试从目录当前的内容切出独立 Worktree。</Trans> : <Trans>各尝试从同一次提交切出独立 Worktree。</Trans>}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <Composer
            variant="hero"
            autoFocus
            projectId={projectId}
            draftKey={`attempts:${projectId}`}
            persistReferences={false}
            {...(enterBehavior ? { enterBehavior } : {})}
            placeholder={t`描述要完成的任务`}
            commands={commands ?? []}
            inlineSkills={inlineSkills}
            onSlashMenuOpen={onSlashMenuOpen}
            disabled={busy}
            submitDisabled={duplicate || rows.length < 2}
            references={references}
            onReferencesChange={onReferencesChange}
            onSubmit={submit}
            onError={onError}
          />
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-fg"><Trans>尝试</Trans></span>
              <span className="flex items-center gap-2">
                <Button size="xs" variant="quiet" onClick={presetMulti}><Trans>各 Agent 一次</Trans></Button>
                <Button size="xs" variant="quiet" disabled={!modelsOf({ backendId }).length} onClick={presetModels}><Trans>同 Agent 比模型</Trans></Button>
                <span className="text-xs text-fg-3 tabular-nums">{rows.length} / {MAX_ATTEMPTS}</span>
              </span>
            </div>
            {rows.map((row, index) => {
              const set = (patch: Partial<TargetRow>) => setRows(rows.map((item, i) => (i === index ? { ...item, ...patch } : item)));
              return (
                <div key={index} className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-xl bg-muted px-1.5 py-1.5">
                  <LaunchTargetBar value={row} onChange={set} backends={available} projectId={projectId} disabled={busy} />
                  <span className="flex-1" />
                  {rows.length > 2 && (
                    <Button size="xs" variant="quiet" aria-label={t`移除`} onClick={() => setRows(rows.filter((_, i) => i !== index))}><IconX /></Button>
                  )}
                </div>
              );
            })}
            {rows.length < MAX_ATTEMPTS && <Button size="xs" variant="quiet" className="self-start" onClick={addRow}><IconPlus /><Trans>再加一个</Trans></Button>}
            {duplicate && <p className="text-xs text-danger"><Trans>有重复配置</Trans></p>}
          </div>
          {!directory && (
            <Field label={t`起点`} hint={t`未提交改动不在起点内。`}>
              <Input value={base} onChange={(event) => setBase(event.target.value)} placeholder="HEAD" className="font-mono" />
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}><Trans context="session-cancel-action">取消</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The sibling attempts of this conversation, as a quiet row of tabs above it. The label opens the
 * group's comparison page; a tab opens that conversation here.
 */
export function AttemptStrip({ session, findSession, onOpenSession, onAdopted, onOpenGroup, onError }: {
  session: Session;
  findSession?: (id: string) => Session | undefined;
  onOpenSession?: (id: string) => void;
  onAdopted?: (result: { originProjectId: string; removedWorktree: boolean }) => void;
  onOpenGroup?: (group: AttemptGroup) => void;
  onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const labelOf = useAttemptLabel();
  const groupId = session.origin?.groupId;
  // Switching between sibling sessions remounts this strip; the last read of the same group is
  // rendered on the first frame so the column never collapses and reopens.
  const [data, setData] = useState<{ group: AttemptGroup; attempts: AttemptComparison[] } | undefined>(() => (groupId ? attemptStripCache.get(groupId) : undefined));
  const [adopting, setAdopting] = useState<Adoption>();
  const [adoptingOpen, setAdoptingOpen] = useState(false);
  const [cleanup, setCleanup] = useState<'keep' | 'archive' | 'remove'>('remove');
  const [preparing, setPreparing] = useState(false);
  // Diff stats move when a turn ends, so the live states of all siblings are the refresh signal.
  const states = data?.group.attempts.map((attempt) => findSession?.(attempt.sessionId)?.state ?? '').join() ?? '';
  const refresh = useCallback(async () => {
    if (!groupId) return;
    try {
      const next = await api.compareAttempts(groupId);
      attemptStripCache.set(groupId, next);
      setData(next);
    } catch { /* the strip is an aid; the conversation still works without it */ }
  }, [groupId]);
  useEffect(() => { void refresh(); }, [refresh, states, session.state]);

  if (!groupId) return null;
  if (!data) {
    // Reserve the strip's height while its first read is in flight; the transcript must not jump.
    return <div data-content-column className="mx-auto w-full max-w-(--content-width) shrink-0 px-3 pt-3 sm:px-4 md:px-12"><div className="h-7" /></div>;
  }
  const { group } = data;
  const attempts = aliveAttempts(group, data.attempts);
  const current = attempts.find((attempt) => attempt.sessionId === session.id);
  const currentState = findSession?.(session.id)?.state ?? session.state;
  const allDone = attempts.length > 0 && attempts.every((attempt) => terminalStates.has(findSession?.(attempt.sessionId)?.state ?? attempt.state ?? 'idle'));
  const doneCount = attempts.filter((attempt) => terminalStates.has(findSession?.(attempt.sessionId)?.state ?? attempt.state ?? 'idle')).length;

  const adopt = async (attempt: AttemptComparison) => {
    setPreparing(true);
    try {
      setCleanup('remove');
      setAdopting(await readAdoption(group, attempt));
      setAdoptingOpen(true);
    } catch (error) { onError(errorMessage(error, t`无法读取这个尝试的改动`)); }
    finally { setPreparing(false); }
  };

  return (
    <div data-content-column className="mx-auto flex w-full max-w-(--content-width) shrink-0 items-center gap-2 px-3 pt-3 sm:px-4 md:px-12">
      <Tip label={group.prompt.length > 160 ? `${group.prompt.slice(0, 160)}…` : group.prompt}>
        <button type="button" onClick={() => onOpenGroup?.(group)} className="hidden shrink-0 items-center gap-1.5 text-xs text-fg-3 hover:text-fg sm:inline-flex">
          <IconColumns2 className="size-3.5" /><Trans>并行尝试</Trans>
          <span className="tabular-nums text-fg-4">{doneCount}/{attempts.length}</span>
        </button>
      </Tip>
      <div role="tablist" aria-label={t`并行尝试`} className="inline-flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-none rounded-lg bg-muted p-0.5">
        {attempts.map((attempt) => {
          const selected = attempt.sessionId === session.id;
          const state = findSession?.(attempt.sessionId)?.state ?? attempt.state;
          const diff = attempt.comparison;
          return (
            <button
              key={attempt.sessionId}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => { if (!selected) onOpenSession?.(attempt.sessionId); }}
              className={cn(
                'inline-flex h-7 flex-none items-center gap-2 whitespace-nowrap rounded-md px-2.5 text-sm font-medium text-fg-3 transition-colors hover:text-fg',
                selected && 'bg-elevated text-fg shadow-[0_0_0_0.5px_var(--line-strong)]',
              )}
            >
              {stateDot(state)}
              {labelOf(attempt)}
              {group.adopted?.sessionId === attempt.sessionId && <IconCheck className="size-3.5 text-success" aria-label={t`已采用`} />}
              {diff && (diff.added || diff.removed)
                ? <span className="text-xs font-normal tabular-nums"><span className="text-success">+{diff.added}</span> <span className="text-danger">−{diff.removed}</span></span>
                : diff ? <span className="text-xs font-normal text-fg-4"><Trans>无改动</Trans></span> : null}
            </button>
          );
        })}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {group.adopted
          ? group.adopted.sessionId === session.id && <Badge tone="success"><IconCheck /><Trans>已采用</Trans></Badge>
          : (<>
            {allDone && <Button size="xs" variant="quiet" onClick={() => onOpenGroup?.(group)}><Trans>对比</Trans></Button>}
            {current && (
              <Tip label={activeStates.has(currentState) ? t`等这个尝试完成后再采用` : undefined}>
                <span>
                  <Button size="xs" variant="secondary" disabled={activeStates.has(currentState) || !current.comparison?.files.length} busy={preparing} onClick={() => void adopt(current)}>
                    <IconGitMerge /><Trans>采用此方案</Trans>
                  </Button>
                </span>
              </Tip>
            )}
          </>)}
      </div>
      {adopting && (
        <MergeDialog
          key={adopting.visit}
          open={adoptingOpen}
          onOpenChange={setAdoptingOpen}
          branch={adopting.attempt.branch}
          {...(adopting.into ? { into: adopting.into } : {})}
          dirty={adopting.dirty}
          directory={adopting.directory}
          title={t`采用 ${labelOf(adopting.attempt)} 的方案`}
          description={<Trans>把 <span className="font-mono text-fg-2">{adopting.attempt.branch}</span> 合并进原项目。</Trans>}
          defaultMessage={`${group.prompt.split('\n')[0]!.slice(0, 72)} (${adopting.attempt.target.backendId ?? 'attempt'})`}
          extra={(
            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-fg"><Trans>其余尝试</Trans></span>
              <Segmented ariaLabel={t`其余尝试`} value={cleanup} onChange={setCleanup} options={[{ value: 'keep', label: t`保留` }, { value: 'archive', label: t`归档` }, { value: 'remove', label: t`归档并删除 Worktree` }]} />
              {cleanup === 'remove' && <span className="text-xs text-fg-3"><Trans>有未提交改动时保留其项目。</Trans></span>}
            </div>
          )}
          merge={async (options) => { const result = await api.adoptAttempt(group.id, { ...options, cleanup, sessionId: adopting.attempt.sessionId }); for (const warning of result.warnings) toast.info(warning); return result.merge; }}
          onMerged={(removedWorktree) => { void refresh(); onAdopted?.({ originProjectId: group.projectId, removedWorktree }); }}
          onError={onError}
        />
      )}
    </div>
  );
}

// MARK: - Comparison page

/** One prompt's attempts side by side: cards first, the file matrix under them, and the lifecycle. */
export function AttemptGroupPage({ groupId, findSession, onOpenSession, onAdopted, onError, onClose }: {
  groupId: string;
  findSession?: (id: string) => Session | undefined;
  onOpenSession: (id: string) => void;
  onAdopted?: (result: { originProjectId: string; removedWorktree: boolean }) => void;
  onError: (message: string) => void;
  /** Leaving the page; with it, a browser Back (or Esc) closes the page instead of leaving Riffet. */
  onClose?: () => void;
}) {
  const { t } = useLingui();
  const labelOf = useAttemptLabel();
  const overlay = useOverlayState({ open: Boolean(onClose), onOpenChange: (next) => { if (!next) onClose?.(); } });
  const [data, setData] = useState<{ group: AttemptGroup; attempts: AttemptComparison[] }>();
  const [adopting, setAdopting] = useState<Adoption>();
  const [adoptingOpen, setAdoptingOpen] = useState(false);
  const [cleanup, setCleanup] = useState<'keep' | 'archive' | 'remove'>('remove');
  const [adding, setAdding] = useState(false);
  const [addTarget, setAddTarget] = useState<LaunchTarget>({});
  const [backends, setBackends] = useState<NativeBackendCatalogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try { setData(await api.compareAttempts(groupId)); } catch { /* keep the last read */ }
  }, [groupId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void api.backends().then(setBackends).catch(() => undefined); }, []);

  const group = data?.group;
  const attempts = useMemo(() => (group && data ? aliveAttempts(group, data.attempts) : []), [group, data]);
  const stateOf = useCallback((attempt: AttemptComparison) => findSession?.(attempt.sessionId)?.state ?? attempt.state ?? 'idle', [findSession]);
  const anyActive = attempts.some((attempt) => activeStates.has(stateOf(attempt)));
  useVisibleInterval(() => void refresh(), 4000, anyActive);

  const unionFiles = useMemo(() => [...new Set(attempts.flatMap((attempt) => attempt.comparison?.files.map((file) => file.path) ?? []))].sort(), [attempts]);
  const changers = (path: string) => attempts.filter((attempt) => attempt.comparison?.files.some((file) => file.path === path));
  const recommended = attempts
    .filter((attempt) => stateOf(attempt) === 'idle' && attempt.comparison?.files.length)
    .sort((a, b) => (a.comparison!.added + a.comparison!.removed) - (b.comparison!.added + b.comparison!.removed))[0];
  const doneCount = attempts.filter((attempt) => terminalStates.has(stateOf(attempt))).length;

  if (!group || !data) return <div className="flex flex-1 items-center justify-center"><Spinner /></div>;

  const adopt = async (attempt: AttemptComparison) => {
    try {
      setCleanup('remove');
      setAdopting(await readAdoption(group, attempt));
      setAdoptingOpen(true);
    } catch (error) { onError(errorMessage(error, t`无法读取这个尝试的改动`)); }
  };
  const act = async (run: () => Promise<unknown>, failure: string) => {
    if (busy) return;
    setBusy(true);
    try { await run(); await refresh(); } catch (error) { onError(errorMessage(error, failure)); } finally { setBusy(false); }
  };
  // Discard first: the group's size limit counts attempts that are not discarded yet, so
  // adding the replacement first would be refused exactly when the group is full.
  const retry = (attempt: AttemptComparison) => void act(async () => {
    await api.discardAttempt(group.id, attempt.sessionId, true);
    await api.addAttempt(group.id, attempt.target);
  }, t`无法重试`);
  return (
    <OverlayScopeContext.Provider value={overlay.scope}>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-base font-semibold text-fg">{group.prompt}</p>
            <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-fg-3">
              <span className="tabular-nums">{doneCount}/{attempts.length}</span>
              <span className="font-mono">{group.base.slice(0, 8)}</span>
            </p>
          </div>
          {anyActive && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(async () => { await Promise.all(attempts.filter((attempt) => activeStates.has(stateOf(attempt))).map((attempt) => api.cancelSession(attempt.sessionId))); }, t({ message: '无法停止', context: 'session-stop-failed' }))}><Trans>停止全部</Trans></Button>}
          {!group.adopted && attempts.length < MAX_ATTEMPTS && (
            <Button size="sm" variant="secondary" onClick={() => { setAddTarget({ backendId: backends.find((entry) => entry.available)?.backendId }); setAdding((value) => !value); }}><IconPlus /><Trans>追加</Trans></Button>
          )}
        </div>

        {adding && (
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-xl bg-muted px-1.5 py-1.5">
            <LaunchTargetBar
              value={{ backendId: addTarget.backendId, profileId: addTarget.backendProfileId, model: addTarget.model, mode: addTarget.mode, approval: addTarget.approval }}
              onChange={(patch) => setAddTarget({
                backendId: patch.backendId ?? addTarget.backendId,
                backendProfileId: 'profileId' in patch ? patch.profileId : addTarget.backendProfileId,
                model: 'model' in patch ? patch.model : addTarget.model,
                mode: 'mode' in patch ? patch.mode : addTarget.mode,
                approval: 'approval' in patch ? patch.approval : addTarget.approval,
              })}
              backends={backends.filter((entry) => entry.available)} projectId={group.projectId} disabled={busy}
            />
            <span className="flex-1" />
            <Button size="sm" variant="primary" disabled={busy || !addTarget.backendId} onClick={() => void act(async () => { await api.addAttempt(group.id, addTarget); setAdding(false); }, t`无法追加`)}><Trans>开始</Trans></Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}><Trans context="session-cancel-action">取消</Trans></Button>
          </div>
        )}

        {group.adopted
          ? <p className="flex items-center gap-2 text-sm text-success"><IconCheck className="size-4" /><Trans>已合并到原项目</Trans></p>
          : attempts.length > 0 && doneCount === attempts.length && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted px-3.5 py-2.5 text-sm text-fg-2">
              <IconCheck className="size-4 text-success" /><Trans>全部结束</Trans>
              <span className="flex-1" />
              {recommended && <Button size="xs" variant="primary" onClick={() => void adopt(recommended)}><Trans>采用推荐</Trans></Button>}
            </div>
          )}

        <div className="grid gap-3 lg:grid-cols-2">
          {attempts.map((attempt) => {
            const state = stateOf(attempt);
            const diff = attempt.comparison;
            const overlaps = (diff?.files ?? []).filter((file) => changers(file.path).length > 1).length;
            const isAdopted = group.adopted?.sessionId === attempt.sessionId;
            return (
              <article key={attempt.sessionId} className={cn('flex min-h-48 flex-col gap-2.5 rounded-xl border p-4', isAdopted ? 'border-success' : recommended?.sessionId === attempt.sessionId && !group.adopted ? 'border-accent' : 'border-line')}>
                <header className="flex items-center gap-2">
                  {stateDot(state)}
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{labelOf(attempt)}</span>
                  {isAdopted
                    ? <span className="text-xs font-medium text-success"><Trans>已采用</Trans></span>
                    : recommended?.sessionId === attempt.sessionId && !group.adopted && <span className="text-xs font-medium text-accent" title={t`已完成里改动最小`}><Trans>推荐</Trans></span>}
                  <span className="text-xs text-fg-3">{state === 'idle' ? t({ message: '已完成', context: 'session-status-finished' }) : state === 'failed' ? t`失败` : state === 'interrupted' ? t`已中断` : state === 'waiting' ? t`待处理` : t`运行中`}</span>
                </header>
                <p className="truncate font-mono text-xs text-fg-4">{attempt.branch}</p>
                {attempt.error && <p className="line-clamp-3 text-xs text-danger">{attempt.error}</p>}
                {attempt.title && attempt.title !== labelOf(attempt) && <p className="line-clamp-2 text-sm text-fg-2">{attempt.title}</p>}
                {diff && (
                  <>
                    <p className="flex flex-wrap gap-x-3 text-xs tabular-nums text-fg-3">
                      <span><span className="text-success">+{diff.added}</span> <span className="text-danger">−{diff.removed}</span></span>
                      <span><Trans>{diff.files.length} 个文件</Trans></span>
                      {diff.commits > 0 && <span><Trans>{diff.commits} 个提交</Trans></span>}
                      {overlaps > 0 && <span className="text-warning"><Trans>{overlaps} 个文件与其他尝试重叠</Trans></span>}
                    </p>
                    <ul className="flex flex-col">
                      {diff.files.slice(0, 5).map((file) => (
                        <li key={file.path} className="flex items-baseline gap-2 border-t border-dashed border-line py-1 text-xs">
                          <span className="min-w-0 flex-1 truncate font-mono text-fg-2">{file.path.split('/').pop()}</span>
                          <span className="tabular-nums"><span className="text-success">+{file.added ?? 0}</span> <span className="text-danger">−{file.removed ?? 0}</span></span>
                        </li>
                      ))}
                      {diff.files.length > 5 && <li className="py-1 text-xs text-fg-4"><Trans>还有 {diff.files.length - 5} 个</Trans></li>}
                    </ul>
                  </>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                  <Button size="xs" variant="secondary" onClick={() => onOpenSession(attempt.sessionId)}><Trans>打开</Trans></Button>
                  {activeStates.has(state)
                    ? <Button size="xs" variant="quiet" disabled={busy} onClick={() => void act(() => api.cancelSession(attempt.sessionId), t({ message: '无法停止', context: 'session-stop-failed' }))}><Trans>停止</Trans></Button>
                    : (state === 'failed' || state === 'interrupted') && <Button size="xs" variant="quiet" disabled={busy} onClick={() => retry(attempt)}><Trans>重试</Trans></Button>}
                  <span className="flex-1" />
                  {!group.adopted && (
                    <>
                      <Button size="xs" variant="quiet" disabled={busy} onClick={() => void act(() => api.discardAttempt(group.id, attempt.sessionId, true).then((result) => { for (const warning of result.warnings) toast.info(warning); }), t`无法丢弃`)}><Trans>丢弃</Trans></Button>
                      <Button size="xs" variant="secondary" disabled={busy || activeStates.has(state) || !diff?.files.length} onClick={() => void adopt(attempt)}><Trans>采用</Trans></Button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        {attempts.length > 1 && unionFiles.length > 0 && (
          <section className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full border-collapse text-xs">
              <thead><tr className="bg-subtle text-left text-fg-2"><th className="px-3 py-2 font-medium"><Trans context="session-file-noun">文件</Trans></th>{attempts.map((attempt) => <th key={attempt.sessionId} className="px-3 py-2 text-right font-medium">{labelOf(attempt)}</th>)}</tr></thead>
              <tbody>
                {unionFiles.map((path) => (
                  <tr key={path} className="border-t border-line">
                    <td className="max-w-72 truncate px-3 py-1.5 font-mono text-fg-2">{path}{changers(path).length > 1 && <span className="ml-2 rounded-full bg-warning/15 px-1.5 py-0.5 font-sans text-2xs text-warning"><Trans>重叠</Trans></span>}</td>
                    {attempts.map((attempt) => {
                      const file = attempt.comparison?.files.find((item) => item.path === path);
                      return <td key={attempt.sessionId} className="px-3 py-1.5 text-right tabular-nums">{file ? <><span className="text-success">+{file.added ?? 0}</span> <span className="text-danger">−{file.removed ?? 0}</span></> : <span className="text-fg-4">—</span>}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {attempts.length < data.attempts.length && <p className="text-xs text-fg-4"><Trans>已丢弃 {data.attempts.length - attempts.length} 个</Trans></p>}
      </div>
      {adopting && (
        <MergeDialog
          key={adopting.visit}
          open={adoptingOpen}
          onOpenChange={setAdoptingOpen}
          branch={adopting.attempt.branch}
          {...(adopting.into ? { into: adopting.into } : {})}
          dirty={adopting.dirty}
          directory={adopting.directory}
          title={t`采用 ${labelOf(adopting.attempt)} 的方案`}
          description={<Trans>把 <span className="font-mono text-fg-2">{adopting.attempt.branch}</span> 合并进原项目。</Trans>}
          defaultMessage={`${group.prompt.split('\n')[0]!.slice(0, 72)} (${adopting.attempt.target.backendId ?? 'attempt'})`}
          extra={(
            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-fg"><Trans>其余尝试</Trans></span>
              <Segmented ariaLabel={t`其余尝试`} value={cleanup} onChange={setCleanup} options={[{ value: 'keep', label: t`保留` }, { value: 'archive', label: t`归档` }, { value: 'remove', label: t`归档并删除 Worktree` }]} />
              {cleanup === 'remove' && <span className="text-xs text-fg-3"><Trans>有未提交改动时保留其项目。</Trans></span>}
            </div>
          )}
          merge={async (options) => { const result = await api.adoptAttempt(group.id, { ...options, cleanup, sessionId: adopting.attempt.sessionId }); for (const warning of result.warnings) toast.info(warning); return result.merge; }}
          onMerged={(removedWorktree) => { void refresh(); onAdopted?.({ originProjectId: group.projectId, removedWorktree }); }}
          onError={onError}
        />
      )}
    </div>
    </OverlayScopeContext.Provider>
  );
}

/** A project's attempt groups, newest first: the way back to a group whose conversations were closed. */
export function AttemptsHistory({ projectId, onOpenGroup }: { projectId: string; onOpenGroup: (group: AttemptGroup) => void }) {
  const { t } = useLingui();
  const [, loaded] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    let current = true;
    void api.attemptGroups(projectId).then((groups) => { attemptHistoryCache.set(projectId, groups); if (current) loaded(); }).catch(() => undefined);
    return () => { current = false; };
  }, [projectId]);
  // Read by project, so another project's list never shows while this one's is on its way.
  const groups = attemptHistoryCache.get(projectId);
  const shown = useHeld(groups?.length ? groups : undefined);
  // A list that lands as the home assembles appears in place; later it grows in instead of
  // pushing what is below it down in one frame.
  const assembled = useLingering(true, ASSEMBLY_MS);
  return (
    <Collapse open={Boolean(groups?.length)} still={!assembled}>
      <section className="mt-6 md:mt-10">
        <h2 className="mb-1 px-2 text-xs font-medium text-fg-3"><Trans>并行尝试</Trans></h2>
        <div className="flex flex-col">
          {shown?.slice(0, 5).map((group) => (
            <button key={group.id} type="button" onClick={() => onOpenGroup(group)} className="flex h-10 items-center gap-3 rounded-lg px-2 text-left text-sm hover:bg-hover">
              <IconColumns2 className="size-4 shrink-0 text-fg-4" />
              <span className="min-w-0 flex-1 truncate text-fg">{group.prompt}</span>
              {group.adopted && <IconCheck className="size-4 shrink-0 text-success" />}
              <span className="shrink-0 text-xs tabular-nums text-fg-3">{group.attempts.filter((attempt) => !attempt.discardedAt).length}</span>
            </button>
          ))}
        </div>
      </section>
    </Collapse>
  );
}
