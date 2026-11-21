#!/usr/bin/env node
// Web performance checks (docs/guide/web-performance.md §3). Drives a headless Chrome over CDP against
// a production build of the web client and an isolated server; never the dev server (React's dev build
// is several times slower and renders twice) and never the server you use.
//
//   node scripts/web-perf.mjs seed <dir> [--server http://127.0.0.1:4417] [--sessions 3000]
//       Stress data (scripts/perf-seed.mjs): a 260-turn session, 700-line edits, 6,000-line outputs,
//       screenshots and <sessions> short sessions over 4 git projects, imported into the server.
//   node scripts/web-perf.mjs stream <dir> [--turns 20] [--every 500]
//       Appends turns to the seeded 「进行中」 session so the server streams it as a turn in progress.
//   node scripts/web-perf.mjs run [scenario ...] [--mobile] [--cpu 4] [--profile] [--url …] [--cdp …]
//       Runs the scenarios (all when none named) and prints one line per step: frames, dropped frames,
//       worst frame, long animation frames and their blocking time, the slowest input-to-paint, layout
//       shift. --profile adds the hottest functions by self time. --mobile emulates a 390×844 touch
//       phone; --cpu slows the CPU by that factor (4 approximates a mid-range phone).
//   node scripts/web-perf.mjs build <dir> [--minify]   production build into <dir>/public (unminified unless --minify)
//   node scripts/web-perf.mjs preview <dir> [--port 5273] [--server http://127.0.0.1:4417]
//   node scripts/web-perf.mjs list
//
// Set-up (ports chosen so they do not collide with `pnpm dev`):
//   CLAUDE_CONFIG_DIR=<dir>/claude RIFFET_ENV_KEEP=CLAUDE_CONFIG_DIR npx tsx apps/server/src/cli.ts serve --dev \
//     --state-dir <dir>/state --port 4417 --no-auth --no-mdns
//   node scripts/web-perf.mjs build <dir> && node scripts/web-perf.mjs preview <dir>
//   "Google Chrome" --headless=new --remote-debugging-port=9577 --remote-debugging-address=127.0.0.1 \
//     --user-data-dir=<dir>/chrome --window-size=1440,900
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendTurns, seed } from './perf-seed.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = argv[at + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};
const positional = argv.filter((value, index) => !value.startsWith('--') && !(index > 0 && argv[index - 1].startsWith('--') && !['--mobile', '--profile', '--alloc', '--minify'].includes(argv[index - 1])));
const [command, ...names] = positional;

// ---- CDP ----------------------------------------------------------------------------------------

async function connect(cdp) {
  const targets = await (await fetch(`${cdp}/json`)).json();
  let target = targets.find(t => t.type === 'page');
  if (!target) target = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = fail; });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { ok, fail } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) fail(new Error(`${message.error.message} ${message.error.data ?? ''}`)); else ok(message.result);
    } else if (message.method) for (const listener of listeners.get(message.method) ?? []) listener(message.params);
  };
  const send = (method, params = {}) => new Promise((ok, fail) => { pending.set(++id, { ok, fail }); socket.send(JSON.stringify({ id, method, params })); });
  const once = method => new Promise(ok => {
    const list = listeners.get(method) ?? [];
    const listener = params => { list.splice(list.indexOf(listener), 1); ok(params); };
    list.push(listener);
    listeners.set(method, list);
  });
  return { send, once, close: () => socket.close() };
}

// Collects long animation frames, slow interactions, layout shifts and frame intervals in the page.
const PROBE = `(() => {
  if (window.__perf) return;
  const perf = window.__perf = { loaf: [], events: [], shifts: 0, shiftSources: [], frames: [], recording: true };
  const observe = (type, options, each) => { try { new PerformanceObserver(list => list.getEntries().forEach(each)).observe({ type, ...options }); } catch {} };
  observe('long-animation-frame', { buffered: true }, entry => perf.recording && perf.loaf.push({
    duration: entry.duration, blocking: entry.blockingDuration, render: entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : 0,
    style: entry.styleAndLayoutStart ? entry.startTime + entry.duration - entry.styleAndLayoutStart : 0,
    scripts: entry.scripts.map(s => ({ fn: s.sourceFunctionName, src: (s.sourceURL || '').split('/').pop(), at: s.sourceCharPosition, invoker: s.invoker, duration: s.duration, layout: s.forcedStyleAndLayoutDuration })),
  }));
  observe('event', { durationThreshold: 16, buffered: true }, entry => perf.recording && perf.events.push({ name: entry.name, duration: entry.duration, target: entry.target?.getAttribute?.('aria-label') || entry.target?.tagName }));
  observe('layout-shift', { buffered: true }, entry => {
    if (!perf.recording || entry.hadRecentInput) return;
    perf.shifts += entry.value;
    if (entry.value > 0.02) perf.shiftSources.push({ value: entry.value, sources: entry.sources.map(s => ({ node: s.node?.dataset?.rowKey || s.node?.getAttribute?.('aria-label') || s.node?.className?.toString?.().slice(0, 48) || s.node?.nodeName, dy: Math.round(s.currentRect.top - s.previousRect.top), dh: Math.round(s.currentRect.height - s.previousRect.height) })) });
  });
  let last = 0;
  const tick = now => { if (perf.recording && last) perf.frames.push(now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  perf.start = () => { perf.loaf = []; perf.events = []; perf.shifts = 0; perf.shiftSources = []; perf.frames = []; perf.recording = true; };
  perf.stop = () => { perf.recording = false; return { loaf: perf.loaf, events: perf.events, shifts: perf.shifts, shiftSources: perf.shiftSources.sort((a, b) => b.value - a.value).slice(0, 3), frames: perf.frames, heap: performance.memory?.usedJSHeapSize ?? 0, nodes: document.getElementsByTagName('*').length }; };
})()`;

async function browser({ cdp, url, mobile, cpu }) {
  const page = await connect(cdp);
  const { send } = page;
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  // A rebuilt client must not come from the previous build's service-worker cache.
  await send('Network.enable');
  await send('Network.setBypassServiceWorker', { bypass: true });
  await send('Network.setCacheDisabled', { cacheDisabled: false });
  if (mobile) {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1' });
  } else {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  }
  await send('Emulation.setCPUThrottlingRate', { rate: Number(cpu ?? 1) });
  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`${expression.slice(0, 120)}: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (expression, timeout = 15_000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await evaluate(expression).catch(() => false)) return; await sleep(100); }
    throw new Error(`timed out waiting for ${expression}`);
  };
  /** Center of the first element matching a CSS selector, or whose accessible text includes `text`. */
  const locate = async target => evaluate(`(() => {
    const target = ${JSON.stringify(target)};
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
    let el = null;
    try { const all = [...document.querySelectorAll(target)]; el = all.find(visible) ?? all.find(e => e.getClientRects().length); } catch {}
    if (!el) el = [...document.querySelectorAll('button,a,[role=button],[role=tab],[role=menuitem],[role=option],[role=treeitem],[role=radio],[role=switch],li,label')]
      .find(e => visible(e) && ((e.getAttribute('aria-label') || '').includes(target) || (e.textContent || '').trim().startsWith(target)));
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const click = async target => {
    const at = await locate(target);
    if (!at) throw new Error(`no element for ${target}`);
    if (mobile) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 });
    }
  };
  const key = async (key, code = key, modifiers = 0, text) => {
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, modifiers, text, windowsVirtualKeyCode: { Enter: 13, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38 }[key] ?? 0 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
  };
  const type = async (text, gap = 30) => {
    for (const char of text) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char, unmodifiedText: char });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
      await sleep(gap);
    }
  };
  /** A scroll gesture over the element: `distance` px down (negative is up) at `speed` px/s. */
  const scroll = async (target, distance, speed, repeat = 1) => {
    const at = await locate(target);
    if (!at) throw new Error(`no scroll target ${target}`);
    await send('Input.synthesizeScrollGesture', { ...at, yDistance: -distance, speed, repeatCount: repeat, repeatDelayMs: 50, gestureSourceType: mobile ? 'touch' : 'mouse' });
  };
  const goto = async path => {
    const loaded = page.once('Page.loadEventFired');
    await send('Page.navigate', { url: new URL(path, url).href });
    await loaded;
  };
  return { ...page, evaluate, waitFor, sleep, click, key, type, scroll, goto, locate, mobile };
}

// ---- measuring ----------------------------------------------------------------------------------

const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0; };

async function measure(page, label, action, { profile, alloc, settle = 600, fresh = false } = {}) {
  // A navigation measures from the new document's start, which records on its own.
  if (!fresh) await page.evaluate('window.__perf.start()');
  if (alloc) { await page.send('HeapProfiler.enable'); await page.send('HeapProfiler.startSampling', { samplingInterval: 16384 }); }
  if (profile) { await page.send('Profiler.enable'); await page.send('Profiler.setSamplingInterval', { interval: 250 }); await page.send('Profiler.start'); }
  const started = Date.now();
  try {
    await action();
    await page.sleep(settle);
  } catch (error) {
    if (profile) await page.send('Profiler.stop').catch(() => {});
    await page.evaluate('window.__perf.stop()').catch(() => {});
    throw error;
  }
  const elapsed = Date.now() - started;
  const result = await page.evaluate('window.__perf.stop()');
  const cpu = profile ? (await page.send('Profiler.stop')).profile : null;
  const allocations = alloc ? (await page.send('HeapProfiler.stopSampling')).profile : null;
  // performance.memory counts garbage too; collect first (outside the profile) so the figure is what the page keeps.
  await page.send('HeapProfiler.collectGarbage').catch(() => {});
  result.heap = (await page.send('Runtime.getHeapUsage').catch(() => ({ usedSize: result.heap }))).usedSize;
  const frames = result.frames;
  const loaf = result.loaf;
  const blocking = loaf.reduce((sum, f) => sum + f.blocking, 0);
  const worst = loaf.reduce((max, f) => f.duration > (max?.duration ?? 0) ? f : max, null);
  const inp = result.events.reduce((max, e) => e.duration > (max?.duration ?? 0) ? e : max, null);
  const line = [
    label.padEnd(30),
    `${elapsed}ms`.padStart(7),
    `frames ${frames.length}`.padEnd(11),
    `>33ms ${frames.filter(f => f > 33.4).length}`.padEnd(9),
    `p95 ${quantile(frames, 0.95).toFixed(0)}`.padEnd(7),
    `max ${Math.max(0, ...frames).toFixed(0)}`.padEnd(8),
    `LoAF ${loaf.length}/${blocking.toFixed(0)}ms`.padEnd(15),
    `INP ${inp ? `${inp.duration}ms ${inp.name}` : '-'}`.padEnd(22),
    `CLS ${result.shifts.toFixed(3)}`,
    `heap ${(result.heap / 2 ** 20).toFixed(0)}MB nodes ${result.nodes}`,
  ].join(' ');
  console.log(line);
  if (worst && worst.duration > 50) {
    const scripts = [...worst.scripts].sort((a, b) => b.duration - a.duration).slice(0, 3)
      .map(s => `${s.invoker} → ${s.fn || '?'}@${s.src}:${s.at} ${s.duration.toFixed(0)}ms${s.layout ? ` (forced layout ${s.layout.toFixed(0)}ms)` : ''}`);
    console.log(`    worst frame ${worst.duration.toFixed(0)}ms (style+layout ${worst.style.toFixed(0)}ms): ${scripts.join(' | ') || 'no script'}`);
  }
  if (result.shifts > 0.1) for (const shift of result.shiftSources) console.log(`    shift ${shift.value.toFixed(3)}: ${shift.sources.map(s => `${s.node} dy ${s.dy} dh ${s.dh}`).join(' | ')}`);
  if (allocations) console.log(allocators(allocations).map(row => `    ${row}`).join('\n'));
  if (cpu) console.log(hottest(cpu).map(row => `    ${row}`).join('\n'));
  return { label, elapsed, frames, loaf, events: result.events };
}

/**
 * The functions with the most self time in a CPU profile, skipping idle and GC buckets, then the app's
 * own functions (not React's or the browser's) by inclusive time, which is where a fix goes.
 */
function hottest(profile, limit = 12) {
  const deltas = profile.timeDeltas;
  const byId = new Map(profile.nodes.map(node => [node.id, node]));
  const time = new Map();
  profile.samples.forEach((id, index) => time.set(id, (time.get(id) ?? 0) + (deltas[index] ?? 0)));
  const key = ({ callFrame }) => `${callFrame.functionName || '(anonymous)'} ${callFrame.url.split('/').pop()}:${callFrame.lineNumber + 1}`;
  const self = new Map();
  let total = 0;
  for (const [id, micros] of time) {
    const node = byId.get(id);
    if (['(idle)', '(program)', '(root)'].includes(node.callFrame.functionName)) continue;
    total += micros;
    self.set(key(node), (self.get(key(node)) ?? 0) + micros);
  }
  // Inclusive time of app functions: each sample counts once per distinct function on its stack.
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const inclusive = new Map();
  const app = node => /\/assets\/(?!react-)/.test(node.callFrame.url) && node.callFrame.functionName;
  for (const [id, micros] of time) {
    const seen = new Set();
    for (let at = id; at !== undefined; at = parent.get(at)) {
      const node = byId.get(at);
      if (!app(node) || seen.has(key(node))) continue;
      seen.add(key(node));
      inclusive.set(key(node), (inclusive.get(key(node)) ?? 0) + micros);
    }
  }
  const rows = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, micros]) => `${(micros / 1000).toFixed(1).padStart(7)}ms  ${name}`);
  return [`busy ${(total / 1000).toFixed(0)}ms, self:`, ...rows(self), 'app functions, inclusive:', ...rows(inclusive)];
}

/** The functions that allocated the most during the step (sampled), by self size. */
function allocators(profile, limit = 14) {
  const self = new Map();
  let total = 0;
  const walk = node => {
    const { callFrame } = node;
    const key = `${callFrame.functionName || '(anonymous)'} ${callFrame.url.split('/').pop()}:${callFrame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + node.selfSize);
    total += node.selfSize;
    node.children.forEach(walk);
  };
  walk(profile.head);
  return [`allocated ~${(total / 2 ** 20).toFixed(0)}MB (sampled), by function:`, ...[...self].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, bytes]) => `${(bytes / 2 ** 20).toFixed(1).padStart(7)}MB  ${key}`)];
}

// ---- scenarios ----------------------------------------------------------------------------------

/** Finds a seeded session id by title through the server's list. */
const sessionByTitle = (page, title) => page.evaluate(`fetch('/api/sessions').then(r => r.json()).then(list => (list.sessions ?? list).find(s => (s.title || '').startsWith(${JSON.stringify(title)}))?.id)`);
const transcript = '[data-transcript-scroll], [data-testid=transcript], main [class*=overflow-y-auto]';

const SCENARIOS = {
  async startup(page, opts) {
    await measure(page, 'cold load (/)', async () => {
      await page.goto('/');
      await page.waitFor(`!!document.querySelector('nav [role=button]') && !!document.querySelector('textarea')`);
    }, { ...opts, settle: 1500, fresh: true });
    const timing = await page.evaluate(`(() => { const n = performance.getEntriesByType('navigation')[0]; const p = Object.fromEntries(performance.getEntriesByType('paint').map(e => [e.name, e.startTime])); const lcp = performance.getEntriesByType('largest-contentful-paint').at(-1); return { domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), fcp: Math.round(p['first-contentful-paint'] ?? 0), transferKB: Math.round(performance.getEntriesByType('resource').reduce((s, r) => s + r.transferSize, 0) / 1024), scripts: performance.getEntriesByType('resource').filter(r => r.initiatorType === 'script' || r.name.endsWith('.js')).length }; })()`);
    console.log(`    ${JSON.stringify(timing)}`);
  },
  async sidebar(page, opts) {
    await page.goto('/');
    await page.sleep(1500);
    const list = await page.evaluate(`(() => { const el = [...document.querySelectorAll('nav *, aside *')].find(e => e.scrollHeight > e.clientHeight + 200 && getComputedStyle(e).overflowY !== 'visible'); if (!el) return null; el.setAttribute('data-perf-sidebar', ''); return el.scrollHeight; })()`);
    if (!list) return console.log('sidebar: no scrollable list');
    await measure(page, 'sidebar slow scroll', () => page.scroll('[data-perf-sidebar]', 3000, 800), opts);
    await measure(page, 'sidebar fast scroll', () => page.scroll('[data-perf-sidebar]', -6000, 6000, 3), opts);
  },
  async longTranscript(page, opts) {
    const id = await sessionByTitle(page, '转录渲染（超长）');
    await measure(page, 'open 260-turn session', async () => {
      await page.goto(`/c/${id}`);
      await page.waitFor(`document.body.innerText.includes('第 260 轮')`, 30_000);
    }, { ...opts, settle: 1500, fresh: true });
    await markTranscript(page);
    await withJumps(page, 'transcript slow scroll up', () => page.scroll('[data-perf-transcript]', -4000, 1200), opts);
    await withJumps(page, 'transcript fast scroll up', () => page.scroll('[data-perf-transcript]', -20000, 9000, 3), { ...opts, settle: 1200 });
    await withJumps(page, 'transcript fast scroll down', () => page.scroll('[data-perf-transcript]', 30000, 9000, 3), { ...opts, settle: 1200 });
  },
  async bigOutputs(page, opts) {
    const id = await sessionByTitle(page, '大 diff 与长输出');
    await measure(page, 'open big-diff session', async () => {
      await page.goto(`/c/${id}`);
      await page.waitFor(`document.body.innerText.includes('第 6 轮')`, 30_000);
    }, { ...opts, settle: 1500, fresh: true });
    await markTranscript(page);
    await measure(page, 'big-diff scroll', () => page.scroll('[data-perf-transcript]', -8000, 3000), opts);
    await measure(page, 'expand tool rows', async () => {
      for (let i = 0; i < 4; i++) {
        const opened = await page.evaluate(`(() => { const b = [...document.querySelectorAll('[aria-expanded=false]')].find(e => { const r = e.getBoundingClientRect(); return r.top > 60 && r.bottom < innerHeight - 120; }); if (!b) return false; b.setAttribute('data-perf-open', ${i}); return true; })()`);
        if (!opened) break;
        await page.click(`[data-perf-open="${i}"]`);
        await page.sleep(300);
      }
    }, opts);
  },
  async images(page, opts) {
    const id = await sessionByTitle(page, '截图审阅（大量图片）');
    await measure(page, 'open image session', async () => {
      await page.goto(`/c/${id}`);
      await page.waitFor(`document.body.innerText.includes('第 40 轮')`, 30_000);
    }, { ...opts, settle: 1500, fresh: true });
    await markTranscript(page);
    await measure(page, 'image session fast scroll', () => page.scroll('[data-perf-transcript]', -10000, 8000, 2), opts);
    const image = await page.evaluate(`(() => { const img = [...document.querySelectorAll('main img')].find(i => { const r = i.getBoundingClientRect(); return r.top > 60 && r.bottom < innerHeight - 100 && r.width > 20; }); if (!img) return false; img.setAttribute('data-perf-image', ''); return true; })()`);
    if (image) {
      await measure(page, 'open image viewer', () => page.click('[data-perf-image]'), opts);
      await measure(page, 'close image viewer', () => page.key('Escape'), opts);
    }
  },
  async composer(page, opts) {
    const id = await sessionByTitle(page, '转录渲染（超长）');
    await page.goto(`/c/${id}`);
    await page.waitFor(`document.body.innerText.includes('第 260 轮')`, 30_000);
    await page.sleep(800);
    await page.click('textarea');
    await measure(page, 'type 60 chars', () => page.type('性能检查'.repeat(5) + 'check the scroll performance of the list '.slice(0, 40), 25), opts);
    await measure(page, 'type @ mention', () => page.type('@Fix', 60), opts);
    await page.key('Escape');
    await measure(page, 'type / slash', async () => { await page.evaluate(`(() => { const t = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`); await page.type('/', 0); await page.sleep(200); await page.type('mod', 60); }, opts);
    await page.key('Escape');
    await measure(page, 'paste 200 KB text', () => page.evaluate(`(() => { const t = document.querySelector('textarea'); t.focus(); const data = new DataTransfer(); data.setData('text/plain', 'log line 0123456789 abcdefghij\\n'.repeat(6500)); t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); })()`), opts);
  },
  async switching(page, opts) {
    await page.goto('/');
    await page.sleep(1500);
    const ids = await page.evaluate(`fetch('/api/sessions').then(r => r.json()).then(list => (list.sessions ?? list).slice(0, 8).map(s => s.id))`);
    await measure(page, 'switch 8 sessions (sidebar)', async () => {
      for (const id of ids) {
        const found = await page.locate(`[href$="/c/${id}"], [data-session-id="${id}"]`);
        if (found) await page.click(`[href$="/c/${id}"], [data-session-id="${id}"]`);
        else await page.evaluate(`history.pushState(null, '', '/c/${id}'); dispatchEvent(new PopStateEvent('popstate'))`);
        await page.sleep(350);
      }
    }, opts);
    // Pages are reached from the sidebar, as a reader reaches them;「更多」 holds the rest.
    for (const [label, path] of [['open tasks page', ['任务看板']], ['open plugins page', ['插件']], ['open assistant page', ['个人助理']], ['open stats page', ['更多', '数据统计']], ['open automations page', ['更多', '自动化']], ['open extensions page', ['更多', '扩展管理']]]) {
      await measure(page, label, async () => {
        if (page.mobile) { await page.click('[aria-label="打开侧边栏"], [aria-label="打开导航"]').catch(() => {}); await page.sleep(400); }
        for (const step of path) { await page.click(step); await page.sleep(250); }
      }, { ...opts, settle: 1200 });
      await measure(page, `${label.replace('open ', 'scroll ')}`, async () => {
        const found = await page.evaluate(`(() => { const el = [...document.querySelectorAll('main *')].filter(e => e.scrollHeight > e.clientHeight + 100 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.clientHeight - a.clientHeight)[0]; document.querySelectorAll('[data-perf-page]').forEach(e => e.removeAttribute('data-perf-page')); el?.setAttribute('data-perf-page', ''); return !!el; })()`);
        if (found) { await page.scroll('[data-perf-page]', 3000, 1500); await page.scroll('[data-perf-page]', -3000, 6000); }
      }, opts);
    }
  },
  async openInApp(page, opts) {
    // Opening a conversation without reloading, as a reader does: search its title and press Enter.
    await page.goto('/');
    await page.sleep(2000);
    for (const [title, last] of [['转录渲染', '第 260 轮'], ['大 diff', '第 6 轮'], ['截图审阅', '第 40 轮'], ['转录渲染', '第 260 轮']]) {
      await page.key('k', 'KeyK', 4);
      await page.sleep(300);
      await page.type(title, 0);
      await page.sleep(300);
      await measure(page, `open「${title}」in app`, async () => {
        await page.key('Enter');
        await page.waitFor(`document.querySelector('main')?.innerText.includes('${last}')`, 30_000);
      }, { ...opts, settle: 1500 });
    }
  },
  async stats(page, opts) {
    await page.goto('/');
    await page.sleep(1500);
    await measure(page, 'open stats page', async () => { await page.click('更多'); await page.sleep(250); await page.click('数据统计'); }, { ...opts, settle: 2000 });
    for (const range of ['7', '30', '90']) {
      const tab = await page.evaluate(`(() => { const b = [...document.querySelectorAll('main button, main [role=tab], main [role=radio]')].find(e => e.textContent.trim().startsWith('${range}')); if (!b) return false; b.setAttribute('data-perf-range', '${range}'); return true; })()`);
      if (tab) await measure(page, `stats range ${range}`, () => page.click(`[data-perf-range="${range}"]`), { ...opts, settle: 1200 });
    }
  },
  async palette(page, opts) {
    await page.goto('/');
    await page.sleep(1500);
    await measure(page, 'open command palette', () => page.key('p', 'KeyP', 4 | 8), opts);
    await measure(page, 'palette type query', () => page.type('Fix flaky', 40), opts);
    await measure(page, 'palette arrow to the end', async () => { await page.key('Backspace'); for (let i = 0; i < 9; i++) await page.key('Backspace'); await page.key('ArrowUp'); await page.key('ArrowUp'); }, opts);
    await page.key('Escape');
    await page.sleep(400);
    await measure(page, 'open search (⌘K)', () => page.key('k', 'KeyK', 4), opts);
    await measure(page, 'search type title', () => page.type('Fix', 60), opts);
    await page.key('Escape');
  },
  async settings(page, opts) {
    await page.goto('/settings');
    await page.sleep(1500);
    const sections = await page.evaluate(`[...document.querySelectorAll('[role=dialog] nav button, [role=dialog] [role=tab], [role=dialog] nav a')].filter(b => b.getClientRects().length).map((b, i) => { b.setAttribute('data-perf-section', i); return b.textContent.trim(); })`);
    // One line per section: a section that opens slowly or scrolls badly is named.
    const only = flag('section', '');
    for (let i = 0; i < sections.length; i++) {
      if (only && !sections[i].includes(only)) continue;
      await measure(page, `settings · ${sections[i]}`, async () => {
        await page.click(`[data-perf-section="${i}"]`);
        await page.sleep(500);
        const found = await page.evaluate(`(() => { const el = [...document.querySelectorAll('[role=dialog] *')].filter(e => e.scrollHeight > e.clientHeight + 100 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && !e.closest('nav')).sort((a, b) => b.clientHeight - a.clientHeight)[0]; document.querySelectorAll('[data-perf-pane]').forEach(e => e.removeAttribute('data-perf-pane')); el?.setAttribute('data-perf-pane', ''); return !!el; })()`);
        if (found) await page.scroll('[data-perf-pane]', 2000, 4000);
      }, { ...opts, settle: 300 });
    }
  },
  async streaming(page, opts) {
    const dir = resolve(flag('dir', '/tmp/riffet-web-perf'));
    const manifest = JSON.parse(readFileSync(join(dir, 'seed.json'), 'utf8'));
    const live = manifest.sessions.find(s => s.title.startsWith('进行中'));
    const id = await sessionByTitle(page, '进行中');
    await page.goto(`/c/${id}`);
    await page.sleep(2000);
    await measure(page, 'session receiving 16 turns', () => appendTurns(live, 16, 400), { ...opts, settle: 2500 });
  },
  async offline(page, opts) {
    const id = await sessionByTitle(page, '转录渲染（超长）');
    await page.goto(`/c/${id}`);
    await page.sleep(2000);
    await page.send('Network.enable');
    await measure(page, 'offline 20s', async () => {
      await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await page.sleep(20_000);
    }, opts);
    await measure(page, 'back online', async () => {
      await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }, { ...opts, settle: 4000 });
    await measure(page, 'slow 3G open session', async () => {
      await page.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 20_000 });
      const other = await sessionByTitle(page, '大 diff 与长输出');
      await page.evaluate(`history.pushState(null, '', '/c/${other}'); dispatchEvent(new PopStateEvent('popstate'))`);
    }, { ...opts, settle: 6000 });
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  },
  async idle(page, opts) {
    const id = await sessionByTitle(page, '转录渲染（超长）');
    await page.goto(`/c/${id}`);
    await page.sleep(3000);
    await measure(page, `idle ${flag('seconds', 10)}s on a session`, () => page.sleep(Number(flag('seconds', 10)) * 1000), { ...opts, settle: 0 });
  },
};

/**
 * A virtualized list that keeps the reader's place compensates rows mounting above by moving
 * scrollTop, so neither CLS nor scrollTop deltas say what the reader sees (CLS counts the
 * compensation as a shift). This tracks the on-screen movement of a row near the top every frame
 * and counts frames whose movement departs from the recent pace of the gesture: those are jumps.
 */
async function withJumps(page, label, action, opts) {
  await page.evaluate(`(() => {
    const el = document.querySelector('[data-perf-transcript]');
    const top = el.getBoundingClientRect().top;
    const track = window.__jumps = { last: null, pace: [], sizes: [], on: true };
    const loop = () => {
      if (!track.on) return;
      const rows = new Map([...el.querySelectorAll('[data-row-key]')].map(r => [r.dataset.rowKey, r.getBoundingClientRect().top]));
      const key = track.last && [...rows.keys()].find(k => track.last.has(k) && rows.get(k) > top + 80);
      if (key) {
        const moved = rows.get(key) - track.last.get(key);
        const sorted = [...track.pace].sort((a, b) => a - b);
        const pace = sorted[sorted.length >> 1];
        if (track.pace.length >= 3 && Math.abs(moved - pace) > Math.max(32, Math.abs(pace))) track.sizes.push(Math.round(moved - pace));
        track.pace.push(moved); if (track.pace.length > 5) track.pace.shift();
      }
      track.last = rows;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  })()`);
  await measure(page, label, action, opts);
  const sizes = await page.evaluate('(() => { window.__jumps.on = false; return window.__jumps.sizes; })()');
  console.log(`    visible jumps of the reading row: ${sizes.length}${sizes.length ? ` (${sizes.slice(0, 12).join(', ')} px)` : ''}`);
}

async function markTranscript(page) {
  await page.evaluate(`(() => {
    const candidates = [...document.querySelectorAll('main *')].filter(e => e.scrollHeight > e.clientHeight + 400 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
    const el = candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0];
    el?.setAttribute('data-perf-transcript', '');
    return !!el;
  })()`);
}

// ---- main ---------------------------------------------------------------------------------------

/**
 * A Vite config that wraps the web's own: output in <dir>/public (never dist/, which a running server
 * serves), preview on its own port proxying to the perf server. It lives under node_modules/.cache so
 * the packages it imports resolve.
 */
function viteWrapper(dir) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const folder = join(root, 'node_modules/.cache/web-perf');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'vite.config.mjs');
  writeFileSync(path, `import base from '../../../apps/web/vite.config.ts';
const target = process.env.PERF_BACKEND ?? 'http://127.0.0.1:4417';
const port = Number(process.env.PERF_PORT ?? 5273);
export default async (env) => {
  const config = await (typeof base === 'function' ? base(env) : base);
  const proxy = Object.fromEntries(Object.entries(config.server.proxy).map(([k, v]) => [k, { ...v, target }]));
  return {
    ...config,
    preview: { host: '127.0.0.1', port, strictPort: true, proxy },
    build: { ...config.build, outDir: ${JSON.stringify(join(resolve(dir), 'public'))}, emptyOutDir: true, minify: process.env.PERF_MINIFY !== '0' },
  };
};
`);
  return { root, path };
}

if (command === 'build' || command === 'preview') {
  if (!names[0]) throw new Error(`${command} needs the perf directory`);
  const { root, path } = viteWrapper(names[0]);
  const env = { ...process.env, PERF_MINIFY: flag('minify', false) ? '1' : '0', PERF_PORT: String(flag('port', 5273)), PERF_BACKEND: flag('server', 'http://127.0.0.1:4417') };
  const result = spawnSync('npx', ['vite', command, '--config', path], { cwd: root, env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else if (command === 'seed') {
  await seed(names[0], flag('server', 'http://127.0.0.1:4417'), { shortSessions: Number(flag('sessions', 3000)) });
} else if (command === 'stream') {
  const manifest = JSON.parse(readFileSync(join(resolve(names[0]), 'seed.json'), 'utf8'));
  await appendTurns(manifest.sessions.find(s => s.title.startsWith('进行中')), Number(flag('turns', 20)), Number(flag('every', 500)));
} else if (command === 'list') {
  console.log(Object.keys(SCENARIOS).join('\n'));
} else if (command === 'run') {
  const opts = { profile: !!flag('profile', false), alloc: !!flag('alloc', false) };
  const page = await browser({ cdp: flag('cdp', 'http://127.0.0.1:9577'), url: flag('url', 'http://127.0.0.1:5273'), mobile: !!flag('mobile', false), cpu: flag('cpu', 1) });
  await page.goto('/');
  await page.sleep(1000);
  for (const name of names.length ? names : Object.keys(SCENARIOS)) {
    if (!SCENARIOS[name]) { console.error(`unknown scenario ${name}`); continue; }
    try { await SCENARIOS[name](page, opts); } catch (error) { console.log(`${name}: ${error.message}`); }
  }
  page.close();
} else {
  console.error('usage: web-perf.mjs seed <dir> | build <dir> | preview <dir> | stream <dir> | run [scenario ...] [--mobile] [--cpu N] [--profile] [--alloc] | list');
  process.exit(2);
}
