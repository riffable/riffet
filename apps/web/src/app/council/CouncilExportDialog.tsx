import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { CouncilDiscussion, NativeBackendCatalogEntry } from '@contracts';
import type { ProjectRecord } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { conclusionOf, readableCouncilText } from './model';

/** The conclusion under the discussion's title; for a review, the revised document. */
export function defaultExportBody(discussion: CouncilDiscussion): string {
  const conclusion = conclusionOf(discussion);
  if (!conclusion) return discussion.title;
  const text = discussion.format === 'review' ? conclusion.text : readableCouncilText(conclusion.text, discussion.seats);
  return `# ${discussion.title}\n\n${text}`;
}

export function CouncilExportDialog({
  open,
  kind,
  discussion,
  projects,
  backends,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  kind: 'task' | 'session';
  discussion: CouncilDiscussion;
  projects: ProjectRecord[];
  backends: NativeBackendCatalogEntry[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (payload: { kind: 'task' | 'session'; body: string; projectId?: string; backendId?: NativeBackendCatalogEntry['backendId'] }) => void;
}) {
  const { t } = useLingui();
  const [body, setBody] = useState(() => defaultExportBody(discussion));
  const [projectId, setProjectId] = useState(() => projects[0]?.id ?? '');
  const [backendId, setBackendId] = useState<string>(() => backends[0]?.backendId ?? '');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>{kind === 'task' ? <Trans>转为任务</Trans> : <Trans>带入会话</Trans>}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field label={t`内容`}>
            <Textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          {projects.length > 0 && (
            <Field label={t`项目`}>
              <Select
                label={t`项目`}
                value={projectId}
                onChange={setProjectId}
                options={projects.map((p) => ({ value: p.id, label: p.name }))}
              />
            </Field>
          )}
          {kind === 'session' && backends.length > 0 && (
            <Field label={t`Agent`}>
              <Select
                label={t`Agent`}
                value={backendId}
                onChange={setBackendId}
                options={backends.map((b) => ({ value: b.backendId, label: b.label }))}
              />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}><Trans>取消</Trans></Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!body.trim()}
            onClick={() => onConfirm({
              kind,
              body,
              ...(projectId ? { projectId } : {}),
              ...(kind === 'session' && backendId ? { backendId: backendId as NativeBackendCatalogEntry['backendId'] } : {}),
            })}
          >
            {kind === 'task' ? <Trans>创建任务</Trans> : <Trans>开始会话</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
