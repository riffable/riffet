(() => {
const D = window.DATA, M = window.MARKS;

/* ---------- icons: 24 grid, 1.6 stroke, round ---------- */
const P = {
  sidebar: '<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="M9.5 4.5v15"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8 6.9 19.5l1-5.7-4.1-4 5.7-.8z"/>',
  starfill: '<path fill="currentColor" d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8 6.9 19.5l1-5.7-4.1-4 5.7-.8z"/>',
  puzzle: '<path d="M9.5 5.5a2 2 0 0 1 4 0V7H17.5a1 1 0 0 1 1 1v3H17a2 2 0 0 0 0 4h1.5v3a1 1 0 0 1-1 1h-3v-1.5a2 2 0 0 0-4 0V19H7a1 1 0 0 1-1-1v-3H4.5a2 2 0 0 1 0-4H6V8a1 1 0 0 1 1-1h2.5z"/>',
  briefcase: '<rect x="3.5" y="8" width="17" height="11.5" rx="2.5"/><path d="M9 8V6.5A1.500 1.500 0 0 1 10.500 5h3A1.500 1.500 0 0 1 15 6.500V8M3.500 13h17"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  chevD: '<path d="M6 9.5l6 6 6-6"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  chat: '<path d="M5.5 6.5A2.5 2.5 0 0 1 8 4h8a2.5 2.5 0 0 1 2.5 2.5v6A2.5 2.5 0 0 1 16 15h-5l-4 3.5V15a2.5 2.5 0 0 1-1.500-2.500z"/>',
  code: '<path d="M8.5 8l-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>',
  terminal: '<path d="M5 8l4 4-4 4M12 17h7"/>',
  outline: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8 9h.01M11 9h5M8 12h.01M11 12h5M8 15h.01M11 15h5"/>',
  changes: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M12 8v6M9 11h6M9 16h6"/>',
  play: '<path d="M8 5.5v13l10.500-6.500z"/>',
  folder: '<path d="M3.5 8A2.5 2.5 0 0 1 6 5.500h3l2 2h7A2.500 2.500 0 0 1 20.500 10v7a2.500 2.500 0 0 1-2.500 2.500H6A2.500 2.500 0 0 1 3.500 17z"/>',
  file: '<path d="M7.500 3.500H13l5.500 5.500v10a1.500 1.500 0 0 1-1.500 1.500H7.500A1.500 1.500 0 0 1 6 19V5a1.500 1.500 0 0 1 1.500-1.500z"/><path d="M13 3.500V9h5.500"/>',
  fileText: '<path d="M7.500 3.500H13l5.500 5.500v10a1.500 1.500 0 0 1-1.500 1.500H7.500A1.500 1.500 0 0 1 6 19V5a1.500 1.500 0 0 1 1.500-1.500z"/><path d="M9 13.500h6M9 16.500h4"/>',
  laptop: '<rect x="5" y="5.5" width="14" height="9.5" rx="2"/><path d="M3 18.500h18"/>',
  branch: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="9" r="2"/><path d="M7 8v8M17 11c0 3.500-3 4-7 4.500"/>',
  bolt: '<path d="M13 3L5.500 13.500H11L10 21l7.500-10.500H12z"/>',
  check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
  x: '<path d="M7 7l10 10M17 7L7 17"/>',
  copy: '<rect x="8.500" y="8.500" width="11" height="11" rx="3"/><path d="M15.500 8.500V7A2.500 2.500 0 0 0 13 4.500H7A2.500 2.500 0 0 0 4.500 7v6A2.500 2.500 0 0 0 7 15.500h1.500"/>',
  arrowUp: '<path d="M12 19V6M6.500 11.500L12 6l5.500 5.500"/>',
  arrowDown: '<path d="M12 5v13M6.500 12.500L12 18l5.500-5.500"/>',
  stop: '<rect x="7.500" y="7.500" width="9" height="9" rx="2.200" fill="currentColor" stroke="none"/>',
  pin: '<path d="M9 4h6l-1 5 3 3H7l3-3zM12 12v8"/>',
  archive: '<rect x="3.500" y="5" width="17" height="4.500" rx="1.500"/><path d="M5 9.500V17a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.500M10 13h4"/>',
  chart: '<path d="M6 19v-7M12 19V5M18 19v-10"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  sparkle: '<path d="M12 4l1.800 5.200L19 11l-5.200 1.800L12 18l-1.800-5.200L5 11l5.200-1.800z"/>',
  sun: '<circle cx="12" cy="12" r="3.500"/><path d="M12 4v1.500M12 18.500V20M4 12h1.500M18.500 12H20M6.300 6.300l1 1M16.700 16.700l1 1M6.300 17.700l1-1M16.700 7.300l1-1"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="3"/><path d="M7 10h.01M11 10h.01M15 10h.01M17 14H7"/>',
  download: '<path d="M12 4v11M7.500 10.500L12 15l4.500-4.500M5 19h14"/>',
  maximize: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  collapse: '<path d="M12 3v7M8.500 7L12 10.500 15.500 7M12 21v-7M8.500 17L12 13.500 15.500 17"/>',
  list: '<path d="M9 7h11M9 12h11M9 17h11M4.500 7h.01M4.500 12h.01M4.500 17h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.500v2M12 18.500v2M3.500 12h2M18.500 12h2M6 6l1.400 1.400M16.600 16.600L18 18M6 18l1.400-1.400M16.600 7.400L18 6"/><circle cx="12" cy="12" r="6.500"/>',
  shield: '<path d="M12 3.500l7 2.500v5.500c0 4.200-2.800 7.400-7 9-4.200-1.600-7-4.800-7-9V6z"/>',
};
const I = (n, s = 16, st = 1.6) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${st}" stroke-linecap="round" stroke-linejoin="round">${P[n]}</svg>`;
const tri = (dir = 'down', s = 9) => `<svg class="tri" width="${s}" height="${s}" viewBox="0 0 10 10" fill="currentColor"><path d="${dir === 'down' ? 'M2 3.500h6L5 7z' : 'M3.500 2v6L7 5z'}"/></svg>`;
const spinner = (s = 14) => `<span class="spin" style="display:grid;place-items:center;width:${s}px;height:${s}px"><svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="6" opacity=".2"/><path d="M8 2a6 6 0 0 1 6 6"/></svg></span>`;
const ring = (p = .38) => { const c = 2 * Math.PI * 6; return `<svg class="ring" viewBox="0 0 16 16" fill="none" stroke-width="2"><circle cx="8" cy="8" r="6" stroke="var(--line2)"/><circle cx="8" cy="8" r="6" stroke="var(--ink2)" stroke-linecap="round" stroke-dasharray="${(c * p).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 8 8)"/></svg>`; };
const brand = (s) => M.brand(s, 'var(--brand-front)', 'var(--brand-back)');
const pm = (a, d) => `<span class="pm"><span class="a">+${a}</span><span class="d">−${d}</span></span>`;
const ibtn = (n, cls = '', s = 18) => `<div class="ibtn ${cls}">${I(n, s)}</div>`;
const A = D.conversation, INS = D.inspector;
const totalAdd = INS.changes.reduce((x, c) => x + c.add, 0), totalDel = INS.changes.reduce((x, c) => x + c.del, 0);
const FAV = ['riffet mobile 的 agent use phase 2', 'riffet Android 项目构建插件', '整理本周的用户反馈'];

/* ---------- 侧栏 ---------- */
function srow(s, o = {}) {
  const cls = ['srow', s.selected && !o.home ? 'sel' : '', s.state === 'unread' ? 'unread' : '', o.cls || ''].join(' ');
  const tail = s.state === 'running' ? spinner(12) : s.state === 'awaiting' ? '<i class="dot amber"></i>' : s.state === 'unread' ? '<i class="dot"></i>' : o.tail !== undefined ? o.tail : (FAV.includes(s.title) ? I('starfill', 13) : '');
  return `<div class="${cls}">${o.mark ? `<span class="mk">${M[s.agent](14)}</span>` : ''}<span class="t">${s.title}</span>${o.caret ? tri('down', 9) : ''}${tail ? `<span class="tail">${tail}</span>` : ''}</div>`;
}
function side(o = {}) {
  const recent = D.buckets[0].sessions.slice(0, 6), older = D.buckets[1].sessions.slice(0, 3);
  return `<aside class="side">
    <div class="top"><div class="lights"><i></i><i></i><i></i></div>${ibtn('sidebar', '', 17)}</div>
    <div class="seg"><div class="on">${I('code', 15)}任务</div><div>${I('chat', 15)}对话</div></div>
    <div class="nav">
      <div class="nrow ${o.home ? 'sel' : ''}">${I('plus', 17)}新会话</div>
      <div class="nrow">${I('search', 17)}搜索</div>
      <div class="nrow">${I('briefcase', 17)}自定义</div>
      <div class="nrow">${I('more', 17)}更多</div>
    </div>
    <div class="list">
      <div class="glabel">置顶${tri('down', 9)}</div>
      ${srow({ title: D.pinned[0].title, agent: D.pinned[0].agent }, { mark: true })}
      ${srow({ title: D.pinned[1].title, agent: D.pinned[1].agent }, { mark: true, caret: true })}
      ${srow({ title: D.pinned[1].title + ' (fork)' }, { cls: 'fork', tail: '' })}
      <div class="glabel">最近${tri('down', 9)}<span class="sp"></span>${I('sliders', 15)}</div>
      ${recent.map(s => srow(s, o)).join('')}
      <div class="glabel">更早${tri('down', 9)}</div>
      ${older.map(s => srow(s, o)).join('')}
      <div class="more">显示更多</div>
    </div>
    <div class="acct">${brand(20)}<div class="grow"><span class="n">Ada</span><span class="s">· 本地</span>${I('chevD', 14)}</div>${ibtn('gear', '', 18)}</div>
  </aside>`;
}

/* ---------- 输入框 ---------- */
function dock(o = {}) {
  const ph = o.home ? '描述任务，@ 引用文件，/ 使用命令或 Skill' : '输入 / 使用命令';
  const left = o.home ? `<div class="it">${I('laptop', 15)}本机</div><div class="it">${I('folder', 15)}riffet</div><div class="it">${I('bolt', 15)}Auto mode</div>` : '';
  const right = `<div class="it">${M.claude(14)}${A.model} High</div>${o.home ? '' : '<div class="it">Auto mode</div>'}${ring(o.home ? 0 : .38)}`;
  return `<div class="dock ${o.wide ? 'wide' : ''}">
    <div class="comp"><div class="ibtn">${I('plus', 18)}</div><div class="ph">${ph}</div>
      ${o.running ? `<div class="send">${I('stop', 18)}</div>` : `<div class="send off">${I('arrowUp', 16, 1.9)}</div>`}</div>
    <div class="env">${left}<div class="sp"></div>${right}</div></div>`;
}

/* ---------- 顶栏 ---------- */
const acts = (on = '', home = false) => `<div class="acts">${home ? '' : ibtn('outline', on === 'outline' ? 'on' : '') + ''}${ibtn('terminal')}${home ? '' : ibtn('changes') + ibtn('play')}${ibtn('folder', on === 'folder' ? 'on' : '')}${home ? '' : ibtn('more')}</div>`;
const titleHTML = (home) => home ? '<div class="title gray"><span class="tx">新会话</span></div>' : `<div class="title">${M.claude(14)}<span class="tx">${A.title}</span>${I('chevD', 14)}</div>`;
const tbFull = (on, home) => `<div class="tb"><div class="l">${titleHTML(home)}${acts(on, home)}</div></div>`;

/* ---------- 对话 ---------- */
function conversation() {
  const [u, a, ap] = A.turns;
  const md = t => t.replace(/`([^`]+)`/g, '<code>$1</code>');
  const rows = a.tools.map(t => `<div class="tr"><span>${t.name}</span><span class="v ${t.name === 'Read' ? '' : 'm'}">${t.name === 'Read' ? t.target.split('/').pop() : t.target}</span>${tri('right', 9)}</div>`).join('');
  const fn = c => c.file.split('/').pop();
  return `<div class="scroll"><div class="col">
    <div class="srcline">在本机开始 · ${A.project}</div>
    <div class="user">${u.text}</div>
    <div class="tsum">读取 1 个文件，搜索 1 次，运行 1 条命令${tri('down', 9)}</div>
    <div class="tlist">${rows}</div>
    <div class="prose">${md(a.text)}</div>
    <div class="card sum"><div class="hd">已更改 ${INS.changes.length} 个文件<span class="sp"></span><span class="u">撤销</span></div>
      <div class="rows">${INS.changes.map(c => `<div class="fr">${I('code', 15)}<span>${fn(c)}</span><span class="sp"></span>${pm(c.add, c.del)}</div>`).join('')}
        <div class="fr all"><span>查看全部</span><span class="sp"></span>${pm(totalAdd, totalDel)}</div></div></div>
    <div class="acts-row">${ibtn('copy', '', 15)}${ibtn('branch', '', 15)}${ibtn('pin', '', 15)}<span class="tm">2 分钟前</span></div>
    <div class="card perm"><div class="hd">${I('terminal', 16)}<span class="ti">允许运行 ${ap.tool}</span></div>
      <div class="cmd"><i>$</i>${ap.command}</div><div class="ds">${ap.text}</div>
      <div class="ft"><div class="opt"><span class="rd on"></span>仅这一次</div><div class="opt"><span class="rd"></span>本会话始终允许</div><span class="sp"></span><div class="btn line">拒绝</div><div class="btn pri">允许</div></div></div>
    <div class="running">${spinner(14)}<span>${A.running}</span><span class="el">12s</span></div>
  </div></div>`;
}

/* ---------- 面板 ---------- */
function ctxPanel() {
  return `<aside class="cpanel cp">
    <div class="sec"><h3>环境</h3>
      <div class="rw">${I('laptop', 18)}<span>本机</span><span class="sp"></span><span class="u">保存</span></div>
      <div class="rw">${I('folder', 18)}<span>${A.project}</span><span class="g">· ~/workspace</span></div>
      <div class="rw">${I('branch', 18)}<span>${A.branch}</span></div></div>
    <div class="sec one"><h3>上下文${tri('right', 9)}</h3><span class="v" style="color:var(--ink2);font-size:14px">92.1k</span></div>
    <div class="sec one"><h3>后台任务${tri('right', 9)}</h3><span class="v" style="color:var(--ink2);font-size:14px">2</span></div>
    <div class="sec"><h3>产出</h3>${INS.changes.map(c => `<div class="rw">${I('code', 18)}<span>${c.file.split('/').pop()}</span></div>`).join('')}</div>
    <div class="sec"><h3>改动</h3><div class="rw">${I('changes', 18)}${pm(totalAdd, totalDel)}<span class="sp"></span><div class="btn soft">创建 PR</div></div></div>
  </aside>`;
}
function filePanel(open = true) {
  const d = A.turns[1].code.diff;
  const line = (n, s, cls = '') => `<div class="cl ${cls}"><span class="n">${n}</span><span class="s">${s}</span></div>`;
  const code = [
    line(8, '<span class="k">package</span> riffet.ui'), line(9, ''),
    line(10, '<span class="k">import</span> androidx.compose.runtime.compositionLocalOf'),
    line(11, '<span class="k">import</span> androidx.compose.foundation.ScrollState'), line(12, ''),
    line(13, '<span class="cm">// 导航时值会变化，不能用 static 变体</span>'),
    line(14, d[0][1].replace('val ', '<span class="k">val</span> '), 'd'), line(14, d[1][1].replace('val ', '<span class="k">val</span> '), 'a'),
    line(15, ''), line(16, '<span class="k">val</span> LocalTaskFilter = compositionLocalOf { TaskFilter.All }'),
  ].join('');
  const tree = [['f', 'apps'], ['f', 'docs'], ['f', 'packages'], ['f', 'scripts'], ['f', '.claude'], ['f', '.github'], ['t', '.gitignore'], ['t', 'AGENTS.md'], ['t', 'package.json'], ['t', 'pnpm-lock.yaml'], ['t', 'README.md']]
    .map(([k, n]) => `<div class="trow"><span class="w">${k === 'f' ? tri('right', 9) : I(n.endsWith('.md') ? 'fileText' : 'file', 15)}</span>${n}</div>`).join('');
  return `<div class="fpanel"><div class="fprev">${open ? `<div class="fh">${I('code', 15)}<span class="mono">ui/LocalScroll.kt</span><span class="sp"></span>${pm(1, 1)}</div><div class="code">${code}</div>` : `<div class="empty">${I('folder', 28, 1.4)}<span>打开的文件显示在这里</span></div>`}</div>
    <div class="ftree"><div class="fin focus">${I('search', 16)}<span>筛选</span></div>${tree}</div></div>`;
}
const filesHead = () => `<div class="p"><span class="ttl">文件</span>${ibtn('search', '', 17)}${ibtn('collapse', '', 17)}${ibtn('list', 'on', 17)}${ibtn('more', '', 17)}${ibtn('maximize', '', 16)}${ibtn('x', '', 16)}</div>`;

/* ---------- 画面 ---------- */
const mainHTML = () => `${side()}<div class="right">${tbFull('outline')}<div class="rbody"><div class="mcol">${conversation()}${dock({ running: true })}</div>${ctxPanel()}</div></div>`;
const filesHTML = () => `${side()}<div class="right"><div class="tb"><div class="l" style="flex:none;width:380px">${titleHTML(false)}${acts('folder')}</div>${filesHead()}</div>
  <div class="rbody"><div class="mcol" style="flex:none;width:380px">${conversation()}${dock({ running: true })}</div>${filePanel(true)}</div></div>`;
const homeHTML = () => {
  const proj = D.projects;
  return `${side({ home: true })}<div class="right">${tbFull('', true)}<div class="rbody"><div class="mcol">
    <div class="home">${brand(30)}<h1>要在 riffet 做什么？</h1>
      <div class="optcards">
        <div class="ocard">
          <div class="orow sel">${I('folder', 16)}<span class="t">${proj[0].name}</span>${I('check', 15).replace('class="ic"', 'class="ic ck"')}</div>
          <div class="orow">${I('folder', 16)}<span class="t">${proj[1].name}</span></div>
          <div class="ft"><div class="orow">${I('laptop', 16)}<span class="t">本机</span>${I('chevD', 15)}</div></div>
        </div>
        <div class="ocard"><div class="orow">${I('terminal', 16)}<span class="t">Shell 终端</span></div><div class="orow">${I('branch', 16)}<span class="t">并行尝试</span></div></div>
      </div></div>${dock({ home: true, wide: true })}</div></div></div>`;
};
const palHTML = () => `${mainHTML()}<div class="scrim"></div>
  <div class="pal"><div class="in">${I('search', 18)}<span class="q">搜索</span><div class="seg"><div class="on">标题</div><div>内容</div></div></div>
    <div class="body">
      <div class="gl">${D.commands[0].group}</div>
      ${D.commands[0].items.map((t, i) => `<div class="prow ${i === 0 ? 'sel' : ''}">${I('chat', 16)}<span class="t">${t}</span>${i === 0 ? '<span class="kb">↵</span>' : ''}</div>`).join('')}
      <div class="gl">${D.commands[1].group}</div>
      ${D.commands[1].items.map((t, i) => `<div class="prow">${I(['plus', 'chat', 'outline', 'gear'][i], 16)}<span class="t">${t}</span><span class="kb">${['⌘N', '⌘⇧N', '⌘⌥I', '⌘,'][i]}</span></div>`).join('')}
    </div></div>`;

/* 设置：窗口内模态，停在「外观」 */
function settingsHTML() {
  const nav = [['偏好设置', [['gear', '通用'], ['sun', '外观'], ['keyboard', '输入']]], ['Agent', [['sparkle', 'Agent'], ['chat', '快速对话']]], ['数据', [['folder', '文件'], ['download', '备份'], ['activity', '诊断']]]];
  const seg = (items, on) => `<div class="seg">${items.map((t, i) => `<div class="${i === on ? 'on' : ''}">${t}</div>`).join('')}</div>`;
  const sel = (t, ph) => `<div class="sel-in ${ph ? 'ph' : ''}"><span>${t}</span>${I('chevD', 15)}</div>`;
  const row = (nm, ctl, ds) => `<div class="setrow"><div class="nm">${nm}${ds ? `<span class="ds">${ds}</span>` : ''}</div>${ctl}</div>`;
  const kt = (n, s, c = '') => `<div class="cl ${c}"><span class="n">${n}</span><span>${s}</span></div>`;
  const pv = dk => `<div class="pv ${dk ? 'dk' : ''}">${kt(1, '<span class="k">fun</span> <span class="f">greet</span>(name: String) {')}${kt(2, '  return "Hello, " + name', 'd')}${kt(2, '  return "Hello, $name"', 'a')}${kt(3, '}')}</div>`;
  return `${mainHTML()}<div class="scrim dim"></div>
  <div class="modal"><div class="mh">设置<span class="sp"></span>${ibtn('x', '', 18)}</div>
   <div class="mb"><div class="mnav"><div class="fin">${I('search', 16)}<span>搜索</span></div>
     ${nav.map(([g, items]) => `<div class="gh">${g}</div>${items.map(([ic, t]) => `<div class="nrow ${t === '外观' ? 'sel' : ''}">${I(ic, 17)}${t}</div>`).join('')}`).join('')}</div>
    <div class="mpage"><h2>主题</h2>
      ${row('外观', seg(['浅色', '深色', '跟随系统'], 2), '仅保存在这台 Mac')}
      ${row('界面风格', sel('Claude'))}
      ${row('窗口材质', seg(['不透明', '磨砂', '玻璃'], 0))}
      <h2 class="sh">字体</h2>
      ${row('字号', sel('默认 · 14 px'))}
      ${row('阅读宽度', sel('窄'))}
      ${row('代码字体', sel('例如 JetBrains Mono', true))}
      ${row('代码字号', sel('默认 · 13 px'))}
      <h2 class="sh">代码配色</h2>
      <div class="pvs"><div>${sel('Claude Light').replace('class="sel-in', 'class="sel-in" style="width:100%" data-x="')}<div style="height:10px"></div>${pv(false)}</div><div>${sel('Claude Dark').replace('class="sel-in', 'class="sel-in" style="width:100%" data-x="')}<div style="height:10px"></div>${pv(true)}</div></div>
      <h2 class="sh">对话</h2>
      ${row('默认对话视图', seg(['标准', '思考', '详细'], 0))}
    </div></div></div>`;
}

/* ---------- spec ---------- */
function spec() {
  const tr = (...c) => `<tr>${c.map((x, i) => `<td class="${i === 0 ? 'k' : i === 1 ? 'm' : 'n'}">${x}</td>`).join('')}</tr>`;
  const light = { paper: '#FCFCFB', side: '#FBFBF9', line: '#E9E9E7', line2: '#E2E1DE', sel: '#EDECE9', hover: '#F3F2EF', knob: '#FDFDFC', user: '#F1F0EC', code: '#F6F5F2', ink0: '#2B2A27', ink1: '#52514F', ink2: '#898781', ink3: '#989791', add: '#2F7D4F', del: '#C8374F', amber: '#C08A2E' };
  const dark = { paper: '#262624', side: '#222220', line: '#363532', line2: '#3E3D3A', sel: '#353431', hover: '#2D2C2A', knob: '#42413D', user: '#302F2C', code: '#2B2A28', ink0: '#ECE9E2', ink1: '#C8C5BD', ink2: '#8F8C84', ink3: '#7A7770', add: '#74BE8F', del: '#EE7C8E', amber: '#D6A24A' };
  const names = { paper: '主区底', side: '侧栏底', line: '发丝线（侧栏/顶栏/面板）', line2: '卡片/输入框描边', sel: '选中块 / 轨道', hover: '悬停', knob: 'seg 滑块', user: '用户气泡', code: '代码/命令底', ink0: '主文字 · 分组标题', ink1: '次文字 · 图标', ink2: '占位 · 说明', ink3: '页面标题（首页）· 时间', add: '新增', del: '删除', amber: '待确认点' };
  const sw = Object.keys(light).map(k => `<tr><td class="k">${names[k]}</td><td class="m"><span class="sw" style="background:${light[k]}"></span>${light[k]}</td><td class="m"><span class="sw" style="background:${dark[k]};border-color:rgba(255,255,255,.18)"></span>${dark[k]}</td></tr>`).join('');
  const sample = (px, lh, w, t) => `<span style="font-size:${px}px;line-height:${lh}px;font-weight:${w};color:var(--ink0);white-space:nowrap">${t}</span>`;
  const st = (lb, html) => `<div class="state"><span class="lb">${lb}</span>${html}</div>`;
  const menu = (items, hov) => `<div class="menu" style="width:150px">${items.map(([ic, t], i) => `<div class="mi ${i === hov ? 'hov' : ''}">${I(ic, 16)}${t}</div>`).join('')}</div>`;
  return `<h1>Riffet · Claude 暖纸</h1><div class="lede">满铺 · 侧栏与主区一条发丝线，顶栏下一条 · 选中 = 浅底块 · 近乎无彩 · 行高 32</div>
  <div class="grid">
   <div>
    <div class="sec"><h2>字号阶梯 · 4 档 + 标题 + 等宽</h2><table>
      ${tr(sample(22, 28, 400, '标题 22'), '22 / 30 · 400', '首页标题')}
      ${tr(sample(15, 24, 400, '阅读 15'), '15 / 26 · 400', '助手正文、用户气泡、输入框')}
      ${tr(sample(14, 20, 400, '界面 14'), '14 / 20 · 400, 500', '侧栏行、顶栏标题 500、分组标题 500、卡片行、菜单')}
      ${tr(sample(13, 18, 400, '控件 13'), '13 / 18 · 400', '来源行、环境行、按钮、权限卡说明')}
      ${tr(sample(12, 16, 400, '说明 12'), '12 / 16 · 400', '账号副标、设置说明、chip、快捷键')}
      ${tr(`<span class="mono" style="font-size:13px;color:var(--ink0)">等宽 13</span>`, '13 / 22 · 12 / 20', '文件预览与命令 · 设置预览与行内')}
    </table></div>
    <div class="sec"><h2>圆角 · 3 档 · 外层 = 内层 + 内边距</h2>
      <div class="rad"><div style="border-radius:6px">6</div><div style="border-radius:10px">10</div><div style="border-radius:14px">14</div></div>
      <table style="margin-top:6px">${tr('6', 'control', 'chip · 行内代码 · seg 滑块')}${tr('10', 'container', '行 · 按钮 · 输入 · 轨道')}${tr('14', 'card', '卡片 · 输入框 · 气泡 · 弹层 · 模态')}</table></div>
    <div class="sec"><h2>间距与尺寸 · 4 栅格</h2><table>
      ${tr('侧栏', '272', '行外缩 8 · 行内 10 · 分组上距 12 · 可拖 220–400')}
      ${tr('顶栏', '48', '底部一条发丝线；面板各有自己的头')}
      ${tr('行', '32', '导航 / 会话 / 菜单 / 面板行 34 / 文件行 30')}
      ${tr('阅读列', '680', '居中；窄时左右各留 32；气泡最宽 82%')}
      ${tr('大纲面板', '340', '无头，节之间发丝线；内边距 20')}
      ${tr('文件面板', '预览 + 240', '头 48（文件 + 6 个图标），树 240，筛选框 34；预览等宽 12')}
      ${tr('输入框', '≥46', '圆角 14，下方一行 40 · 右对齐')}
      ${tr('设置模态', '1140×820', '距窗口 150 / 44 / 36；导航 264，页边 28')}
    </table></div>
   </div>
   <div>
    <div class="sec"><h2>色板 · 浅 / 深</h2><table><tr><th></th><th>浅</th><th>深</th></tr>${sw}</table>
      <div style="color:var(--ink2);margin-top:6px">品牌蓝 #3867F0 只在 Riffet 标记；Claude 橙 / Codex 渐变只在 agent 图标；diff 绿红底 9% · 8%</div></div>
   </div>
   <div>
    <div class="sec"><h2>侧栏行 · 全部状态</h2><div class="box" style="padding:6px">
      ${st('分组', '<div class="glabel">置顶' + tri('down', 9) + '</div>')}
      ${st('默认', srow({ title: 'riffet 画布视图的价值' }))}
      ${st('悬停', srow({ title: 'riffet Android 项目构建插件' }, { cls: 'hov', tail: '' }))}
      ${st('选中', srow({ title: 'Android 页面跳转动画卡顿排查', selected: true }, { tail: '' }))}
      ${st('运行中', srow({ title: 'Android 页面跳转动画卡顿排查', state: 'running' }))}
      ${st('待确认', srow({ title: '检查数据导出脚本', state: 'awaiting' }))}
      ${st('未读', srow({ title: 'riffet 语音输入开源方案', state: 'unread' }))}
      ${st('收藏', srow({ title: 'riffet mobile 的 agent use phase 2' }))}
      ${st('归档', srow({ title: '部署预览环境', cls: 'archived' }, { tail: I('archive', 14) }))}
      ${st('置顶', srow({ title: '设计系统 dev', agent: 'codex' }, { mark: true, caret: true }))}
      ${st('分叉', srow({ title: '设计系统 dev (fork)' }, { cls: 'fork', tail: '' }))}
      ${st('主操作', '<div class="nrow sel">' + I('plus', 17) + '新会话</div>')}
    </div></div>
    <div class="sec"><h2>控件</h2>
      <div class="ctl" style="margin-bottom:10px"><div class="btn pri">允许</div><div class="btn line">拒绝</div><div class="btn soft">创建 PR</div><div class="btn ghost hov">撤销</div>
        <div class="send">${I('arrowUp', 16, 1.9)}</div><div class="send">${I('stop', 18)}</div><div class="circ">${I('arrowDown', 16)}</div></div>
      <div class="ctl" style="gap:0;margin-bottom:10px">${ibtn('outline', 'on')}${ibtn('terminal')}${ibtn('changes')}${ibtn('play')}${ibtn('folder')}${ibtn('more')}</div>
      <div class="ctl" style="margin-bottom:10px"><div class="seg" style="width:150px;margin:0"><div class="on">${I('code', 14)}任务</div><div>${I('chat', 14)}对话</div></div>
        <div class="inp" style="width:150px">搜索</div></div>
      <div class="ctl"><div class="fin focus" style="width:150px;margin:0">${I('search', 15)}筛选</div><span class="chip">${I('code', 13)}LocalScroll.kt${I('x', 12)}</span><span class="opt"><span class="rd on"></span>仅这一次</span><span class="opt"><span class="rd"></span>始终</span></div></div>
   </div>
   <div>
    <div class="sec"><h2>动效</h2><table>
      ${tr('侧栏开合', '220ms', 'cubic-bezier(.2,0,0,1) · 宽度 272↔0')}
      ${tr('面板开合', '240ms', '同上 · 宽度 0↔340，阅读列居中跟随')}
      ${tr('悬停底色', '120ms', 'linear')}
      ${tr('选中 / seg 滑块', '180ms', 'cubic-bezier(.3,0,.2,1)')}
      ${tr('弹层 / 模态', '160ms', '(.2,0,0,1) · scale .98→1 + 透明度')}
      ${tr('列表 / 工具展开', '200ms', '(.2,0,0,1) · 高度 + 透明度')}
      ${tr('箭头', '140ms', 'ease-out · 旋转 90°')}
      ${tr('运行中', '900ms', 'linear 循环 · 12px 弧形，唯一的运行态')}
    </table></div>
    <div class="sec"><h2>自定义 / 更多 菜单</h2><div style="display:flex;gap:12px;align-items:flex-start">${menu([['puzzle', '插件'], ['sparkle', 'Agent 扩展']], 0)}${menu([['clock', '定时任务'], ['star', '收藏夹'], ['chart', '数据统计'], ['activity', '活动']], 2)}</div></div>
    <div class="sec"><h2>工具汇总 · 失败</h2><div class="tlist" style="margin:0"><div class="tr"><span>Bash</span><span class="v m">./gradlew :app:lint</span><span class="bad">失败</span>${tri('right', 9)}</div></div></div>
    <div class="sec"><h2>agent 图标放哪</h2><table>
      ${tr('置顶行', '16px', '行首，保留品牌色')}
      ${tr('顶栏标题', '14px', '标题左侧')}
      ${tr('输入框下', '14px', '右对齐，模型名前')}
      ${tr('其余会话行', '—', '无图标；状态在行尾，无状态时收藏星')}
    </table></div>
   </div>
  </div>`;
}

const put = (name, html) => { const el = document.querySelector(`[data-frame="${name}"]`); if (el) el.innerHTML = html; };
put('main', mainHTML()); put('home', homeHTML()); put('palette', palHTML()); put('dark', mainHTML());
put('files', filesHTML()); put('settings', settingsHTML()); put('spec', spec());
})();
