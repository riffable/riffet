import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { BuildInfo, ReleaseNotes, UpdateCheck } from '@contracts';
import { IconExternalLink } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { api } from '@/lib/api';
import { WEB_BUILD } from '@/lib/build-info';
import { markUpdateSeen, setUpdateStatus, useAvailableUpdate } from '@/lib/update';
import { cn, timeAgo } from '@/lib/utils';
import { SettingsExternalLinkRow, SettingsGroup as Group, SettingsRow as Row } from './SettingsLayout';

const GITHUB_REPO_URL = 'https://github.com/riffable/riffet';

const Markdown = lazy(() => import('../session/Markdown').then((module) => ({ default: module.Markdown })));

function buildLabel(build: BuildInfo): string {
  return `${build.tag ?? i18n._(msg`${build.version} · 开发构建`)}${build.commit ? ` · ${build.commit.slice(0, 8)}` : ''}${build.dirty ? ` · ${i18n._(msg`有本地修改`)}` : ''}`;
}

const statusLabels: Record<UpdateCheck['status'], MessageDescriptor> = {
  available: msg`有新版本可用`, current: msg`已是最新发布版本`, ahead: msg`当前版本较新`,
  development: msg`当前是开发构建`, unavailable: msg`无法检查更新`,
  'no-releases': msg`尚无发布版本`, conflict: msg`发布 tag 冲突`,
};

/** CHANGELOG section headings sit under the version heading here, so they read as bold lines, not larger titles. */
const flattenHeadings = (markdown: string) => markdown.replace(/^#{1,6}\s+(.+)$/gm, '**$1**');

/** The CHANGELOG sections between the running build and the available release, and the code comparison. */
function WhatsNew({ version }: { version: string }) {
  const { i18n: active } = useLingui();
  const [notes, setNotes] = useState<ReleaseNotes | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    void api.releaseNotes(active.locale).then((value) => { if (live) setNotes(value); }).catch(() => { if (live) setNotes({ notes: [], compareUrl: null }); });
    return () => { live = false; };
  }, [active.locale, version]);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [notes, expanded]);
  if (!notes) return <p className="py-3 text-xs text-fg-3"><Trans>正在读取更新内容…</Trans></p>;
  if (!notes.notes.length && !notes.compareUrl) return null;
  return <div className="flex flex-col gap-2 py-3">
    <div ref={body} className={cn('flex flex-col gap-4', !expanded && 'max-h-72 overflow-hidden')}>
      {notes.notes.map((note) => <article key={note.version} className="flex flex-col gap-1">
        <h4 className="text-sm font-semibold text-fg">{note.version}{note.date && <span className="ml-2 font-normal text-fg-3">{note.date}</span>}</h4>
        <Suspense fallback={null}><Markdown text={flattenHeadings(note.markdown)} className="text-sm text-fg-2" /></Suspense>
      </article>)}
    </div>
    <div className="flex items-center gap-4">
      {(overflows || expanded) && <Button variant="link" size="xs" className="px-0" onClick={() => setExpanded((value) => !value)}>{expanded ? <Trans>收起</Trans> : <Trans>显示全部</Trans>}</Button>}
      {notes.compareUrl && <Button asChild variant="link" size="xs" className="px-0">
        <a href={notes.compareUrl} target="_blank" rel="noreferrer"><Trans>在 GitHub 比较代码</Trans><IconExternalLink /></a>
      </Button>}
    </div>
  </div>;
}

export function UpdateSection() {
  const { t } = useLingui();
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const { version: available, status: cached } = useAvailableUpdate();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const result = cached;
  useEffect(() => {
    let active = true;
    void api.health().then((value) => { if (active) setHealth(value); })
      .catch(() => { if (active) setHealthFailed(true); });
    return () => { active = false; };
  }, []);
  // Shown here, the version no longer needs the sidebar's full notice.
  useEffect(() => { if (available) markUpdateSeen(available); }, [available]);
  const check = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try { setUpdateStatus(await api.checkForUpdates()); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  const serverBuild = result?.current ?? health?.build;
  const refreshNeeded = Boolean(WEB_BUILD.commit && serverBuild?.commit && WEB_BUILD.commit !== serverBuild.commit);
  const sourceUpdated = Boolean(result?.latest && result.source && !result.source.dirty && result.source.tag === result.latest.tag && result.source.commit !== result.current.commit);
  const updateCommand = health?.managedBy === 'app' ? 'riffet update --app' : 'riffet update';
  const checkedAt = result?.checkedAt ? timeAgo(result.checkedAt) : '';
  return <div className="flex flex-col gap-6">
    <Group>
      <Row title={t`Web 构建`}><span className="text-sm text-fg-2">{buildLabel(WEB_BUILD)}</span></Row>
      <Row title={t`Server 构建`}><span className="text-sm text-fg-2">{serverBuild ? buildLabel(serverBuild) : health ? t`${health.version} · 未记录发布版本` : healthFailed ? t({ message: '无法读取', context: 'settings-build-read-failed' }) : t`读取中…`}</span></Row>
      {refreshNeeded && <div className="flex items-center justify-between gap-3 py-3">
        <p className="text-xs text-fg-3"><Trans>当前页面与 Server 的构建不同，请刷新页面加载对应版本。</Trans></p>
        <Button size="xs" onClick={() => window.location.reload()}><Trans>刷新页面</Trans></Button>
      </div>}
    </Group>
    <Group title={t`更新`} action={<Button size="xs" busy={busy} onClick={() => void check()}><Trans>检查更新</Trans></Button>}>
      {available && <>
        <Row title={t`新版本 ${available}`} description={serverBuild ? t`当前 ${serverBuild.tag ?? serverBuild.version}` : undefined}>
          <span role="status" className="text-xs text-fg-3">{checkedAt ? t`检查于${checkedAt}` : i18n._(statusLabels.available)}</span>
        </Row>
        <WhatsNew version={available} />
      </>}
      {result && !available && <Row title={t`检查结果`} description={result.status === 'unavailable' || result.status === 'conflict' ? result.message : checkedAt ? t`检查于${checkedAt}` : undefined}>
        <span role="status" className="text-sm text-fg-2">{i18n._(statusLabels[result.status])}</span>
      </Row>}
      {result?.source && <Row title={t`本地源码`} description={sourceUpdated ? t`源码已切到最新发布，当前 Server 尚未使用该提交；请完成构建并重启。` : undefined}>
        <span className="text-xs text-fg-2">{result.source.tag ?? t`开发版本`}{result.source.commit ? ` · ${result.source.commit.slice(0, 8)}` : ''}{result.source.dirty ? ` · ${t`有本地修改`}` : ''}</span>
      </Row>}
      {failed && <p role="alert" className="py-3 text-xs text-fg-3"><Trans>无法检查更新，请确认 Server 已连接且支持更新检查，然后重试。</Trans></p>}
      <Row title={t`终端更新命令`} description={health?.managedBy === 'app' ? t`先停止 App 托管的服务器并退出 App，再在终端执行。` : t`在服务器所在电脑的终端执行。`}>
        <span className="flex items-center gap-1"><code className="select-all text-xs text-fg-2">{updateCommand}</code><CopyButton text={updateCommand} size="xs" /></span>
      </Row>
    </Group>
    <Group>
      <SettingsExternalLinkRow title="GitHub" value="riffable/riffet" href={GITHUB_REPO_URL} />
    </Group>
  </div>;
}
