import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconQrCode } from '@/components/icons-base';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { openPairing, parsePairingQr } from '@/lib/pairing-qr';
import type { IScannerControls } from '@zxing/browser';

export function PairingQrScanner({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useLingui();
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls | undefined>(undefined);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [resume, setResume] = useState(0);
  const canStream = Boolean(navigator.mediaDevices?.getUserMedia);

  useEffect(() => {
    if (!open || !canStream) return;
    let disposed = false;
    let paused = false;
    let accepted = false;
    let stream: MediaStream | undefined;
    setStarting(true);
    setError('');
    const stop = () => {
      controls.current?.stop();
      controls.current = undefined;
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (video.current) video.current.srcObject = null;
    };
    const onVisibilityChange = () => {
      if (document.hidden) { paused = true; stop(); }
      else if (paused && !disposed && !accepted) setResume((value) => value + 1);
    };
    const onPageHide = () => { paused = true; stop(); };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    void import('@zxing/browser').then(async ({ BrowserQRCodeReader }) => {
      if (disposed || paused || !video.current) return;
      const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 250 });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (disposed || paused || !video.current) { stop(); return; }
      const scanner = await reader.decodeFromStream(stream, video.current, (result, _error, scannerControls) => {
        if (!result || disposed || paused || accepted) return;
        const pairing = parsePairingQr(result.getText());
        if (!pairing) { setError(t`二维码不是 Riffet 配对码`); return; }
        accepted = true;
        scannerControls?.stop();
        controls.current = undefined;
        openPairing(pairing);
      });
      if (disposed || paused || accepted) scanner.stop();
      else controls.current = scanner;
    }).catch(() => {
      if (!disposed && !paused) setError(t`无法使用相机，可拍摄二维码或选择图片`);
      stop();
    }).finally(() => { if (!disposed && !paused) setStarting(false); });
    return () => {
      disposed = true;
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stop();
    };
  }, [open, canStream, resume]);

  const fromImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setError('');
    try {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      const url = URL.createObjectURL(file);
      try {
        const result = await new BrowserQRCodeReader().decodeFromImageUrl(url);
        const pairing = parsePairingQr(result.getText());
        if (!pairing) { setError(t`二维码不是 Riffet 配对码`); return; }
        openPairing(pairing);
      } finally { URL.revokeObjectURL(url); }
    } catch { setError(t`未识别到配对二维码`); }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent aria-describedby={undefined} className="overflow-hidden">
      <DialogHeader><DialogTitle><Trans>扫描配对二维码</Trans></DialogTitle></DialogHeader>
      <DialogBody className="flex flex-col gap-3 pb-5">
        {canStream && <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-black">
          <video ref={video} muted playsInline className="h-full w-full object-cover" />
          {starting && <span className="absolute inset-x-0 bottom-3 text-center text-sm text-white"><Trans>正在打开相机…</Trans></span>}
        </div>}
        <div className="flex gap-2">
          <label className="relative inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border border-line-strong bg-elevated px-3 text-sm font-medium text-fg shadow-soft hover:bg-subtle can-hover:has-[:focus-visible]:ring-2 can-hover:has-[:focus-visible]:ring-focus">
            <input type="file" accept="image/*" capture="environment" onChange={(event) => void fromImage(event)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label={t`拍摄二维码`} />
            <IconQrCode className="size-4" /><Trans>拍摄二维码</Trans>
          </label>
          <label className="relative inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border border-line-strong bg-elevated px-3 text-sm font-medium text-fg shadow-soft hover:bg-subtle can-hover:has-[:focus-visible]:ring-2 can-hover:has-[:focus-visible]:ring-focus">
            <input type="file" accept="image/*" onChange={(event) => void fromImage(event)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label={t`选择图片`} />
            <Trans>选择图片</Trans>
          </label>
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
