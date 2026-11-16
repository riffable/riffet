import React from 'react';
import { createRoot } from 'react-dom/client';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { I18nProvider } from '@lingui/react';
// First, so the source catalog is active before any other module runs.
import { startLocale, useLocale } from './lib/i18n';
import { App } from './app/App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installFocusRingPolicy } from './lib/focus-ring';
import { startMainThreadMonitor } from './lib/main-thread-monitor';
import { startClientMetrics } from './lib/client-metrics';
import { toast } from './lib/toast';
import './lib/theme';
import './lib/display-settings';
import './lib/app-icon';
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './styles/font-metrics.css';
import './styles/index.css';

installFocusRingPolicy();
startMainThreadMonitor();
startClientMetrics();

// Development only: every layout shift no transition accounts for, and every spinner or disabled
// state that came and went too fast to mean anything, is reported in the console (docs/WEB.md,
// 布局稳定性). Loaded on demand so production carries none of it.
if (import.meta.env.DEV) void import('./lib/layout-shift-monitor').then(({ installLayoutShiftMonitor, installFlashMonitor }) => { installLayoutShiftMonitor(); installFlashMonitor(); });

/*
 * Registered only from a production build: under the dev server there is no `/sw.js`, and a worker
 * intercepting fetches would fight HMR over every module and asset. Registration is deliberately
 * fire-and-forget — the app is fully usable when the browser has no service worker, or when a
 * private window refuses one, so a failure here must not surface to the reader.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

/*
 * An upgraded server no longer has the previous build's hashed chunks, and the new service worker
 * drops the old cache when it takes over, so a tab opened before the upgrade fails on its next lazy
 * view. The region that asked for it shows its own error; this says what actually fixes it. Not an
 * automatic reload: that could loop on a chunk that is missing for another reason.
 */
let reloadPromptedAt = 0;
window.addEventListener('vite:preloadError', () => {
  if (Date.now() - reloadPromptedAt < 10_000) return;
  reloadPromptedAt = Date.now();
  toast.info(i18n._(msg`已更新，刷新后继续`), { duration: 60_000, action: { label: i18n._(msg`刷新`), onClick: () => window.location.reload() } });
});

/**
 * Subscribing at the root re-renders the whole tree on a language switch, so text formatted outside
 * `useLingui` (a date, an age) follows it too. A memoised component that renders text subscribes
 * itself, through `useLingui`.
 */
function Root() {
  useLocale();
  return <I18nProvider i18n={i18n}><ErrorBoundary variant="page"><App /></ErrorBoundary></I18nProvider>;
}

// The first paint waits for a non-source catalog, so a reader who chose English never sees Chinese flash.
void startLocale().then(() => {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
});
