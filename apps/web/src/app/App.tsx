import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconQrCode } from '@/components/icons-base';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/controls';
import { DialogHost, Toaster } from '@/components/ui/overlays';
import { TooltipProvider } from '@/components/ui/tooltip';
import { BrandMark, LiveBrandMark } from '@/components/BrandMark';
import { PairingQrScanner } from '@/components/PairingQrScanner';
import { RunnerGame } from '@/components/runner/RunnerGame';
import { api, HttpError, isUnreachable, onUnauthenticated, setCsrfToken, type AuthLogin, type AuthStatus } from '@/lib/api';
import { toast } from '@/lib/toast';
import { clearTranscripts } from '@/lib/transcript-store';
import { clearNativeOutbox } from '@/lib/native-outbox-storage';
import { clearCachedPlugins } from '@/lib/plugins';
import { clearCaches } from '@/lib/cache-registry';
import { clearCachedLists, loadCachedLists } from '@/lib/list-cache';
import { clearRecentSearches } from '@/lib/recent-searches';
import { cn, errorMessage, reconnectDelay } from '@/lib/utils';
import { startOverlayNavigation } from '@/lib/overlay-navigation';
import { connectWorkbenchAppearance, needsWorkbenchDocumentReload } from '@/lib/workbench-appearance';

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
  clearRecentSearches();
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

/**
 * A signed-out page: one column in the middle of a plain page, as the onboarding pages are
 * (patterns §1.5), with an optional line pinned to the bottom.
 */
function SignInPage({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col bg-bg px-5">
      <div className="flex flex-1 flex-col items-center justify-center pb-[12vh] pt-12">{children}</div>
      {footer && <p className="mx-auto max-w-md pb-6 text-center text-xs text-balance text-fg-4">{footer}</p>}
    </main>
  );
}

function Login({ onLogin, error, busy }: { onLogin: (credential: AuthLogin) => void; error?: SignInFailure; busy: boolean }) {
  const { t } = useLingui();
  const [mode, setMode] = useState<'code'|'token'>('code');
  const [credential, setCredential] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isCode = mode==='code';
  const label = isCode?t`配对码`:t`访问令牌`;
  return (
    <SignInPage footer={<Trans>登录状态只保存在这个浏览器，可在 Riffet 的设备管理中撤销。</Trans>}>
      <div className="flex w-full max-w-sm flex-col items-center">
        <BrandMark className="size-12 text-fg" />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-fg"><Trans>登录 Riffet</Trans></h1>
        <p className="mt-1.5 text-center text-sm text-balance text-fg-3">
          {isCode
            ? <Trans>在服务器上运行 <code className="font-mono text-fg-2">riffet pair</code>，输入显示的配对码</Trans>
            : <Trans>在服务器上运行 <code className="font-mono text-fg-2">riffet token</code> 查看访问令牌</Trans>}
        </p>
        <form className="mt-7 flex w-full flex-col" noValidate onSubmit={(event) => {
          event.preventDefault();
          const value=credential.trim();
          if(!value){ inputRef.current?.focus(); return; }
          onLogin(isCode?{code:value,name:browserDeviceName()}:{token:value});
        }}>
          <Input
            key={mode}
            ref={inputRef}
            autoFocus
            className={cn('h-11 rounded-xl px-4 font-mono text-base', isCode && 'text-center uppercase', isCode && credential && 'tracking-widest')}
            type={isCode?'text':'password'}
            autoComplete={isCode?'one-time-code':'current-password'}
            autoCapitalize={isCode?'characters':'none'}
            spellCheck={false}
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
            placeholder={label}
            aria-label={label}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? 'sign-in-error' : undefined}
            disabled={busy}
          />
          {error && <p id="sign-in-error" role="alert" className="mt-2 text-center text-xs text-danger">{'text' in error ? error.text : i18n._(error.message)}</p>}
          <Button type="submit" variant="primary" size="lg" className="mt-4 h-10 w-full rounded-xl text-sm" busy={busy}>
            <Trans>继续</Trans><span aria-hidden className="text-primary-fg/50">↩</span>
          </Button>
        </form>
        <div className="mt-4 flex items-center justify-center gap-1">
          {isCode && <Button type="button" variant="quiet" size="sm" disabled={busy} onClick={() => setScannerOpen(true)}><IconQrCode /><Trans>扫码配对</Trans></Button>}
          <Button type="button" variant="quiet" size="sm" disabled={busy} onClick={()=>{setMode(isCode?'token':'code');setCredential('');}}>{isCode?t`改用访问令牌`:t`改用配对码`}</Button>
        </div>
      </div>
      <PairingQrScanner open={scannerOpen} onOpenChange={setScannerOpen} />
    </SignInPage>
  );
}

/**
 * Nothing answered at all: there is no sign-in to ask for yet. The page keeps trying by itself, and
 * meanwhile the horse runs, as the browser's dinosaur does when it is offline.
 */
function Unreachable({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <SignInPage>
      <h1 className="text-2xl font-semibold tracking-tight text-fg"><Trans>连不上 Riffet 服务器</Trans></h1>
      <p className="mt-1.5 text-center text-sm text-balance text-fg-3"><Trans>页面会自动重连</Trans></p>
      <Button className="mt-6" busy={retrying} onClick={onRetry}><Trans>重试</Trans></Button>
      <RunnerGame globalKeys className="mt-12 max-w-2xl" />
    </SignInPage>
  );
}

export function App() {
  const { t } = useLingui();
  const [state, setState] = useState<'checking' | 'unreachable' | 'anonymous' | 'authenticated'>('checking');
  const [retrying, setRetrying] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [error, setError] = useState<SignInFailure>();
  const [busy, setBusy] = useState(false);
  const [tokenRequired, setTokenRequired] = useState(true);
  const pairingAttempt = useRef<{ code: string; login: Promise<AuthStatus> } | null>(null);
  /** `#handoff=<code>`: redeemed only if this browser is not signed in yet; one status check, kept across StrictMode's replay. */
  const handoffAttempt = useRef<{ code: string; status: Promise<AuthStatus> } | null>(null);

  useEffect(() => {
    let rechecking = false;
    onUnauthenticated(() => {
      // Signed out already, a 401 (a theme read the page makes before sign-in) says nothing new: the
      // sign-in page stays as it is, without a 「登录已失效」 for a browser that never signed in.
      if (stateRef.current !== 'authenticated') return;
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
    const handoffCode = handoffAttempt.current?.code ?? fragment.get('handoff');
    // The code is a one-use credential. Remove it before any request or overlay navigation begins.
    const cleanQuery = new URLSearchParams(query);
    cleanQuery.delete('token');
    const cleanFragment = new URLSearchParams(fragment);
    cleanFragment.delete('pair');
    cleanFragment.delete('handoff');
    if (token || pairingCode || handoffCode) {
      const search = cleanQuery.toString();
      const hash = cleanFragment.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}${hash ? `#${hash}` : ''}`);
    }
    startOverlayNavigation();
    /** Set once a code is being redeemed, so a failure of the redemption is reported like a failed pairing. */
    let redeeming = Boolean(token || pairingCode);
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
        if (handoffCode && !pairingCode && !token) {
          handoffAttempt.current ??= { code: handoffCode, status: api.authStatus() };
          const status = await handoffAttempt.current.status;
          if (!status.authenticated) {
            forgetLocalData();
            redeeming = true;
            // Not signed in: the code is a pairing code, redeemed once even when the effect replays.
            pairingAttempt.current ??= { code: handoffCode, login: api.login({ code: handoffCode, name: browserDeviceName() }) };
            const paired = await pairingAttempt.current.login;
            if (active) { setTokenRequired(paired.tokenRequired); setState('authenticated'); }
            return;
          }
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
        if (!redeeming && isUnreachable(reason)) { setState(loadCachedLists() ? 'authenticated' : 'unreachable'); return; }
        setState('anonymous');
        if (redeeming || !(reason instanceof HttpError && reason.status === 401)) setError(signInError(reason, msg`无法登录`));
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (state === 'authenticated') return connectWorkbenchAppearance();
  }, [state]);

  /** One status check from the unreachable page: whatever answers decides where the page goes. */
  const recheck = useCallback(async () => {
    setRetrying(true);
    try {
      const status = await api.authStatus();
      if (!status.authenticated) forgetLocalData();
      setTokenRequired(status.tokenRequired);
      setState(status.authenticated ? 'authenticated' : 'anonymous');
      return true;
    } catch (reason) {
      if (isUnreachable(reason)) return false;
      // As on the first check: a 401 is just signed out, anything else is worth saying.
      if (reason instanceof HttpError && reason.status === 401) forgetLocalData();
      else setError(signInError(reason, msg`无法登录`));
      setState('anonymous');
      return true;
    } finally {
      setRetrying(false);
    }
  }, []);

  // Unreachable, the page redials by itself, backing off, and at once when the device comes back online.
  useEffect(() => {
    if (state !== 'unreachable') return;
    let active = true, attempt = 0, timer: number | undefined;
    const retry = () => {
      window.clearTimeout(timer);
      void recheck().then((done) => { if (active && !done) timer = window.setTimeout(retry, reconnectDelay(++attempt)); });
    };
    timer = window.setTimeout(retry, reconnectDelay(++attempt));
    window.addEventListener('online', retry);
    return () => { active = false; window.clearTimeout(timer); window.removeEventListener('online', retry); };
  }, [state, recheck]);

  const login = async (credential: AuthLogin) => {
    setBusy(true); setError(undefined);
    try {
      const status = await api.login(credential);
      if (needsWorkbenchDocumentReload()) {
        setState('checking');
        window.location.reload();
      } else {
        setTokenRequired(status.tokenRequired);
        setState('authenticated');
      }
    }
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
      {state === 'unreachable' && <Unreachable retrying={retrying} onRetry={() => void recheck()} />}
      {state === 'anonymous' && <Login onLogin={(credential) => void login(credential)} error={error} busy={busy} />}
      {state === 'authenticated' && <Suspense fallback={<Splash />}><Workbench onLogout={tokenRequired ? () => void logout() : undefined} /></Suspense>}
      <Toaster />
      <DialogHost />
    </TooltipProvider>
  );
}
