import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { WORK_ITEM_LIMITS, type NativeBackendCatalogEntry, type WorkItem, type WorkItemAssignee } from '@contracts';
import type { ProjectRecord } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, Input, Select, Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useDiscardGuard } from '@/lib/dialogs';
import { useSettings, useStores } from '../state/stores';
import type { WorkItemView } from './model';
import { AssigneeMark, useAssigneeLabel } from './parts';

export interface NewWorkItemDraft { projectId?: string; parentId?: string }

const NO_PROJECT = '';
const OWNER = 'owner';

/** The agents an item can be given to, and the owner. Quick chat is no worker. */
export function assigneeChoices(backends: readonly NativeBackendCatalogEntry[]): WorkItemAssignee[] {
  return [...backends.filter((entry) => entry.backendId !== 'chat' && entry.available).map((entry): WorkItemAssignee => ({ kind: 'agent', backendId: entry.backendId })), { kind: 'owner' }];
}
export const assigneeValue = (assignee: WorkItemAssignee) => assignee.kind === 'owner' ? OWNER : assignee.backendId;

/** 新建任务: a form dialog (patterns §2.2). With 创建后开始 the item's first conversation starts too. */
export function NewWorkItemDialog({ draft, projects, backends, parents, onClose, onCreated }: {
  draft: NewWorkItemDraft | undefined;
  projects: ProjectRecord[];
  backends: NativeBackendCatalogEntry[];
  parents: WorkItemView[];
  onClose: () => void;
  onCreated: (item: WorkItem, startNow: boolean) => void;
}) {
  const { t } = useLingui();
  const { workItems } = useStores();
  const defaultBackendId = useSettings((settings) => settings.defaultBackendId);
  const assigneeLabel = useAssigneeLabel();
  const choices = assigneeChoices(backends);
  const initialAssignee = choices.find((choice) => choice.kind === 'agent' && choice.backendId === defaultBackendId) ?? choices[0]!;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [assignee, setAssignee] = useState<WorkItemAssignee>(initialAssignee);
  const [projectId, setProjectId] = useState(NO_PROJECT);
  const [startNow, setStartNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = draft !== undefined;
  const parent = draft?.parentId ? parents.find(({ item }) => item.id === draft.parentId) : undefined;

  useEffect(() => {
    if (!open) return;
    setTitle(''); setDescription(''); setCriteria(''); setAssignee(initialAssignee); setProjectId(draft.projectId ?? NO_PROJECT); setStartNow(false); setBusy(false);
    // A fresh form each time it opens; the choices themselves are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft]);

  const dirty = Boolean(title.trim() || description.trim() || criteria.trim());
  const criteriaLines = criteria.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, WORK_ITEM_LIMITS.criteria).map((line) => line.slice(0, WORK_ITEM_LIMITS.criterion));
  const discard = useDiscardGuard(dirty, busy);
  const guard = () => discard.close(onClose);
  const submit = async () => {
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    const item = await workItems.create({
      title: name,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(criteriaLines.length ? { criteria: criteriaLines } : {}),
      assignee,
      ...(projectId ? { projectId } : {}),
      ...(draft?.parentId ? { parentId: draft.parentId } : {}),
    });
    setBusy(false);
    if (!item) return;
    onClose();
    onCreated(item, startNow && assignee.kind === 'agent');
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) guard(); }}>
      <DialogContent size="form" mobileSheet aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{parent ? t`新建子任务` : t`新建任务`}</DialogTitle></DialogHeader>
        <form id="new-work-item" className="contents" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <DialogBody className="flex flex-col gap-4">
            <Field label={t`标题`}>
              <Input autoFocus value={title} maxLength={WORK_ITEM_LIMITS.title} onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <Field label={t`描述`}>
              <Textarea rows={4} value={description} maxLength={WORK_ITEM_LIMITS.description} onChange={(event) => setDescription(event.target.value)} />
            </Field>
            <Field label={t`验收标准`}>
              <Textarea rows={3} value={criteria} onChange={(event) => setCriteria(event.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
              <Field label={t`执行者`}>
                <Select
                  label={t`执行者`}
                  value={assigneeValue(assignee)}
                  onChange={(value) => setAssignee(choices.find((choice) => assigneeValue(choice) === value) ?? initialAssignee)}
                  options={choices.map((choice) => ({ value: assigneeValue(choice), label: assigneeLabel(choice), icon: <AssigneeMark assignee={choice} size={16} /> }))}
                />
              </Field>
              <Field label={t`项目`}>
                <Select
                  label={t`项目`}
                  value={projectId}
                  onChange={setProjectId}
                  options={[...projects.map((project) => ({ value: project.id, label: project.name })), { value: NO_PROJECT, label: t`无项目` }]}
                />
              </Field>
            </div>
            {assignee.kind === 'agent' && (
              <label className="flex w-fit cursor-default select-none items-center gap-2 text-sm text-fg-2">
                <Checkbox checked={startNow} onCheckedChange={(value) => setStartNow(value === true)} />
                <Trans>创建后开始</Trans>
              </label>
            )}
          </DialogBody>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={guard}><Trans>取消</Trans></Button>
          <Button variant="primary" type="submit" form="new-work-item" disabled={!title.trim() || busy}>{parent ? <Trans>创建子任务</Trans> : <Trans>创建任务</Trans>}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
