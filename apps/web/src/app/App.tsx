import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowRight } from '@/components/icons';
import { IconQrCode } from '@/components/icons-base';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/controls';
import { DialogHost, Toaster } from '@/components/ui/overlays';
import { TooltipProvider } from '@/components/ui/tooltip';
import { BrandMark, LiveBrandMark } from '@/components/BrandMark';
import { PairingQrScanner } from '@/components/PairingQrScanner';
import { api, HttpError, isUnreachable, onUnauthenticated, setCsrfToken, type AuthLogin, type AuthStatus } from '@/lib/api';
import { toast } from '@/lib/toast';
import { clearTranscripts } from '@/lib/transcript-store';
import { clearNativeOutbox } from '@/lib/native-outbox-storage';
import { clearCachedPlugins } from '@/lib/plugins';
import { clearCaches } from '@/lib/cache-registry';
import { clearCachedLists, loadCachedLists } from '@/lib/list-cache';
import { errorMessage } from '@/lib/utils';
import { startOverlayNavigation } from '@/lib/overlay-navigation';

/**
 * Requested as soon as this module runs, so the workbench chunk downloads while the sign-in status
 * is being checked instead of after it. The rejection is the lazy view's to report, not this one's.
 */
const workbenchChunk = import('./Workbench');
workbenchChunk.catch(() => undefined);
const Workbench = lazy(() => workbenchChunk.then((module) => ({ default: module.Workbench })));

/** What a page shows while the workbench is not there yet; the workbench's own loading state looks the same. */
function Splash() {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
      <LiveBrandMark fixed="run" className="size-12 text-fg" />
    </main>
  );
}

/** A failed sign-in step: a server sentence, or our own message, which is worded where it is shown. */
type SignInFailure = { message: MessageDescriptor } | { text: string };

/** A failed sign-in step, said in the app's words: a browser's own network error text is not. */
function signInError(reason: unknown, fallback: MessageDescriptor): SignInFailure {
  if (isUnreachable(reason)) return { message: msg`无法连接 Riffet 服务器` };
  const text = errorMessage(reason, '');
  return text ? { text } : { message: fallback };
}

/** Everything this browser keeps of the signed-in user's conversations. */
function forgetLocalData() {
  void clearTranscripts();
  clearCachedLists();
  clearCachedPlugins();
  clearCaches();
}

/** How this browser is listed in 设备管理, e.g. "Chrome · macOS". */
function browserDeviceName(): string {
  const agent = navigator.userAgent;
  const browser = /Edg(e|A|iOS)?\//.test(agent) ? 'Edge' : /Firefox\/|FxiOS\//.test(agent) ? 'Firefox' : /Chrome\/|CriOS\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Web';
  const system = /iPhone|iPad/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Linux|CrOS/.test(agent) ? 'Linux' : '';
  return (system ? `${browser} · ${system}` : browser).slice(0, 64);
}

function Login({ onLogin, error, busy }: { onLogin: (credential: AuthLogin) => void; error?: SignInFailure; busy: boolean }) {
  const { t } = useLingui();
  const [mode, setMode] = useState<'code'|'token'>('code');
  const [credential, setCredential] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const isCode = mode==='code';
  const label = isCode?t`配对码`:t`访问令牌`;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-sidebar px-5">
      <div className="flex w-full max-w-[360px] flex-col items-center">
        <BrandMark className="mb-6 size-10 text-fg" />
        <h1 className="text-2xl font-semibold tracking-tight text-fg"><Trans>登录 Riffet</Trans></h1>
        <p className="mt-1.5 text-center text-sm text-fg-3"><Trans>在运行服务器的 Mac 或电脑上执行</Trans> <code className="font-mono text-fg-2">{isCode?'riffet pair':'riffet token'}</code> {isCode?t`获取配对码`:t`查看访问令牌`}</p>
        <form className="mt-8 flex w-full flex-col gap-3" onSubmit={(event) => {
          event.preventDefault();
          const value=credential.trim();
          if(value)onLogin(isCode?{code:value,name:browserDeviceName()}:{token:value});
        }}>
          <Input key={mode} autoFocus className="h-10 rounded-lg px-3 font-mono text-base" type={isCode?'text':'password'} autoComplete={isCode?'one-time-code':'current-password'} autoCapitalize={isCode?'characters':'none'} spellCheck={false} value={credential} onChange={(event) => setCredential(event.target.value)} placeholder={label} aria-label={label} disabled={busy} />
          <Button type="submit" variant="primary" size="lg" className="h-10" disabled={!credential.trim()} busy={busy}><Trans>继续</Trans><IconArrowRight /></Button>
          {error && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{'text' in error ? error.text : i18n._(error.message)}</p>}
          {isCode && <Button type="button" variant="secondary" size="lg" onClick={() => setScannerOpen(true)}><IconQrCode className="size-4" /><Trans>扫描配对二维码</Trans></Button>}
          <Button type="button" variant="ghost" disabled={busy} onClick={()=>{setMode(isCode?'token':'code');setCredential('');}}>{isCode?t`使用访问令牌登录`:t`使用配对码登录`}</Button>
        </form>
        <p className="mt-8 text-center text-xs text-fg-3"><Trans>登录状态保存在当前浏览器。配对后可在 Riffet 的设备管理中撤销访问。</Trans></p>
      </div>
      <PairingQrScanner open={scannerOpen} onOpenChange={setScannerOpen} />
    </main>
  );
}

export function App() {
  const { t } = useLingui();
  const [state, setState] = useState<'checking' | 'anonymous' | 'authenticated'>('checking');
  const [error, setError] = useState<SignInFailure>();
  const [busy, setBusy] = useState(false);
  const [tokenRequired, setTokenRequired] = useState(true);
  const pairingAttempt = useRef<{ code: string; login: Promise<AuthStatus> } | null>(null);

  useEffect(() => {
    let rechecking = false;
    onUnauthenticated(() => {
      forgetLocalData();
      setCsrfToken('');
      // Every poll in flight gets the same 401; one status check decides where the page goes. Without a
      // token requirement it signs straight back in, otherwise it lands on the sign-in screen.
      if (rechecking) return;
      rechecking = true;
      setState('checking');
      api.authStatus()
        .then((status) => {
          if (!status.authenticated) setError({ message: msg`登录已失效，请重新登录` });
          setTokenRequired(status.tokenRequired);
          setState(status.authenticated ? 'authenticated' : 'anonymous');
        })
        .catch((reason) => { setError(signInError(reason, msg`登录已失效，请重新登录`)); setState('anonymous'); })
        .finally(() => { rechecking = false; });
    });
    return () => onUnauthenticated(undefined);
  }, []);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams(window.location.search);
    const token = query.get('token');
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const pairingCode = pairingAttempt.current?.code ?? fragment.get('pair');
    // The code is a one-use credential. Remove it before any request or overlay navigation begins.
    const cleanQuery = new URLSearchParams(query);
    cleanQuery.delete('token');
    const cleanFragment = new URLSearchParams(fragment);
    cleanFragment.delete('pair');
    if (token || pairingCode) {
      const search = cleanQuery.toString();
      const hash = cleanFragment.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}${hash ? `#${hash}` : ''}`);
    }
    startOverlayNavigation();
    void (async () => {
      try {
        if (pairingCode) {
          // StrictMode replays effects after their first cleanup. Keep the same redemption promise:
          // the server consumes this code on its first use, while the replay owns the live UI.
          pairingAttempt.current ??= {
            code: pairingCode,
            login: api.login({ code: pairingCode, name: browserDeviceName() }),
          };
          const status = await pairingAttempt.current.login;
          if (active) { setTokenRequired(status.tokenRequired); setState('authenticated'); }
          return;
        }
        if (token) { const status = await api.login(token); if (active) { setTokenRequired(status.tokenRequired); setState('authenticated'); } return; }
        const status = await api.authStatus();
        // Transcripts left behind by an expired or revoked sign-in must not outlive it on this device.
        if (!status.authenticated) forgetLocalData();
        if (active) { setTokenRequired(status.tokenRequired); setState(status.authenticated ? 'authenticated' : 'anonymous'); }
      } catch (reason) {
        if (reason instanceof HttpError && reason.status === 401) forgetLocalData();
        if (!active) return;
        // A server that is down or restarting says nothing about the sign-in: with a local copy of the
        // lists the workbench opens on it, offline, and a real 401 later still lands here.
        if (!token && !pairingCode && isUnreachable(reason) && loadCachedLists()) { setState('authenticated'); return; }
        setState('anonymous');
        if (token || pairingCode || !(reason instanceof HttpError && reason.status === 401)) setError(signInError(reason, msg`无法登录`));
      }
    })();
    return () => { active = false; };
  }, []);

  const login = async (credential: AuthLogin) => {
    setBusy(true); setError(undefined);
    try { const status = await api.login(credential); setTokenRequired(status.tokenRequired); setState('authenticated'); }
    catch (reason) { setError(signInError(reason, msg`登录失败`)); }
    finally { setBusy(false); }
  };

  const logout = async () => {
    try { await api.logout(); } catch (reason) { toast.error(errorMessage(reason, t`退出登录失败`)); }
    forgetLocalData();
    clearNativeOutbox();
    setCsrfToken('');
    setState('anonymous');
  };

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={150}>
      {state === 'checking' && <Splash />}
      {state === 'anonymous' && <Login onLogin={(credential) => void login(credential)} error={error} busy={busy} />}
      {state === 'authenticated' && <Suspense fallback={<Splash />}><Workbench onLogout={tokenRequired ? () => void logout() : undefined} /></Suspense>}
      <Toaster />
      <DialogHost />
    </TooltipProvider>
  );
}
