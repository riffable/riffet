import { useEffect, useState, useSyncExternalStore } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AppSettings, MachineReport } from '@contracts';
import { IconCircleAlert, IconDownload, IconHardDriveDownload, IconRefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { browserDiagnosticsReport, browserDiagnosticsStatus, clearBrowserDiagnostics, startBrowserDiagnostics, stopBrowserDiagnostics, subscribeBrowserDiagnostics } from '@/lib/browser-diagnostics';
import { toast } from '@/lib/toast';
import { downloadJson, errorMessage, formatDateTime } from '@/lib/utils';
import { SettingsGroup as Group, SettingsRow as Row } from './SettingsLayout';

export function DiagnosticsSection({ settings }: { settings: AppSettings }) {
  const { t } = useLingui();
  const [machine, setMachine] = useState<MachineReport>();
  const [checking, setChecking] = useState(true);
  const { recording, count } = useSyncExternalStore(subscribeBrowserDiagnostics, browserDiagnosticsStatus);
  const [sending, setSending] = useState(false);
  /** What the machine offers every Agent; `loud` is the user's own request, which tells them when it fails. */
  const check = async (loud: boolean) => {
    setChecking(true);
    try { setMachine(await api.machine()); }
    catch (error) { if (loud) toast.error(errorMessage(error, t`无法检测运行环境`)); }
    finally { setChecking(false); }
  };
  useEffect(() => { void check(false); }, []);
  const send = async () => {
    if (sending || !count) return;
    setSending(true);
    try {
      await api.uploadClientLog('web-navigation', browserDiagnosticsReport());
      toast.success(t`诊断已发送到当前服务器`);
    } catch (error) {
      toast.error(errorMessage(error, t`发送诊断失败`));
    } finally {
      setSending(false);
    }
  };
  return <div className="flex flex-col gap-6">
    <Group title={t`诊断信息`}>
      <Row title={t`导出诊断信息`} description={t`包含运行环境与设置，API Key 不包含在内。`}><Button size="sm" onClick={() => downloadJson('riffet-diagnostics.json', { checkedAt: new Date().toISOString(), machine, settings })}><IconDownload /><Trans>导出</Trans></Button></Row>
    </Group>
    <Group title={t`本机环境`} action={<Button size="xs" variant="ghost" onClick={() => void check(true)} busy={checking}><IconRefreshCw /><Trans>重新检测</Trans></Button>}>
      {machine ? <>
        <Row title="tmux"><span className="text-sm text-fg-2">{machine.tmux ? t`可用` : t`未安装`}</span></Row>
        <Row title="Tailscale"><span className="text-sm text-fg-2">{machine.tailscale.present ? machine.tailscale.message : t`未检测到`}</span></Row>
        <Row title={t`检测时间`}><span className="text-xs text-fg-3">{formatDateTime(machine.checkedAt)}</span></Row>
      </> : !checking && <p className="py-4 text-xs text-fg-3"><Trans>尚未检测到运行环境。</Trans></p>}
    </Group>
    {machine && machine.warnings.length > 0 && <div className="flex flex-col gap-2">
      {machine.warnings.map((warning, index) => <p key={index} className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning"><IconCircleAlert className="mt-px size-3.5 shrink-0" />{warning}</p>)}
    </div>}
    <Group title={t`网页交互诊断`}>
      <Row title={t`记录浏览器交互`} description={t`记录浏览器版本、页面加载和历史记录操作，不包含聊天内容、输入内容或令牌。`}>
        <div className="flex flex-col items-start gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-fg-3"><StatusDot tone={recording ? 'accent' : 'idle'} pulse={recording} />{recording ? <Trans>记录中</Trans> : <Trans>已停止</Trans>} · <Trans>{count} 条</Trans></span>
          <Button size="sm" onClick={recording ? stopBrowserDiagnostics : startBrowserDiagnostics}>{recording ? <Trans>停止记录</Trans> : <Trans>开始记录</Trans>}</Button>
        </div>
      </Row>
      <Row title={t`诊断记录`} description={t`发送到当前服务器。发送后记录仍会保留。`}>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!count} busy={sending} onClick={() => void send()}><Trans>发送诊断</Trans></Button>
          <Button size="sm" variant="ghost" disabled={sending || !count} onClick={clearBrowserDiagnostics}><Trans>清除</Trans></Button>
        </div>
      </Row>
    </Group>
  </div>;
}

export function BackupSection({ onError }: { onError: (message: string) => void }) {
  const { t } = useLingui();
  const [result, setResult] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try { setResult(await api.backup()); toast.success(t`备份已完成`); }
    catch (error) { onError(errorMessage(error, t`备份失败`)); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-col gap-6">
    <Group title={t`工作台备份`}>
      <Row title={t`创建备份`} description={t`备份包含凭证，请保存在可信位置。`}><Button size="sm" onClick={() => void create()} busy={busy}><IconHardDriveDownload /><Trans>创建备份</Trans></Button></Row>
      <p className="py-2 text-xs text-fg-3"><Trans>备份不包含项目与任务目录中的工作文件。</Trans></p>
      {result !== undefined && <pre className="max-h-48 overflow-auto py-3 font-mono text-xs text-fg-2">{JSON.stringify(result, null, 2)}</pre>}
    </Group>
    <Group title={t`恢复备份`}>
      <div className="flex flex-col gap-2 py-3 text-xs text-fg-3">
        <p><Trans>在服务器电脑上执行恢复命令，指定备份目录和空的目标状态目录：</Trans></p>
        <code className="overflow-x-auto rounded-lg bg-subtle p-3 font-mono text-xs text-fg-2">node dist/cli.js restore --backup /absolute/backup/directory --state-dir /absolute/empty/state</code>
        <p><Trans>恢复完成后，使用目标状态目录启动 Riffet。</Trans></p>
      </div>
    </Group>
  </div>;
}
