import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { PushKeyStatus } from '@contracts';
import { Button } from '@/components/ui/button';
import { Input, StatusDot } from '@/components/ui/controls';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { api } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { errorMessage } from '@/lib/utils';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

/** Apple names the file `AuthKey_<Key ID>.p8`. */
const KEY_FILE = /AuthKey_([A-Z0-9]{10})\.p8$/i;

/** 推送: the APNs auth key this server sends iPhone notifications with (docs/DEVICES.md §3「后台推送」). */
export function PushKeySection() {
  const { t } = useLingui();
  const [status, setStatus] = useState<PushKeyStatus>();
  const [keyId, setKeyId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [file, setFile] = useState<{ name: string; text: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.pushKey(controller.signal).then(setStatus).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason, t`无法读取推送设置`)); });
    return () => controller.abort();
  }, []);

  const run = async (work: () => Promise<PushKeyStatus>, fallback: string) => {
    setBusy(true); setError('');
    try { setStatus(await work()); setFile(undefined); }
    catch (reason) { setError(errorMessage(reason, fallback)); }
    finally { setBusy(false); }
  };

  const pick = async (picked: File | undefined) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!picked) return;
    setFile({ name: picked.name, text: await picked.text() });
    const id = KEY_FILE.exec(picked.name)?.[1];
    if (id && !keyId.trim()) setKeyId(id.toUpperCase());
  };

  const remove = async () => {
    if (await confirmDialog({ title: t`移除推送密钥？`, description: t`iPhone 在后台将不再收到通知`, confirmLabel: t`移除`, destructive: true })) {
      await run(() => api.removePushKey(), t`无法移除推送密钥`);
    }
  };

  if (!status) return error ? <FeedbackNotice scope="push-key" message={error} tone="danger" /> : null;

  const ready = keyId.trim() && teamId.trim() && file;
  return <div className="flex flex-col gap-2">
    <FeedbackNotice scope="push-key" message={error} tone="danger" />
    <SettingsGroup title={t`推送`} note={<Trans>密钥只保存在这台服务器上</Trans>}>
      {status.configured
        ? <SettingsRow title="APNs" description={[`${status.keyId} · ${status.teamId}`, status.status === 'invalid' ? status.detail : ''].filter(Boolean).join(' · ')}>
          <div className="flex items-center gap-3">
            <StatusDot tone={status.status === 'invalid' ? 'danger' : 'success'} />
            <Button size="sm" variant="danger-ghost" disabled={busy} onClick={() => void remove()}><Trans>移除</Trans></Button>
          </div>
        </SettingsRow>
        : <div className="flex flex-wrap items-center gap-2 py-3.5">
          <Input aria-label="Key ID" placeholder="Key ID" className="h-8 w-32 font-mono max-md:h-11 max-md:flex-1" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={keyId} disabled={busy} onChange={(event) => setKeyId(event.target.value.toUpperCase())} />
          <Input aria-label="Team ID" placeholder="Team ID" className="h-8 w-32 font-mono max-md:h-11 max-md:flex-1" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={teamId} disabled={busy} onChange={(event) => setTeamId(event.target.value.toUpperCase())} />
          <input ref={fileInput} type="file" accept=".p8" hidden onChange={(event) => void pick(event.target.files?.[0])} />
          <Button disabled={busy} className="min-w-0 max-w-48 max-md:min-h-11" onClick={() => fileInput.current?.click()}>
            <span className="truncate">{file ? file.name : <Trans>选择 .p8 文件</Trans>}</span>
          </Button>
          <Button variant="primary" className="ml-auto max-md:min-h-11" disabled={busy || !ready} onClick={() => void run(() => api.savePushKey({ keyId: keyId.trim(), teamId: teamId.trim(), key: file!.text }), t`无法保存推送密钥`)}><Trans>保存</Trans></Button>
        </div>}
    </SettingsGroup>
  </div>;
}
