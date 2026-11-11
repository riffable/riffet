import { useEffect, useState } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { BuildInfo, UpdateCheck } from '@contracts';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { WEB_BUILD } from '@/lib/build-info';
import { SettingsGroup as Group, SettingsRow as Row } from './SettingsLayout';

function buildLabel(build: BuildInfo): string {
  return `${build.tag ?? i18n._(msg`${build.version} · 开发构建`)}${build.commit ? ` · ${build.commit.slice(0, 8)}` : ''}${build.dirty ? ` · ${i18n._(msg`有本地修改`)}` : ''}`;
}

const statusLabels: Record<UpdateCheck['status'], MessageDescriptor> = {
  available: msg`有新版本可用`, current: msg`已是最新发布版本`, ahead: msg`当前版本较新`,
  development: msg`当前是开发构建`, unavailable: msg`无法检查更新`,
  'no-releases': msg`尚无发布版本`, conflict: msg`发布 tag 冲突`,
};

export function UpdateSection() {
  const { t } = useLingui();
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void api.health().then((value) => { if (active) setHealth(value); })
      .catch(() => { if (active) setHealthFailed(true); });
    return () => { active = false; };
  }, []);
  const check = async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    setFailed(false);
    try { setResult(await api.checkForUpdates()); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  const serverBuild = result?.current ?? health?.build;
  const refreshNeeded = Boolean(WEB_BUILD.commit && serverBuild?.commit && WEB_BUILD.commit !== serverBuild.commit);
  const sourceUpdated = Boolean(result?.latest && result.source && !result.source.dirty && result.source.tag === result.latest.tag && result.source.commit !== result.current.commit);
  const updateCommand = health?.managedBy === 'app' ? 'riffet update --app' : 'riffet update';
  return <div className="flex flex-col gap-6">
    <Group>
      <Row title={t`Web 构建`}><span className="text-sm text-fg-2">{buildLabel(WEB_BUILD)}</span></Row>
      <Row title={t`Server 构建`}><span className="text-sm text-fg-2">{serverBuild ? buildLabel(serverBuild) : health ? t`${health.version} · 未记录发布版本` : healthFailed ? t({ message: '无法读取', context: 'settings-build-read-failed' }) : t`读取中…`}</span></Row>
      {refreshNeeded && <div className="flex items-center justify-between gap-3 py-3">
        <p className="text-xs text-fg-3"><Trans>当前页面与 Server 的构建不同，请刷新页面加载对应版本。</Trans></p>
        <Button size="xs" onClick={() => window.location.reload()}><Trans>刷新页面</Trans></Button>
      </div>}
    </Group>
    <Group title={t`更新`} action={<Button size="xs" disabled={busy} onClick={() => void check()}>{busy ? <Trans>检查中…</Trans> : <Trans>检查更新</Trans>}</Button>}>
      {result && <>
        <Row title={t`检查结果`} description={result.message}><span role="status" className="text-sm text-fg-2">{i18n._(statusLabels[result.status])}</span></Row>
        {result.latest && <Row title={t`最新发布`}><span className="font-mono text-xs text-fg-2">{result.latest.tag} · {result.latest.commit.slice(0, 8)}</span></Row>}
        {result.source && <Row title={t`本地源码`} description={sourceUpdated ? t`源码已切到最新发布，当前 Server 尚未使用该提交；请完成构建并重启。` : undefined}>
          <span className="text-xs text-fg-2">{result.source.tag ?? t`开发版本`}{result.source.commit ? ` · ${result.source.commit.slice(0, 8)}` : ''}{result.source.dirty ? ` · ${t`有本地修改`}` : ''}</span>
        </Row>}
      </>}
      {failed && <p role="alert" className="py-3 text-xs text-fg-3"><Trans>无法检查更新，请确认 Server 已连接且支持更新检查，然后重试。</Trans></p>}
      <Row title={t`终端更新命令`} description={health?.managedBy === 'app' ? t`先停止 App 托管的服务器并退出 App，再在终端执行。` : t`在服务器所在电脑的终端执行。`}>
        <code className="select-all text-xs text-fg-2">{updateCommand}</code>
      </Row>
    </Group>
  </div>;
}
