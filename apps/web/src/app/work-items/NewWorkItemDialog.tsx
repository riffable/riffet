import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { WORK_ITEM_LIMITS, workItemAgentChoice, type NativeBackendCatalogEntry, type WorkItem, type WorkItemAssignee } from '@contracts';
import type { ProjectRecord } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Select, Textarea } from '@/components/ui/controls';
import { IconPlus } from '@/components/icons';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useDiscardGuard } from '@/lib/dialogs';
import { useSettings, useStores } from '../state/stores';
import { useAgentModelChoice } from '../session/agentModelChoice';
import { ModelPicker } from '../session/ModelPicker';
import { isComposingKey } from '../session/composerKeyboard';
import type { WorkItemView } from './model';

export interface NewWorkItemDraft { projectId?: string; parentId?: string }

const NO_PROJECT = '';
const OWNER = 'owner';

/** The agents an item can be given to, and the owner. Quick chat is no worker. */
export function assigneeChoices(backends: readonly NativeBackendCatalogEntry[]): WorkItemAssignee[] {
  return [...backends.filter((entry) => entry.backendId !== 'chat' && entry.available).map((entry): WorkItemAssignee => ({ kind: 'agent', backendId: entry.backendId })), { kind: 'owner' }];
}
export const assigneeValue = (assignee: WorkItemAssignee) => assignee.kind === 'owner' ? OWNER : assignee.backendId;

/** The first non-empty line is the title, the rest the description. A first line past the limit is cut and the whole text kept as the description. */
export function splitTaskText(text: string): { title: string; description?: string } {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return { title: '' };
  const line = lines[first]!.trim();
  const rest = lines.slice(first + 1).join('\n').trim();
  if (line.length > WORK_ITEM_LIMITS.title) return { title: line.slice(0, WORK_ITEM_LIMITS.title).trim(), description: text.trim().slice(0, WORK_ITEM_LIMITS.description) };
  return { title: line, ...(rest ? { description: rest.slice(0, WORK_ITEM_LIMITS.description) } : {}) };
}

/**
 * 新建任务: a form dialog (patterns §2.2). 加入待办 only files the item; 开始 also starts its first
 * conversation with the agent, provider and model chosen here (docs/TASK-BOARD.md §9).
 */
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
  const saved = useSettings((settings) => settings.workItems);
  const defaultBackendId = useSettings((settings) => settings.defaultBackendId);
  const initialChoice = workItemAgentChoice({ workItems: saved, defaultBackendId }, backends);
  const [text, setText] = useState('');
  const [criteria, setCriteria] = useState('');
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const [picked, setChoice] = useState(initialChoice);
  // Agents listed after the dialog opened still give it a default.
  const choice = picked ?? initialChoice;
  const [projectId, setProjectId] = useState(NO_PROJECT);
  const [busy, setBusy] = useState(false);
  const open = draft !== undefined;
  const parent = draft?.parentId ? parents.find(({ item }) => item.id === draft.parentId) : undefined;
  const { picker, pick } = useAgentModelChoice({ projectId, backends, choice, agents: true });

  useEffect(() => {
    if (!open) return;
    setText(''); setCriteria(''); setCriteriaOpen(false); setChoice(initialChoice); setProjectId(draft.projectId ?? NO_PROJECT); setBusy(false);
    // A fresh form each time it opens; the choices themselves are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft]);

  const { title, description } = splitTaskText(text);
  const dirty = Boolean(text.trim() || criteria.trim());
  const criteriaLines = criteria.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, WORK_ITEM_LIMITS.criteria).map((line) => line.slice(0, WORK_ITEM_LIMITS.criterion));
  const discard = useDiscardGuard(dirty, busy);
  const guard = () => discard.close(onClose);
  const submit = async (startNow: boolean) => {
    if (!title || busy || (startNow && !choice)) return;
    setBusy(true);
    const assignee: WorkItemAssignee = choice ? { kind: 'agent', backendId: choice.backendId, ...(choice.profileId ? { profileId: choice.profileId } : {}), ...(choice.model ? { model: choice.model } : {}) } : { kind: 'owner' };
    const item = await workItems.create({
      title,
      ...(description ? { description } : {}),
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
        <form id="new-work-item" className="contents" onSubmit={(event) => { event.preventDefault(); void submit(true); }}>
          <DialogBody className="flex flex-col gap-4">
            <Textarea autoFocus rows={5} aria-label={t`要做什么`} placeholder={t`要做什么`} value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isComposingKey(event.nativeEvent)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
            {criteriaOpen ? <div className="flex flex-col gap-1.5">
              <Textarea autoFocus rows={3} aria-label={t`完成标准`} placeholder={t`完成标准，一条一行`} value={criteria} onChange={(event) => setCriteria(event.target.value)} />
              <p className="text-xs text-fg-3"><Trans>Agent 交付时逐条说明，由你验收</Trans></p>
            </div> : <Button type="button" variant="quiet" size="sm" className="-mt-2 self-start" onClick={() => setCriteriaOpen(true)}><IconPlus aria-hidden /><Trans>完成标准</Trans></Button>}
            <div className="flex items-center gap-3 max-md:flex-col max-md:items-stretch">
              <ModelPicker side="bottom" align="start" className="h-8 min-w-0 rounded-lg border border-line-strong bg-elevated px-3 text-fg-2 max-md:w-full" placeholder={t`默认模型`} {...picker}
                onChange={(id) => { const picked = pick(id); if (picked) setChoice(picked); }} />
              <Select
                className="min-w-0 flex-1 max-md:w-full"
                label={t`项目`}
                value={projectId}
                onChange={setProjectId}
                options={[...projects.map((project) => ({ value: project.id, label: project.name })), { value: NO_PROJECT, label: t`无项目` }]}
              />
            </div>
          </DialogBody>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={guard}><Trans>取消</Trans></Button>
          <Button variant="secondary" disabled={!title || busy} onClick={() => void submit(false)}><Trans>加入待办</Trans></Button>
          <Button variant="primary" type="submit" form="new-work-item" disabled={!title || busy || !choice}><Trans>开始</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
