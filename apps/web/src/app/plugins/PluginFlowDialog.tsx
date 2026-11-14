/**
 * Runs one plugin action and draws the steps it answers with, chiefly a device-code sign-in.
 *
 * The browser cannot run such a flow itself: the vendor's endpoints refuse cross-origin calls, and
 * the resulting credential belongs on the machine running the server, where the vendor's own tools
 * expect it. So the server starts the flow and keeps the device code; this dialog only shows the
 * user code and asks the server, by flow id, whether the user has authorized yet.
 *
 * Polling is driven from here rather than by the server because the interval is the client's to
 * widen: `slow_down` is the server's answer to polling too fast, and the dialog is the side that
 * knows whether the user is still looking at it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ActionStep, PluginAction } from '@contracts';
import { Spinner } from '@/components/ui/controls';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, HttpError } from '@/lib/api';
import { errorMessage } from '@/lib/utils';

type Waiting = Extract<ActionStep, { kind: 'show-code' }>;
type Phase = { kind: 'starting' } | Waiting | Extract<ActionStep, { kind: 'hint' }> | { kind: 'failed'; text: string };

const EXPIRED = msg`已过期`;

export function PluginFlowDialog({ pluginId, action, open, onOpenChange, onDone }: {
  pluginId?: string;
  action?: Pick<PluginAction, 'id' | 'label'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const { t } = useLingui();
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const [shownOpen, setShownOpen] = useState(open);
  const callbacks = useRef({ onOpenChange, onDone });
  callbacks.current = { onOpenChange, onDone };
  const actionId = action?.id;

  // Reset before the first render of a new opening, so no effect sees the last opening's code.
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) setPhase({ kind: 'starting' });
  }

  /** `pending` and `slow_down` only mean something while polling, which handles them itself. */
  const apply = useCallback((step: ActionStep) => {
    if (step.kind === 'done') { callbacks.current.onOpenChange(false); callbacks.current.onDone?.(); return; }
    if (step.kind === 'show-code' || step.kind === 'hint') setPhase(step);
    else if (step.kind === 'failed') setPhase({ kind: 'failed', text: step.message });
  }, []);

  // A fresh action per opening: a device code is single-use and expires in minutes.
  useEffect(() => {
    if (!open || !pluginId || !actionId) return;
    const controller = new AbortController();
    setPhase({ kind: 'starting' });
    void api.runPluginAction(pluginId, actionId, controller.signal).then((step) => {
      if (!controller.signal.aborted) apply(step);
    }).catch((error) => { if (!controller.signal.aborted) setPhase({ kind: 'failed', text: errorMessage(error, t({ message: '操作失败', context: 'settings-action-failed' })) }); });
    return () => controller.abort();
  }, [open, pluginId, actionId, attempt, apply]);

  useEffect(() => {
    if (!open || !pluginId || phase.kind !== 'show-code') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let interval = Math.max(1000, phase.intervalMs);
    // The last wait ends at the deadline, so an expired code is reported when it expires.
    const schedule = () => { timer = setTimeout(() => void tick(), Math.max(0, Math.min(interval, phase.expiresAt - Date.now()))); };
    const tick = async () => {
      if (Date.now() >= phase.expiresAt) { setPhase({ kind: 'failed', text: i18n._(EXPIRED) }); return; }
      try {
        const step = await api.pollPluginFlow(pluginId, phase.flowId, controller.signal);
        if (controller.signal.aborted) return;
        if (step.kind === 'slow_down') interval += 5000;
        else if (step.kind !== 'pending') { apply(step); return; }
      } catch (error) {
        if (controller.signal.aborted) return;
        setPhase({ kind: 'failed', text: error instanceof HttpError && error.code === 'INTEGRATION_FLOW_NOT_FOUND' ? i18n._(EXPIRED) : errorMessage(error, t`无法确认授权状态`) });
        return;
      }
      schedule();
    };
    schedule();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, pluginId, phase, apply]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent {...(phase.kind === 'show-code' ? {} : { 'aria-describedby': undefined })}>
        <DialogHeader>
          <DialogTitle>{action?.label}</DialogTitle>
          {/* Most actions are a sign-in, so its description and body keep their room while it starts. */}
          {(phase.kind === 'show-code' || phase.kind === 'starting') && <DialogDescription aria-hidden={phase.kind === 'starting' || undefined} className={phase.kind === 'starting' ? 'invisible' : undefined}><Trans>凭据保存在运行 Riffet 服务器的电脑上</Trans></DialogDescription>}
        </DialogHeader>
        <DialogBody className="flex flex-col items-center gap-3">
          {/* The spinner sits in the QR's box, then room for the code, the link and the waiting line. */}
          {phase.kind === 'starting' && <>
            <div className="flex size-44 items-center justify-center"><Spinner /></div>
            <p aria-hidden className="invisible font-mono text-sm">{'\u00a0'}</p>
            <p aria-hidden className="invisible text-xs">{'\u00a0'}</p>
            <p aria-hidden className="invisible text-xs">{'\u00a0'}</p>
          </>}
          {phase.kind === 'show-code' && <>
            {/* The server renders the SVG; it is a QR of the verification URL, not user content. */}
            {phase.qrSvg && <div className="size-44 rounded-lg bg-white p-2 [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: phase.qrSvg }} />}
            {phase.userCode && <p className="font-mono text-sm text-fg">{phase.userCode}</p>}
            <a className="text-xs text-accent underline" href={phase.verificationUri} target="_blank" rel="noreferrer"><Trans>在浏览器中打开授权页</Trans></a>
            <p className="inline-flex items-center gap-1.5 text-xs text-fg-3"><Spinner /><Trans>等待授权…</Trans></p>
          </>}
          {phase.kind === 'hint' && <>
            <p className="text-sm text-fg-2">{phase.text}</p>
            {phase.command && <p className="max-h-48 w-full select-all overflow-auto whitespace-pre-wrap break-all font-mono text-sm text-fg">{phase.command}</p>}
          </>}
          {phase.kind === 'failed' && <p role="alert" className="text-sm text-danger">{phase.text}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}><Trans>关闭</Trans></Button>
          {phase.kind === 'failed' && <Button variant="primary" onClick={() => setAttempt((value) => value + 1)}><Trans>重试</Trans></Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
