import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconQrCode } from '@/components/icons-base';
import { IconCopy, IconRefreshCw } from '@/components/icons';
import { PairingQrScanner } from '@/components/PairingQrScanner';
import { Button } from '@/components/ui/button';
import { Input, Spinner } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { api } from '@/lib/api';
import { copyWithToast } from '@/lib/files';
import { formatTime } from '@/lib/i18n/format';
import { isPairingCode, normalizePairingCode, openPairing, parsePairingQr, parseServerAddress } from '@/lib/pairing-qr';
import { errorMessage } from '@/lib/utils';

/** Address and one-use code of another Riffet server, typed, pasted as the pairing payload, or scanned. */
export function ConnectServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useLingui();
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  useEffect(() => { if (!open) { setAddress(''); setCode(''); } }, [open]);
  const origin = parseServerAddress(address);
  const ready = origin !== undefined && isPairingCode(code);
  const changeAddress = (value: string) => {
    const pasted = value.trimStart().startsWith('{') ? parsePairingQr(value) : undefined;
    if (pasted) { setAddress(pasted.origin); setCode(pasted.code); } else setAddress(value);
  };
  return <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <form onSubmit={(event) => { event.preventDefault(); if (ready) openPairing({ origin, code: normalizePairingCode(code) }); }}>
          <DialogHeader><DialogTitle><Trans>连接其他服务器</Trans></DialogTitle></DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <Input autoFocus aria-label={t`地址`} aria-invalid={address.trim() !== '' && !origin} placeholder="192.168.1.10:4337" className="font-mono max-md:h-11" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={address} onChange={(event) => changeAddress(event.target.value)} />
            <Input aria-label={t`配对码`} aria-invalid={code.trim() !== '' && !isPairingCode(code)} placeholder="ABCD2345" className="font-mono uppercase max-md:h-11" autoComplete="one-time-code" autoCapitalize="characters" autoCorrect="off" spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" className="max-md:h-11" onClick={() => setScannerOpen(true)}><IconQrCode className="size-4" /><Trans>扫码</Trans></Button>
            <Button type="submit" variant="primary" className="max-md:h-11" disabled={!ready}>{t({ message: '连接', context: 'settings-connect-action' })}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <PairingQrScanner open={scannerOpen} onOpenChange={setScannerOpen} />
  </>;
}

interface PairingCode { code: string; expiresAt: number; qr: string; baseUrl: string; localOnly: boolean }

/** A pairing QR for the server this browser is signed in to, so another device can join it. */
export function PairDeviceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useLingui();
  const [pairing, setPairing] = useState<PairingCode>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const generate = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const next = await api.pairingCode();
      setPairing(next);
      setExpired(next.expiresAt <= Date.now());
    } catch (reason) { setError(errorMessage(reason, t`无法生成配对码`)); }
    finally { setBusy(false); }
  }, [t]);
  useEffect(() => {
    if (!open) { setPairing(undefined); setError(''); return; }
    void generate();
  }, [open, generate]);
  useEffect(() => {
    if (!pairing || expired) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, pairing.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pairing, expired]);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle><Trans>配对新设备</Trans></DialogTitle></DialogHeader>
      <DialogBody className="flex flex-col items-center gap-3 pb-5">
        {error && <Notice tone="danger" className="w-full" action={<Button size="xs" disabled={busy} onClick={() => void generate()}><Trans>重试</Trans></Button>}>{error}</Notice>}
        {pairing ? <>
          <img alt={t`配对码`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qr)}`} className={`size-52 rounded-xl bg-white p-3 transition-opacity ${expired ? 'opacity-30' : ''}`} />
          <div className="flex items-center gap-1.5">
            <span className="select-all font-mono text-2xl font-semibold tracking-wider text-fg">{pairing.code}</span>
            <Button size="icon-sm" variant="quiet" aria-label={t`复制配对码`} onClick={() => void copyWithToast(pairing.code)}><IconCopy /></Button>
          </div>
          <span className="break-all text-center font-mono text-xs text-fg-2">{pairing.baseUrl}</span>
          <span role="status" className="text-xs text-fg-3">{expired ? t`已过期` : t`有效至 ${formatTime(new Date(pairing.expiresAt).toISOString())}`}</span>
          {pairing.localOnly && <Notice tone="warning" className="w-full"><Trans>服务器只监听本机，其他设备无法连接。</Trans></Notice>}
          <Button variant={expired ? 'primary' : 'secondary'} disabled={busy} onClick={() => void generate()}>{busy ? <Spinner className="text-current" /> : <IconRefreshCw />}<Trans>重新生成</Trans></Button>
        </> : !error && <Spinner className="my-16 size-5" />}
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
