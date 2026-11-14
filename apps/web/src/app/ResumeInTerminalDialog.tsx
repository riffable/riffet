import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Session } from '@contracts';
import { IconCopy } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { copyWithToast } from '@/lib/files';
import { errorMessage } from '@/lib/utils';
import { useStores } from './state/stores';

type Resume = { nativeSessionId: string; command: string; credentialsOmitted: boolean };

/** The conversation's id and the command that continues it in a terminal (docs/TERMINAL-SESSIONS.md). */
export function ResumeInTerminalDialog({ open, onOpenChange, session }: { open: boolean; onOpenChange: (open: boolean) => void; session: Session }) {
  const { t } = useLingui();
  const { lists } = useStores();
  const [resume, setResume] = useState<Resume>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const sessionId = session.id;

  useEffect(() => {
    if (!open) return;
    let live = true;
    setResume(undefined);
    setError(undefined);
    api.resumeCommand(sessionId).then((value) => { if (live) setResume(value); }, (reason) => { if (live) setError(errorMessage(reason, t`无法读取恢复命令`)); });
    return () => { live = false; };
  }, [open, sessionId, t]);

  const copyCommand = async () => {
    if (!resume || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const copied = copyWithToast(resume.command);
      lists.upsertSession((await api.releaseSessionCli(sessionId)).session);
      await copied;
    } catch (reason) {
      setError(errorMessage(reason, t`命令已复制，但 Riffet 中的会话进程未停止`));
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent mobileSheet aria-describedby={undefined}>
        <DialogHeader><DialogTitle><Trans>在终端恢复</Trans></DialogTitle></DialogHeader>
        <DialogBody className="flex flex-col gap-4 pt-1">
          {resume ? <>
            <ValueRow label={t`会话 ID`} value={resume.nativeSessionId} copyLabel={t`复制会话 ID`} onCopy={() => void copyWithToast(resume.nativeSessionId)} />
            <ValueRow label={t({ message: '命令', context: 'resume-command' })} value={resume.command} copyLabel={t`复制命令`} busy={busy} onCopy={() => void copyCommand()} />
          </> : !error && <div className="grid h-24 place-items-center"><Spinner /></div>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </DialogBody>
        {resume && <DialogFooter className="flex-col items-start gap-1 text-xs text-fg-3">
          <p><Trans>复制命令时会停止 Riffet 中这个会话的进程，终端运行期间这里无法发送。</Trans></p>
          {resume.credentialsOmitted && <p><Trans>终端不会带上 Riffet 中配置的模型接口和密钥。</Trans></p>}
        </DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

function ValueRow({ label, value, copyLabel, busy, onCopy }: { label: string; value: string; copyLabel: string; busy?: boolean; onCopy: () => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-fg-3">{label}</span>
      <div className="flex min-w-0 items-start gap-2 rounded-lg border border-line bg-subtle py-1.5 pl-3 pr-1.5">
        <code className="min-w-0 flex-1 select-text break-all py-0.5 font-mono text-xs text-fg">{value}</code>
        <Button type="button" variant="quiet" size="icon-sm" aria-label={copyLabel} title={copyLabel} onClick={onCopy} className="shrink-0" busy={busy}><IconCopy /></Button>
      </div>
    </div>
  );
}
