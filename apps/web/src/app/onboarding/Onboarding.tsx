import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { DeviceInfo, NativeBackendCatalogEntry, NativeBackendId } from '@contracts';
import { IconArrowLeft, IconCircleCheck, IconFolder } from '@/components/icons';
import { AgentLogo } from '@/components/AgentLogo';
import { LiveBrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/button';
import { ChoiceCards } from '@/components/ui/choice-card';
import { CopyButton } from '@/components/ui/copy-button';
import { Spinner } from '@/components/ui/controls';
import { api, type ProjectRecord } from '@/lib/api';
import { agentMarkStyle, useBackendLabel } from '@/lib/backends';
import { regularProjects } from '@/lib/project-family';
import { hostInfo } from '@/lib/platform';
import { cn, errorMessage, tildePath } from '@/lib/utils';
import { DirectoryPicker } from '../DirectoryPicker';
import { canAskNotifications, saveNotifications } from '../settings/notifications';
import { useCatalog, useLists, useNav, useSettings, useStores } from '../state/stores';

type Page = 'welcome' | 'agent' | 'project' | 'notify' | 'phone';
const ORDER: Page[] = ['welcome', 'agent', 'project', 'notify', 'phone'];

/** The Agents with a stable one-line install; the server says whether an Agent runs, not how to get it. */
const INSTALLS: Array<{ id: NativeBackendId; command: string }> = [
  { id: 'claude', command: 'npm install -g @anthropic-ai/claude-code' },
  { id: 'codex', command: 'npm install -g @openai/codex' },
];

const pickable = (backends: NativeBackendCatalogEntry[]) => backends.filter((entry) => entry.backendId !== 'chat');
const usable = (entry: NativeBackendCatalogEntry) => entry.available && !entry.needsLogin;

interface Pairing { code: string; expiresAt: number; qr: string }

/**
 * The first-run guide on the web: the whole window, one decision per page (patterns §1.5). The page
 * comes from the server, so there is no server to pick: welcome, Agent, project, notifications, phone. A page is
 * there only while it asks for something; finishing or skipping lands on the new-session page with
 * whatever was decided.
 */
export function Onboarding({ loadBootstrap, onSelectProject, onSelectNoProject, onFinish }: {
  loadBootstrap: () => Promise<unknown>;
  onSelectProject: (project: ProjectRecord) => void;
  onSelectNoProject: () => void;
  onFinish: () => void;
}) {
  const { t } = useLingui();
  const { catalog, settings: settingsStore } = useStores();
  const backends = useCatalog((state) => state.backends);
  const backendsRead = useCatalog((state) => state.revision > 0);
  const defaultBackendId = useSettings((value) => value.defaultBackendId);
  const projects = useLists((state) => state.projects);
  const projectlessTasks = useLists((state) => state.projectlessTasks);
  const taskProjectId = useNav((state) => state.taskProjectId);

  const [page, setPage] = useState<Page>('welcome');
  const [forward, setForward] = useState(true);

  // Agent: a page only when there is something to decide, several to pick from or none to run.
  const agents = pickable(backends);
  const runnable = agents.filter(usable);
  const agentNeeded = !backendsRead || runnable.length !== 1;
  const [agent, setAgent] = useState<NativeBackendId>();
  const [rechecking, setRechecking] = useState(false);
  const chosenAgent = agent && runnable.some((entry) => entry.backendId === agent) ? agent
    : runnable.find((entry) => entry.backendId === defaultBackendId)?.backendId ?? runnable[0]?.backendId;
  // The one Agent found skips its page, and is still made the server's default when it has none.
  const onlyAgent = backendsRead && runnable.length === 1 ? runnable[0]!.backendId : undefined;
  useEffect(() => {
    if (onlyAgent && !defaultBackendId) void settingsStore.updateBackendDefaults(onlyAgent, (current) => current ?? {}, { defaultBackendId: onlyAgent }).catch(() => undefined);
  }, [onlyAgent, defaultBackendId, settingsStore]);

  // Project: the server's only project, or the one this browser last started in, is picked already.
  const regular = regularProjects(projects).filter((item) => !item.archivedAt);
  const [directory, setDirectory] = useState<ProjectRecord | undefined>(() => regular.find((item) => item.id === taskProjectId) ?? (regular.length === 1 ? regular[0] : undefined));
  const [projectError, setProjectError] = useState('');
  const [opening, setOpening] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  // Phone: only on a server that a phone can reach; the code is asked for up front so the page count is right.
  const [pairing, setPairing] = useState<Pairing>();
  const [phoneNeeded, setPhoneNeeded] = useState(true);
  const [paired, setPaired] = useState<DeviceInfo>();
  const baseline = useRef<Set<string> | undefined>(undefined);
  const preparePairing = useCallback(async () => {
    try {
      const next = await api.pairingCode();
      if (next.localOnly) { setPhoneNeeded(false); return; }
      setPairing(next);
      // The phones already paired: only one not among them is the one that took this code. Unread, the first poll sets it.
      if (!baseline.current) { const known = await api.devices().catch(() => undefined); if (known) baseline.current = new Set(known.devices.map((device) => device.id)); }
    } catch { setPhoneNeeded(false); }
  }, []);
  useEffect(() => { void preparePairing(); }, [preparePairing]);

  // Notifications: a page only while this browser can still be asked; read once so asking does not remove the page.
  const [notifyNeeded] = useState(canAskNotifications);
  const [asking, setAsking] = useState(false);
  const allowNotifications = async () => {
    if (asking) return;
    setAsking(true);
    try {
      const saved = await saveNotifications(true);
      settingsStore.applySaved(saved.settings, saved.patch);
    } catch { /* Refused or unsaved: the settings page says why and can try again. */ }
    finally { setAsking(false); advance('notify'); }
  };

  const needed = (candidate: Page) => candidate === 'agent' ? agentNeeded : candidate === 'notify' ? notifyNeeded : candidate === 'phone' ? phoneNeeded : true;
  // The page in view stays in the list, so deciding something on it never moves the reader.
  const pages = ORDER.filter((candidate) => candidate === page || needed(candidate));
  const index = Math.max(0, pages.indexOf(page));

  const advance = (from: Page) => {
    if (from !== page) return;
    const next = ORDER.slice(ORDER.indexOf(from) + 1).find(needed);
    if (!next) { onFinish(); return; }
    setForward(true);
    setPage(next);
  };
  const back = () => {
    if (index <= 1) return;
    setForward(false);
    setPage(pages[index - 1]!);
  };

  const saveAgent = async () => {
    // Written even when it is the server's default already: the write is also what moves this browser's new-session agent to it.
    if (chosenAgent) await settingsStore.updateBackendDefaults(chosenAgent, (current) => current ?? {}, { defaultBackendId: chosenAgent }).catch(() => undefined);
    advance('agent');
  };
  const recheck = async () => {
    setRechecking(true);
    try { await catalog.refreshBackends(); } finally { setRechecking(false); }
  };
  // Found on a recheck: the page has nothing left to decide when only one turned up.
  useEffect(() => { if (page === 'agent' && onlyAgent && !rechecking) advance('agent'); });

  const openDirectory = async (path: string) => {
    setOpening(true);
    setProjectError('');
    try {
      let target = await api.createProject({ cwd: path });
      if (target.archivedAt) target = await api.updateProject(target.id, { archived: false });
      await loadBootstrap();
      setDirectory(target);
    } catch (error) { setProjectError(errorMessage(error, t`无法使用该目录`)); }
    finally { setOpening(false); }
  };
  /** The server's own folder chooser when this browser is on that computer; the in-app browser otherwise. */
  const chooseDirectory = async () => {
    if (opening) return;
    if (!hostInfo().local) { setBrowsing(true); return; }
    try {
      const picked = await api.pickDirectory({ prompt: t`选择项目目录` });
      if (picked.cancelled) return;
      if (picked.path) { await openDirectory(picked.path); return; }
    } catch { /* A host without a chooser to drive: the in-app browser below. */ }
    setBrowsing(true);
  };
  const continueProject = () => { if (directory) { onSelectProject(directory); advance('project'); } };
  const skipProject = () => { if (projectlessTasks) onSelectNoProject(); advance('project'); };

  // While the phone page is up: a new phone among the devices, and a fresh code before this one lapses.
  useEffect(() => {
    if (page !== 'phone' || paired) return;
    const timer = window.setInterval(() => {
      void api.devices().then(({ devices }) => {
        if (!baseline.current) { baseline.current = new Set(devices.map((device) => device.id)); return; }
        const found = devices.find((device) => !baseline.current?.has(device.id) && (device.platform === 'ios' || device.platform === 'android'));
        if (found) setPaired(found);
      }).catch(() => undefined);
      if (pairing && Date.now() > pairing.expiresAt - 15_000) void preparePairing();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [page, paired, pairing, preparePairing]);
  // Nothing to scan on this server after all: the page would only wait.
  useEffect(() => { if (page === 'phone' && !phoneNeeded) onFinish(); }, [page, phoneNeeded, onFinish]);

  const primary = useRef<() => void>(undefined);
  // Return runs the page's main button, except where it already means something (a field, a button, a dialog).
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target : undefined;
      if (target?.closest('input, textarea, select, a, [role="dialog"]') || (target?.closest('button') && target.getAttribute('role') !== 'radio')) return;
      if (!primary.current) return;
      event.preventDefault();
      primary.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const body = (() => {
    switch (page) {
      case 'welcome': {
        primary.current = () => advance('welcome');
        return <WelcomePage onStart={() => advance('welcome')} />;
      }
      case 'agent': {
        if (!backendsRead) { primary.current = undefined; return <div className="grid h-40 place-items-center"><Spinner className="size-5" /></div>; }
        if (runnable.length > 1) {
          primary.current = () => void saveAgent();
          return <AgentChoicePage agents={agents} value={chosenAgent} onChange={setAgent} onContinue={() => void saveAgent()} />;
        }
        primary.current = () => void recheck();
        return <AgentMissingPage agents={agents} rechecking={rechecking} onRecheck={() => void recheck()} />;
      }
      case 'project': {
        primary.current = directory ? continueProject : undefined;
        return <>
          <ProjectPage path={directory?.cwd} opening={opening} error={projectError} onChoose={() => void chooseDirectory()} onSkip={skipProject} onContinue={continueProject} />
          <DirectoryPicker open={browsing} onOpenChange={setBrowsing} initialPath={directory?.cwd} onPick={(path) => void openDirectory(path)} onError={setProjectError} />
        </>;
      }
      case 'notify': {
        primary.current = () => void allowNotifications();
        return <NotifyPage asking={asking} onAllow={() => void allowNotifications()} onLater={() => advance('notify')} />;
      }
      case 'phone': {
        primary.current = paired ? onFinish : undefined;
        return <PhonePage pairing={pairing} paired={paired} onLater={onFinish} onDone={onFinish} />;
      }
    }
  })();

  return (
    <OnboardingFrame
      segments={pages.length - 1}
      index={index}
      onBack={index > 1 ? back : undefined}
      onSkip={onFinish}
    >
      <div key={page} className={cn('animate-in fade-in-0 duration-[var(--duration-medium)] ease-[var(--ease-decelerate)]', forward ? 'slide-in-from-right-4' : 'slide-in-from-left-4')}>
        {body}
      </div>
    </OnboardingFrame>
  );
}

/** The guide's window: back, progress and skip along the top, one centred column under them. */
export function OnboardingFrame({ segments, index, onBack, onSkip, className, children }: {
  segments: number;
  /** The page in view; 0 is the welcome page, which the progress does not count. */
  index: number;
  onBack?: (() => void) | undefined;
  onSkip: () => void;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <main className={cn('flex h-dvh flex-col bg-bg text-fg', className)}>
      <div className="grid h-13 shrink-0 grid-cols-[1fr_auto_1fr] items-center px-3">
        <div>{onBack && <Button variant="quiet" size="icon-sm" aria-label={t`返回`} onClick={onBack}><IconArrowLeft /></Button>}</div>
        <div aria-hidden className={cn('flex gap-1.5 transition-opacity duration-[var(--duration-base)]', index === 0 && 'opacity-0')}>
          {Array.from({ length: segments }, (_, n) => <span key={n} className={cn('h-0.75 w-6 rounded-full transition-colors duration-[var(--duration-base)]', n < index ? 'bg-primary' : 'bg-line-strong')} />)}
        </div>
        <div className="flex justify-end"><Button variant="quiet" size="sm" onClick={onSkip}><Trans>跳过</Trans></Button></div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5">
        <div className={cn('mx-auto w-full max-w-110 pb-16', index === 0 ? 'pt-[18vh]' : 'pt-[13vh]')}>{children}</div>
      </div>
    </main>
  );
}

/** A page's column: the title, one line under it, the content, then the buttons. */
export function OnboardingColumn({ title, subtitle, foot, children }: { title: ReactNode; subtitle: ReactNode; foot: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
      <p className="mt-2 text-sm text-fg-3">{subtitle}</p>
      <div className="mt-7 flex flex-col gap-2">{children}</div>
      {/* Held at the window's bottom when a long list scrolls, so Continue stays in reach; 28 above it either way. */}
      <div className="sticky bottom-0 mt-3 flex gap-2 bg-bg pb-5 pt-4">{foot}</div>
    </div>
  );
}

/** The page's main button: full width, 40 high, with the dimmed return glyph that says Return runs it. */
export function PrimaryAction({ children, busy, disabled, onClick }: { children: ReactNode; busy?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <Button variant="primary" size="lg" className="h-10 flex-1 rounded-xl text-sm" busy={busy} disabled={disabled} onClick={onClick}>
      {children}{!busy && <span aria-hidden className="text-primary-fg/50">↩</span>}
    </Button>
  );
}

export function WelcomePage({ onStart }: { onStart: () => void }) {
  // The lines follow the mark once it is drawn; with reduced motion they are there at once.
  const [shown, setShown] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (shown) return;
    const timer = window.setTimeout(() => setShown(true), 1900);
    return () => window.clearTimeout(timer);
  }, [shown]);
  const reveal = (delay: string) => cn('transition-[opacity,translate] duration-[var(--duration-slow)] ease-[var(--ease-decelerate)]', delay, shown ? 'opacity-100' : 'translate-y-1 opacity-0');
  return (
    <div className="flex flex-col items-center text-center">
      <LiveBrandMark once className="size-22 text-fg" />
      <p className={cn('mt-8 text-2xl font-semibold tracking-tight text-fg', reveal('delay-0'))}>Riffet</p>
      <p className={cn('mt-2 text-sm text-balance text-fg-3', reveal('delay-150'))}><Trans>在电脑上运行编程 Agent，在任何设备上查看和接手</Trans></p>
      <div className={cn('mt-7 flex w-60', reveal('delay-300'))}>
        <PrimaryAction onClick={onStart}><Trans>开始</Trans></PrimaryAction>
      </div>
    </div>
  );
}

export function AgentChoicePage({ agents, value, onChange, onContinue }: { agents: NativeBackendCatalogEntry[]; value: NativeBackendId | undefined; onChange: (value: NativeBackendId) => void; onContinue: () => void }) {
  const { t } = useLingui();
  const label = useBackendLabel();
  const options = useMemo(() => agents.map((entry) => ({
    value: entry.backendId,
    label: label(entry.backendId),
    // Only what keeps a card from being picked: on every other card a line would only repeat 可用.
    ...(usable(entry) ? {} : { description: entry.needsLogin ? t`未登录` : entry.reason?.trim() || t`未安装` }),
    tile: <AgentLogo backend={entry.backendId} size={20} style={agentMarkStyle(entry.backendId)} />,
    disabled: !usable(entry),
  })), [agents, label, t]);
  return (
    <OnboardingColumn title={t`默认用哪个 Agent`} subtitle={t`新建会话时可以换`}
      foot={<PrimaryAction onClick={onContinue}><Trans>继续</Trans></PrimaryAction>}>
      <ChoiceCards ariaLabel={t`默认 Agent`} value={value ?? ''} onValueChange={(next) => onChange(next as NativeBackendId)} options={options} />
    </OnboardingColumn>
  );
}

export function AgentMissingPage({ agents, rechecking, onRecheck }: { agents: NativeBackendCatalogEntry[]; rechecking: boolean; onRecheck: () => void }) {
  const { t } = useLingui();
  const label = useBackendLabel();
  const missing = new Set(agents.filter((entry) => !entry.available).map((entry) => entry.backendId));
  const wanted = INSTALLS.filter((row) => missing.has(row.id));
  const rows = wanted.length ? wanted : INSTALLS;
  return (
    <OnboardingColumn title={t`还没有可用的 Agent`}
      subtitle={hostInfo().local ? t`Riffet 调用这台电脑上安装的 CLI，装好任意一个即可` : t`Riffet 调用服务器上安装的 CLI，装好任意一个即可`}
      foot={<PrimaryAction busy={rechecking} onClick={onRecheck}><Trans>重新检测</Trans></PrimaryAction>}>
      <div className="flex flex-col rounded-xl p-1 ring-1 ring-line ring-inset">
        {rows.map((row) => (
          <div key={row.id} className="flex h-9 items-center gap-3 pl-2 pr-1">
            <span className="flex w-31 shrink-0 items-center gap-2 text-sm text-fg">
              <AgentLogo backend={row.id} size={14} style={agentMarkStyle(row.id)} />
              <span className="truncate">{label(row.id)}</span>
            </span>
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-3 select-all">{row.command}</code>
            <CopyButton text={row.command} size="xs" />
          </div>
        ))}
      </div>
    </OnboardingColumn>
  );
}

export function ProjectPage({ path, opening, error, onChoose, onSkip, onContinue }: { path: string | undefined; opening: boolean; error?: string; onChoose: () => void; onSkip: () => void; onContinue: () => void }) {
  const { t } = useLingui();
  return (
    <OnboardingColumn title={t`从哪个目录开始`} subtitle={t`Agent 会在所选目录里读写文件`}
      foot={<>
        <Button variant="ghost" size="lg" className="h-10 rounded-xl" disabled={opening} onClick={onSkip}><Trans>先不选</Trans></Button>
        <PrimaryAction disabled={!path || opening} onClick={onContinue}><Trans>继续</Trans></PrimaryAction>
      </>}>
      <button type="button" onClick={onChoose} disabled={opening}
        className="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left outline-none ring-1 ring-line ring-inset transition-colors duration-[var(--duration-fast)] hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus">
        {opening ? <Spinner className="size-4 text-fg-3" /> : <IconFolder className="size-4 shrink-0 text-fg-2" />}
        {path
          ? <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg" dir="rtl"><bdi>{tildePath(path)}</bdi></span>
          : <span className="min-w-0 flex-1 truncate text-sm text-fg-3"><Trans>选择目录…</Trans></span>}
      </button>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </OnboardingColumn>
  );
}

export function NotifyPage({ asking, onAllow, onLater }: { asking: boolean; onAllow: () => void; onLater: () => void }) {
  const { t } = useLingui();
  return (
    <OnboardingColumn title={t`需要你时通知你`} subtitle={t`Agent 等待审批、提问或完成时`}
      foot={<>
        <Button variant="ghost" size="lg" className="h-10 rounded-xl" disabled={asking} onClick={onLater}><Trans>以后再说</Trans></Button>
        <PrimaryAction busy={asking} onClick={onAllow}><Trans>允许通知</Trans></PrimaryAction>
      </>}>
      {null}
    </OnboardingColumn>
  );
}

export function PhonePage({ pairing, paired, onLater, onDone }: { pairing: Pairing | undefined; paired: DeviceInfo | undefined; onLater: () => void; onDone: () => void }) {
  const { t } = useLingui();
  return (
    <OnboardingColumn title={t`在手机上接着看`} subtitle={t`用手机上的 Riffet 扫码，离开电脑也能处理审批`}
      foot={paired
        ? <PrimaryAction onClick={onDone}><Trans>完成</Trans></PrimaryAction>
        : <Button variant="ghost" size="lg" className="h-10 flex-1 rounded-xl" onClick={onLater}><Trans>以后再说</Trans></Button>}>
      <div className="flex flex-col items-center gap-3">
        <div className="grid size-52 place-items-center rounded-2xl bg-white p-4 ring-1 ring-line-soft">
          {pairing
            ? <img alt={t`配对码`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qr)}`} className="size-full" />
            : <Spinner className="size-5 text-fg-4" />}
        </div>
        {paired ? <>
          <span role="status" className="flex items-center gap-1.5 text-sm text-fg"><IconCircleCheck className="size-4" /><Trans>{paired.name} 已连接</Trans></span>
          {paired.allowControl && <span className="text-center text-xs text-fg-3"><Trans>在「技能与工具」里可以让 Agent 操作这台手机</Trans></span>}
        </> : (
          <span role="status" className="flex items-center gap-2 text-sm text-fg-3"><Spinner className="size-3.5" /><Trans>等待扫码</Trans></span>
        )}
      </div>
    </OnboardingColumn>
  );
}
