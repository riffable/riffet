import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { CouncilDiscussion } from '@contracts';
import type { ProjectRecord } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { conclusionOf, readableCouncilText } from './model';

/** The conclusion under the discussion's title; for a review, the revised document. */
export function defaultExportBody(discussion: CouncilDiscussion): string {
  const conclusion = conclusionOf(discussion);
  if (!conclusion) return discussion.title;
  const text = discussion.format === 'review' ? conclusion.text : readableCouncilText(conclusion.text, discussion.seats);
  return `# ${discussion.title}\n\n${text}`;
}

/** A task from the conclusion: its text, editable, and the project it belongs to. */
export function CouncilExportDialog({
  open,
  discussion,
  projects,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  discussion: CouncilDiscussion;
  /** Most recently used first, so the default is where the reader last worked. */
  projects: ProjectRecord[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (payload: { kind: 'task'; body: string; projectId?: string }) => void;
}) {
  const { t } = useLingui();
  const openProjects = projects.filter((project) => !project.archivedAt);
  const [body, setBody] = useState(() => defaultExportBody(discussion));
  const [projectId, setProjectId] = useState(() => openProjects[0]?.id ?? '');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle><Trans>转为任务</Trans></DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <Field label={t`内容`}>
            <Textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          {openProjects.length > 0 && (
            <Field label={t`项目`}>
              <Select
                label={t`项目`}
                value={projectId}
                onChange={setProjectId}
                options={openProjects.map((p) => ({ value: p.id, label: p.name }))}
              />
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}><Trans>取消</Trans></Button>
          <Button variant="primary" busy={busy} disabled={!body.trim()} onClick={() => onConfirm({ kind: 'task', body, ...(projectId ? { projectId } : {}) })}>
            <Trans>创建任务</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
