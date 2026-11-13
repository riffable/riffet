(() => {
const D = window.DATA, M = window.MARKS;

/* Lucide paths, drawn at a constant 1.25px stroke (apps/web/src/components/icons-base.tsx). */
const IC = {
  compose: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  blocks: '<rect width="7" height="7" x="14" y="3" rx="1"/><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"/>',
  panelL: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  panelR: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  dots: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  diff: '<path d="M12 3v14"/><path d="M5 10h14"/><path d="M5 21h14"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  phone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
  logs: '<path d="M13 12h8"/><path d="M13 18h8"/><path d="M13 6h8"/><path d="M3 12h1"/><path d="M3 18h1"/><path d="M3 6h1"/><path d="M8 12h1"/><path d="M8 18h1"/><path d="M8 6h1"/>',
  chevd: '<path d="m6 9 6 6 6-6"/>',
  chevr: '<path d="m9 18 6-6-6-6"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  branch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  max: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  tools: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
};
const ico = (n, s = 16) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24">${IC[n]}</svg>`;
const spinner = (s = 13) => `<svg class="spin" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" style="color:var(--fg-3)"><circle cx="12" cy="12" r="9" stroke-opacity=".2"/><path d="M12 3a9 9 0 0 1 9 9"/></svg>`;
// Agent marks in the chrome are one colour; the brand colours stay in the agent picker and the about page.
const mark = (a, s = 14) => `<span class="mk">${M[a](s).replace(/fill="(#[0-9A-Fa-f]+|url\(#cxg\))"/g, 'fill="currentColor"')}</span>`;
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const md = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

/* ---------- sidebar: 置顶 / 进行中 / 今天, as the Mac has it now ---------- */
function sidebar() {
  const today = D.buckets[0].sessions.filter(s => s.state !== 'running');
  const times = ['8 分钟', '41 分钟', '1 小时', '2 小时', '2 小时', '3 小时', '4 小时', '5 小时'];
  const row = (s, tail, extra = '') => `<div class="srow ${extra}"><span class="t ell">${s.title}</span>${tail}</div>`;
  return `<aside class="sb">
  <div class="sb-top"><div class="lights"><i></i><i></i><i></i></div>
    <div class="brand">${M.brand(18)}Riffet</div><span class="ib">${ico('panelL')}</span></div>
  <nav class="nav">
    <div class="nrow">${ico('compose', 18)}新会话</div>
    <div class="nrow">${ico('search', 18)}搜索内容<span class="k">⌘K</span></div>
    <div class="nrow">${ico('clock', 18)}定时任务</div>
    <div class="nrow">${ico('bookmark', 18)}收藏夹</div>
    <div class="nrow">${ico('blocks', 18)}插件</div>
  </nav>
  <div class="sec">置顶</div>
  <div class="list">${D.pinned.map((p, i) => row(p, `<span class="tail">${['16 分钟', '10 天'][i]}</span>`)).join('')}</div>
  <div class="sec">进行中</div>
  <div class="list">${row(D.buckets[0].sessions[0], `<span class="tail">${spinner()}</span>`, 'sel')}</div>
  <div class="sec">今天</div>
  <div class="list">${today.map((s, i) => row(s,
    s.state === 'awaiting' ? '<span class="state">待确认</span>' : s.state === 'unread' ? '<span class="tail"><i class="dot"></i></span>' : `<span class="tail">${times[i]}</span>`,
    s.state === 'unread' ? 'unread' : '')).join('')}</div>
  <div class="sb-foot"><div class="av">R</div><span class="ib">${ico('dots')}</span><span class="ib">${ico('gear')}</span></div>
</aside>`;
}

/* ---------- main card ---------- */
function tabs(panelOn) {
  const t = [
    { title: D.conversation.title, agent: 'claude', on: true, running: true },
    { title: 'riffet 语音输入开源方案', agent: 'claude' },
    { title: '检查数据导出脚本', agent: 'codex' },
    { title: 'Cursor 无思考内容消息流式输出', agent: 'cursor' },
  ];
  return `<div class="head">${t.map(x => `<div class="tab ${x.on ? 'on' : ''}">${x.running ? spinner(13) : mark(x.agent, 13)}<span class="ell">${x.title}</span>${x.on ? `<span class="x">${ico('x', 12)}</span>` : ''}</div>`).join('')}
  <div class="tab more">+2 ${ico('chevd', 12)}</div><span class="ib">${ico('plus')}</span>
  <div class="sp"></div><span class="ib">${ico('info')}</span><span class="ib ${panelOn ? 'on' : ''}">${ico('panelR')}</span><span class="ib">${ico('dots')}</span></div>`;
}

function transcript() {
  const c = D.conversation, a = c.turns[1];
  return `<div class="col read">
  <div class="user first"><div class="b"><p>真机上从任务列表点进会话，转场前 200ms 明显掉帧，帮我查一下是哪一层在重组。</p><p>改完在测试机上录一段对比。</p></div></div>
  <div class="fold">${ico('chevr', 12)}已处理 · 1m 41s</div>
  <div class="past">
    <p>找到了。${md('`LocalScrollState` 用的是 `staticCompositionLocalOf`，导航时值变化会让整棵页面子树重新组合；日志里 `TaskList` 在转场开始时出现了一次 `-` 再 `+`。')}</p>
    <p>改成 ${md('`compositionLocalOf`')} 之后只有读取它的节点会重组。另外两处一起改了：</p>
    <ul>
      <li>${md('`TaskListScreen` 的筛选条移出 `when` 分支，只保留一个调用点，切换筛选不再重建列表。')}</li>
      <li>${md('`RiffetPageScaffold` 的淡入改到转场结束之后，首帧不再等布局。')}</li>
    </ul>
    <div class="code"><div class="ch">kotlin<span>·</span>${a.code.file}<span class="ib">${ico('copy', 14)}</span></div><pre>${a.code.diff.map(([m, l]) => `<div class="l ${m === '+' ? 'a' : 'd'}"><span class="m">${m}</span><span>${esc(l)}</span></div>`).join('')}</pre></div>
    <p>真机上重新录了一次，转场前 200ms 的掉帧没有了。</p>
  </div>
  <div class="metarow"><span class="tnum">17:10</span><span class="tnum">51 tok/s</span><span class="ib">${ico('copy', 14)}</span><span class="ib">${ico('dots', 14)}</span></div>

  <div class="user"><div class="b"><p>顺便看下 iOS 那边是不是同样的问题，有的话一起改掉，然后装到测试机上。</p></div></div>

  <p>iOS 的会话页用的是 SwiftUI 的 ${md('`NavigationStack`')}，先确认转场期间有没有子树被重新创建。</p>
  <div class="tools">
    ${[['file', 'Read', 'apps/ios/Riffet/Session/SessionView.swift', '318 行'],
       ['search', 'Grep', 'EnvironmentObject', '9 处'],
       ['terminal', 'Bash', 'xcodebuild -scheme Riffet -destination generic/platform=iOS', '42s']]
      .map(([i, n, t, m]) => `<div class="tool">${ico(i, 14)}<span class="nm">${n}</span><span class="tg ell">${t}</span><span class="meta tnum">${m}</span></div>`).join('')}
  </div>
  <p>${md('iOS 没有同样的问题：`SessionView` 的环境对象在转场前后是同一个实例。构建通过，正在装到测试机。')}</p>
  <div class="live">${spinner(12)}<span>正在运行 xcrun devicectl</span><span class="tnum">· 57s</span></div>
</div>`;
}

function composer(running) {
  return `<div class="composer"><div class="ph">输入下一条消息…</div>
  <div class="bar"><span class="ib">${ico('plus')}</span><span class="chip">Auto${ico('chevd', 12).replace('class="ic"', 'class="ic cv"')}</span>
  <div class="sp"></div>
  <span class="chip">${mark('claude', 13)}Opus 5.5 · High · Fast${ico('chevd', 12).replace('class="ic"', 'class="ic cv"')}</span>
  ${running ? `<span class="send"><svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="currentColor"/></svg></span>` : `<span class="send off">${ico('up', 15)}</span>`}</div></div>`;
}

/* ---------- right panel: one row of views (icons, the current one labelled), then the view's own controls ---------- */
function panel() {
  const views = [['diff', '变更', true], ['file', '文件'], ['globe', '浏览器'], ['phone', 'Android'], ['logs', 'Logcat']];
  const files = [['TASK-BOARD.md', 'docs', 349, 'U', true], ['task-board-demo.html', 'docs/design', 676, 'U'], ['riffet-style.md', 'docs/design', 212, 'U']];
  return `<section class="card panel">
  <div class="head">${views.map(([i, l, on]) => `<span class="vt ${on ? 'on' : ''}">${ico(i)}${on ? l : ''}</span>`).join('')}
    <div class="sp"></div><span class="ib">${ico('max', 15)}</span><span class="ib">${ico('x', 15)}</span></div>
  <div class="pbar"><span class="seg on">Changes</span><span class="seg">History</span><span class="seg">Checkpoints</span><span class="seg">Worktrees</span></div>
  <div class="repo">${ico('branch', 14)}<span class="mono">main</span><span class="tnum" style="color:var(--fg-3)">↑2</span><span class="r tnum">3 files <span class="add">+1,237</span></span><span class="ib" style="margin-right:-10px">${ico('refresh', 14)}</span></div>
  <div class="lh"><span class="cb"></span>Staged 0 / 3<span class="chip">Uncommitted${ico('chevd', 12).replace('class="ic"', 'class="ic cv"')}</span></div>
  ${files.map(([n, d, a, s, sel]) => `<div class="frow ${sel ? 'sel' : ''}"><span class="cb"></span><span class="ell">${n}</span><span class="dir ell">${d}</span><span class="n add tnum">+${a}</span><span class="st">${s}</span></div>`).join('')}
  <div class="commit">Commit message<span class="send off">${ico('up', 13)}</span></div>
</section>`;
}

function frame(el, { panelOn = true } = {}) {
  el.innerHTML = sidebar() + `<section class="card main" style="right:${panelOn ? 360 : 8}px">${tabs(panelOn)}<div class="scroll">${transcript()}<div class="thumb"></div>${composer(true)}</div></section>` + (panelOn ? panel() : '');
}

frame(document.querySelector('[data-frame="main"]'));
frame(document.querySelector('[data-frame="reading"]'), { panelOn: false });
frame(document.querySelector('[data-frame="dark"]'));
})();
