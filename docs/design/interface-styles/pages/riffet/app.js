(() => {
const D = window.DATA, M = window.MARKS;
const conv = D.conversation;

/* ---------- icons: 24 box, 1.6 stroke, round; closed shapes carry a 16% fill so the set reads as one family ---------- */
const gear = (() => {
  const pts = [], rad = a => a * Math.PI / 180;
  for (let i = 0; i < 8; i++) {
    const c = i * 45;
    [[c - 16, 7.3], [c - 9, 9.6], [c + 9, 9.6], [c + 16, 7.3]].forEach(([a, r]) => pts.push(`${(12 + r * Math.sin(rad(a))).toFixed(2)} ${(12 - r * Math.cos(rad(a))).toFixed(2)}`));
  }
  return `<path class="f" d="M${pts.join('L')}Z"/><circle cx="12" cy="12" r="2.8"/>`;
})();
const IC = {
  compose: '<path class="f" d="M4 7a3 3 0 0 1 3-3h5l-2 2H7a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3l2-2v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" stroke="none"/><path d="M12 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-5"/><path class="f" d="m9 15 .6-3.2L17.8 3.6a1.8 1.8 0 0 1 2.6 2.6L12.2 14.4z"/>',
  search: '<circle class="f" cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/>',
  clock: '<circle class="f" cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bookmark: '<path class="f" d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z"/>',
  puzzle: '<path class="f" d="M10 4.5a2 2 0 1 1 4 0V6h3.5A1.5 1.5 0 0 1 19 7.5V11h-1.5a2 2 0 1 0 0 4H19v3.5a1.5 1.5 0 0 1-1.5 1.5H14v-1.5a2 2 0 1 0-4 0V20H6.5A1.5 1.5 0 0 1 5 18.5V15h1.5a2 2 0 1 0 0-4H5V7.5A1.5 1.5 0 0 1 6.5 6H10z"/>',
  folder: '<path class="f" d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v7.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  folderPlus: '<path d="M12.5 19H5a1.5 1.5 0 0 1-1.5-1.5v-10A1.5 1.5 0 0 1 5 6h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5V12"/><path d="M18 15.5v5M15.5 18h5"/>',
  sliders: '<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2"/><circle cx="9" cy="16" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  chevd: '<path d="m6 9 6 6 6-6"/>',
  dots: '<circle class="s" cx="5.5" cy="12" r="1.5"/><circle class="s" cx="12" cy="12" r="1.5"/><circle class="s" cx="18.5" cy="12" r="1.5"/>',
  panelL: '<rect class="f" x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
  panelR: '<rect class="f" x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M14.5 4.5v15"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle class="s" cx="12" cy="7.8" r=".9"/>',
  gear,
  terminal: '<rect class="f" x="3.5" y="4.5" width="17" height="15" rx="3.5"/><path d="m8 10 3 2.5L8 15M13 15h3.5"/>',
  file: '<path class="f" d="M6 3.5h8l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5z"/><path d="M14 3.5V8h4.5"/>',
  pencil: '<path class="f" d="m5 19 .7-4L15.6 5a2 2 0 0 1 2.8 2.8L8.5 17.7z"/><path d="m14 6.8 3.2 3.2"/>',
  grep: '<circle class="f" cx="10.5" cy="10.5" r="5.5"/><path d="m20 20-5.6-5.6M8.5 10.5h4"/>',
  bulb: '<path class="f" d="M9 17.5V16c0-1-.8-1.8-1.5-2.8A5.5 5.5 0 1 1 16.5 13c-.7 1-1.5 1.8-1.5 3v1.5z"/><path d="M9.5 20.5h5"/>',
  shield: '<path class="f" d="M12 3.5 5 6v5.5c0 4.2 2.8 7.3 7 9 4.2-1.7 7-4.8 7-9V6z"/><path d="m9 12 2.2 2.2L15.2 10"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  stop: '<rect class="s" x="7" y="7" width="10" height="10" rx="2"/>',
  branch: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="9" r="2"/><path d="M7 8v8M17 11c0 3-3 3.5-10 5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1"/><path d="M18 3.5v3.8h-3.8M6 20.5v-3.8h3.8"/>',
  expand: '<path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5V9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15M15 20h3.5a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5" class="f"/><path d="M15.5 8.5V6.5A2.5 2.5 0 0 0 13 4H6.5A2.5 2.5 0 0 0 4 6.5V13a2.5 2.5 0 0 0 2.5 2.5h2"/>',
  chat: '<path class="f" d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 16h-6.5L8 19.5V16H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 5z"/>',
  bolt: '<path class="f" d="M13 3.5 5.5 13.5H11l-1 7 7.5-10H12z"/>',
  attach: '<path d="M12 5v14M5 12h14"/>',
  archive: '<rect class="f" x="3.5" y="5" width="17" height="4.5" rx="1.5"/><path d="M5.5 9.5V18a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V9.5M10 13h4"/>',
  split: '<path d="M12 4v5M12 9c0 3-6 3-6 7v4M12 9c0 3 6 3 6 7v4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  star: '<path class="f" d="m12 4 2.4 5 5.4.7-4 3.8 1 5.4-4.8-2.7-4.8 2.7 1-5.4-4-3.8 5.4-.7z"/>',
};
const ico = (n, s = 16, c = '') => `<svg class="ic ${c}" width="${s}" height="${s}" viewBox="0 0 24 24">${IC[n]}</svg>`;
const spinner = (s = 14, col = 'var(--accent)') => `<svg class="spin" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2.6" stroke-linecap="round"><circle cx="12" cy="12" r="8.5" stroke-opacity=".2"/><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5"/></svg>`;
const agent = (a, s = 14) => a === 'cursor' ? `<span style="color:var(--fg)">${M.cursor(s)}</span>` : M[a](s);
const ring = (pct, s = 18) => { const r = 7, c = 2 * Math.PI * r; return `<svg class="ring" width="${s}" height="${s}" viewBox="0 0 20 20" style="transform:rotate(-90deg)"><circle cx="10" cy="10" r="${r}" fill="none" stroke="var(--line-strong)" stroke-width="2.4"/><circle cx="10" cy="10" r="${r}" fill="none" stroke="var(--fg-3)" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${c * pct} ${c}"/></svg>`; };
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const md = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

/* ---------- sidebar ---------- */
const times = ['刚刚', '8 分钟', '6 分钟', '41 分钟', '2 小时', '3 小时', '5 小时', '1 天', '1 天', '1 天', '2 天', '3 天'];
function srow(s, i, o = {}) {
  const cls = ['srow', s.selected ? 'sel' : '', s.state === 'unread' ? 'unread' : '', o.hov ? 'hov' : ''].join(' ');
  let tail = `<span class="tail">${o.time || ''}</span>`;
  if (s.state === 'running') tail = `<span class="tail">${spinner(13)}</span>`;
  if (s.state === 'awaiting') tail = `<span class="tail"><i class="dot a"></i></span>`;
  if (s.state === 'unread') tail = `<span class="tail"><i class="dot u"></i></span>`;
  const bm = o.pin ? `<span class="bm">${ico('bookmark', 12)}</span>` : '';
  return `<div class="${cls}"><span class="mk">${agent(s.agent, 13)}</span><span class="t">${s.title}</span>${bm}${tail}</div>`;
}
function sidebar(sel = true) {
  const all = D.buckets.flatMap(b => b.sessions);
  const wk = all.filter(s => s.project === 'riffet').slice(0, 7).map(s => ({ ...s, selected: sel && s.selected }));
  const ag = all.filter(s => s.project === 'docs-site');
  const cm = [...D.pinned.map(p => ({ ...p, pin: true })), all.find(s => !s.project)];
  let n = 0;
  const rows = (arr, opt = () => ({})) => arr.map(s => srow(s, n, { time: times[Math.min(n++ + (s.state ? 1 : 0), 11)], pin: s.pin, ...opt(s) })).join('');
  return `<aside class="sb">
  <div class="sb-top"><div class="lights"><i></i><i></i><i></i></div>
    <div class="brand">${M.brand(20, '#2a2c2e', '#3867f0').replace('#2a2c2e', 'var(--fg)')}Riffet</div>
    <button class="ibtn">${ico('panelL', 17)}</button></div>
  <nav class="sb-nav">
    <div class="nrow">${ico('compose', 18)}新会话</div>
    <div class="nrow">${ico('search', 18)}搜索内容<span class="k">⌘K</span></div>
    <div class="nrow">${ico('clock', 18)}自动化</div>
    <div class="nrow">${ico('bookmark', 18)}收藏夹</div>
    <div class="nrow">${ico('puzzle', 18)}插件</div>
  </nav>
  <div class="sb-scroll">
    <div class="sec">项目<span class="acts"><button class="ibtn">${ico('sliders', 15)}</button><button class="ibtn">${ico('folderPlus', 15)}</button></span></div>
    <div class="proj">${ico('folder', 16)}riffet</div>${rows(wk)}
    <div class="more">${ico('dots', 14)}展开其余 12 个会话</div>
    <div class="proj">${ico('folder', 16)}docs-site</div>${rows(ag)}
    <div class="more">${ico('dots', 14)}展开其余 9 个会话</div>
    <div class="proj">${ico('folder', 16)}common</div>${rows(cm)}
  </div>
  <div class="sb-foot"><div class="av">H</div><button class="ibtn">${ico('dots', 16)}</button><button class="ibtn">${ico('gear', 17)}</button></div>
</aside>`;
}

/* ---------- tab bar ---------- */
const tabs = (showInspBtn = true, inspOn = false) => `<div class="tabbar">
  <div class="tab on">${spinner(14)}<span class="t">${conv.title}</span><span class="x">${ico('x', 11)}</span></div>
  <div class="tab">${agent('claude', 14)}<span class="t">riffet 语音输入开源方案</span><i class="dot"></i></div>
  <button class="ibtn" style="margin-left:2px">${ico('plus', 16)}</button>
  <div class="sp"></div>
  <div class="right"><button class="ibtn" style="position:relative">${ico('info', 17)}<i class="badge"></i></button><button class="ibtn ${inspOn ? 'on' : ''}">${ico('panelR', 17)}</button><button class="ibtn">${ico('dots', 16)}</button></div>
</div>`;

/* ---------- transcript ---------- */
const toolIcon = { Read: 'file', Bash: 'terminal', Grep: 'grep', Write: 'pencil' };
function toolRow(t) {
  const i = t.target.lastIndexOf('/'), dir = i >= 0 ? t.target.slice(0, i + 1) : '', fn = t.target.slice(i + 1);
  const body = t.name === 'Bash' || t.name === 'Grep'
    ? `<span class="cmd">${esc(t.target)}</span>` : `<span class="dir">${esc(dir)}</span><span class="fn">${esc(fn)}</span>`;
  return `<div class="tool">${ico(toolIcon[t.name], 15)}<span class="nm">${t.name}</span>${body}<span class="meta">${t.meta}</span></div>`;
}
function transcript() {
  const u = conv.turns[0], a = conv.turns[1], ap = conv.turns[2];
  return `<div class="turn">
    <div class="ubub">${u.text}</div>
    <div class="think">${ico('bulb', 15)}<span>${a.thinking}</span></div>
    <div class="tgroup">${a.tools.map(toolRow).join('')}</div>
    <p class="p">${md(a.text)}</p>
    <div class="code"><div class="h">${a.code.lang}<span style="color:var(--fg-4)">·</span><span class="fn">${a.code.file}</span><button class="ibtn">${ico('copy', 14)}</button></div>
      ${a.code.diff.map(([k, t], j) => `<div class="ln ${k === '+' ? 'a' : 'd'}"><span class="g">${k === '+' ? '+' : '−'}</span><span class="tx">${esc(t)}</span></div>`).join('')}<div class="pad"></div></div>
    <div class="ask">
      <div class="hd"><span class="tic">${ico('terminal', 14)}</span><h3>${ap.tool}</h3><span class="cd tnum">09:48 后自动拒绝</span></div>
      <div class="why">${ap.text}</div>
      <div class="cmdbox"><b>$</b>${esc(ap.command)}</div>
      <div class="opts"><div class="opt on"><span class="radio"></span>仅此一次</div><div class="opt"><span class="radio"></span>本会话内允许</div></div>
      <div class="ft"><button class="btn quiet">拒绝</button><button class="btn pri">允许</button></div>
    </div>
    <div class="status"><i class="d"></i><b>${conv.running.replace('正在编辑', '正在编辑')}</b><span class="s tnum">1m 12s</span><span class="s tnum">96 tok/s</span></div>
  </div>`;
}

/* ---------- composer ---------- */
function composer(o = {}) {
  const run = o.running !== false;
  return `<div class="composer"><div class="ph">${o.ph || '输入下一条消息…'}</div>
    <div class="bar"><button class="pill ic1">${ico('attach', 18)}</button>${o.backend ? `<button class="pill" style="padding-left:6px;gap:7px">${ico('shield', 17)}Auto mode</button>` : `<button class="pill ic1" style="color:var(--fg-2)">${ico('shield', 17)}</button>`}<button class="pill ic1">${ico('puzzle', 17)}</button>
      <div class="sp"></div>${o.backend ? `<button class="pill">${agent('claude', 15)}Claude Code</button>` : agent('claude', 15)}${ring(.35)}<button class="pill" style="padding-left:6px">${conv.model} High</button>
      <span class="send ${run ? '' : 'idle'}">${run ? ico('stop', 18) : ico('arrowUp', 18)}</span></div></div>`;
}

const outline = () => `<div class="rail">
  <div class="rsec"><div class="rh">本会话<b>3</b></div>
    <div class="ri"><span class="n">1</span><span class="t">Android 页面转场有哪些常见卡顿点</span></div>
    <div class="ri"><span class="n">2</span><span class="t">先打开 RiffetLifecycle 日志</span></div>
    <div class="ri cur"><span class="n">3</span><span class="t">${conv.turns[0].text}</span></div></div>
  <div class="rsec"><div class="rh">子 Agent<b>1 进行中</b></div><div class="ri"><i class="gd"></i><span class="t">Explore TaskList 重组路径</span></div></div>
  <div class="rsec"><div class="rh">后台任务<b>1 进行中</b></div><div class="ri">${spinner(14, 'var(--fg-3)')}<span class="t">adb logcat -s RiffetLifecycle</span><span class="pl">0:42</span></div></div>
  <div class="rsec"><div class="rh">产出<b>${D.inspector.changes.length} 个文件</b></div>
    ${D.inspector.changes.map(c => `<div class="ri file"><span class="t">${c.file.split('/').pop()}</span><span class="pm"><span class="ad">+${c.add}</span>${c.del ? `<span class="dl">−${c.del}</span>` : ''}</span></div>`).join('')}</div>
</div>`;

const inspector = () => `<section class="card insp" style="left:1052px;width:380px">
  <div class="tabs">${D.inspector.tabs.map((t, i) => `<span class="utab ${i ? '' : 'on'}">${t}</span>`).join('')}<span class="r"><button class="ibtn">${ico('expand', 16)}</button><button class="ibtn">${ico('x', 16)}</button></span></div>
  <div class="iprow"><div class="seg"><span class="on">改动</span><span>检查点</span><span>Worktree</span></div><button class="ibtn">${ico('refresh', 16)}</button></div>
  <div class="brow">${ico('branch', 15)}<span class="m">main</span><span class="mono" style="font-size:12px;color:var(--fg-3)">↑9</span><span class="sum"><span style="margin-right:2px">${D.inspector.changes.length} 个文件</span><span class="ad">+18</span><span class="dl">−10</span></span></div>
  <div class="stage"><button class="btn quiet sm">全部暂存</button><button class="btn quiet sm" style="color:var(--fg-4)">全部取消</button></div>
  <div style="margin-top:4px">${D.inspector.changes.map((c, i) => { const j = c.file.lastIndexOf('/'); return `<div class="frow ${i === 1 ? 'hov' : ''}"><span class="fn">${c.file.slice(j + 1)}</span><span class="pth">${j > 0 ? c.file.slice(0, j) : ''}</span><span class="pm"><span class="ad">+${c.add}</span>${c.del ? `<span class="dl">−${c.del}</span>` : ''}</span><span class="st">M</span></div>`; }).join('')}</div>
  <div class="commit"><div class="ta">提交说明（⌘↵ 提交）</div><button class="btn pri">${ico('branch', 15)}提交</button></div>
</section>`;

/* ---------- frames ---------- */
function mainInner(mode) {
  const insp = mode === 'inspector';
  const w = insp ? 788 : 1176;
  return `${sidebar()}
  <section class="card" style="left:256px;width:${w}px">
    ${tabs(true, insp)}
    <div class="scroll"><div class="fade"></div>
      <div class="col">${transcript()}</div>
      ${insp ? `<div class="ticks"><i></i><i></i><i></i><i></i><i></i><i></i><i class="on"></i></div>` : outline()}
      <div class="dock"><button class="togo" style="right:0;bottom:152px">${ico('arrowDown', 16)}</button>${composer()}<div class="dots"><i class="on"></i><i></i><i></i></div></div>
    </div>
  </section>${insp ? inspector() : ''}`;
}

function home() {
  return `${sidebar(false)}
  <section class="card" style="left:256px;width:1176px">
    <div class="tabbar"><button class="ibtn">${ico('plus', 16)}</button><div class="sp"></div></div>
    <div class="hometabs"><span class="utab h on">新建任务</span><span class="utab h">快速对话</span></div>
    <div class="home">
      <button class="psel">${ico('folder', 16)}riffet<span class="br">main</span>${ico('chevd', 14, '')}</button>
      ${composer({ ph: '描述任务，@ 引用文件，/ 使用命令或 Skill', running: false, backend: true })}
      <div class="chips"><span class="chip">${ico('terminal', 15)}Shell 终端</span><span class="chip">${ico('split', 15)}并行尝试</span></div>
      <div class="sugg"><div class="rh">建议</div>${D.suggestions.map(s => `<div class="sg">${ico('chat', 15)}${s}</div>`).join('')}</div>
    </div>
  </section>`;
}

function palette() {
  const sess = D.commands[0].items, ops = D.commands[1].items, opIc = ['compose', 'chat', 'panelR', 'gear'], ks = ['⌘N', '⌥⌘N', '⌘B', '⌘,'];
  const tm = ['刚刚', '1 天', '2 天'];
  return `${mainInner('outline')}<div class="scrim"></div>
  <div class="dlg"><div class="in">${ico('search', 20)}<span class="caret"></span><span style="margin-left:-6px">搜索会话标题</span><button class="ibtn">${ico('x', 16)}</button></div>
    <div class="tb"><span class="utab on">标题</span><span class="utab">内容</span></div>
    <div class="g"><div class="gl">最近会话</div>${sess.map((s, i) => `<div class="r ${i ? '' : 'sel'}">${ico('chat', 18)}<div><div class="tt">${s}</div><div class="sub">riffet</div></div><span class="tm">${tm[i]}</span></div>`).join('')}
    <div class="gl" style="margin-top:6px">操作</div>${ops.map((o, i) => `<div class="r cmd">${ico(opIc[i], 17)}<span class="tt">${o}</span><kbd>${ks[i]}</kbd></div>`).join('')}<div class="pad"></div></div>
  </div>`;
}

const put = (name, html, cls = '') => { const el = document.querySelector(`[data-frame="${name}"]`); if (!el) return; el.innerHTML = html; if (cls) el.classList.add(cls); };
put('main', mainInner('inspector'));
put('outline', mainInner('outline'));
put('home', home());
put('palette', palette());
put('dark', mainInner('inspector'), 'dark');
window.__W = { ico, agent, spinner, ring, srow, tabs };
if (window.__spec) window.__spec();
})();
