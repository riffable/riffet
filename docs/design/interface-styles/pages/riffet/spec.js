window.__spec = () => {
  const { ico, agent, spinner, srow } = window.__W;
  const el = document.querySelector('[data-frame="spec"]'); if (!el) return;
  el.classList.add('spec'); el.style.background = 'var(--bg)';
  const T = (name, sz, w, use, sample) => `<div class="trow"><div class="m">${name}<span class="u">${sz}</span></div><div style="min-width:0"><div style="font-size:${sample[0]}px;line-height:${sample[1]}px;font-weight:${w};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${sample[3] || ''}">${sample[2]}</div><span class="u">${use}</span></div></div>`;
  const light = [['画布 / 侧栏', '#f7f8fa'], ['卡片', '#ffffff'], ['浅底', '#f5f6f8'], ['弱底 / 分段槽', '#eef0f3'], ['悬停', '35 45 70 / 5.5%'], ['按下 / 选中', '35 45 70 / 9%'], ['用户气泡', '#eef3fd'], ['分隔线', '15 23 42 / 8%'], ['描边', '15 23 42 / 13%'], ['正文 fg', '#2a2c2e'], ['fg-2', '#50555d'], ['fg-3', '#60666e'], ['fg-4', '#adb2ba'], ['主按钮', '#15171a'], ['强调 accent', '#3867f0'], ['成功', '#1f9d55'], ['警告', '#c77f06'], ['危险', '#e0454b'], ['diff 增', '#e6f4e7'], ['diff 删', '#fce6e2']];
  const dark = [['#1a1a1d'], ['#141416'], ['#1d1d20'], ['#27272b'], ['255 / 6%'], ['255 / 10%'], ['#27282c'], ['255 / 7.5%'], ['255 / 12%'], ['#d2d4d7'], ['#b6bac1'], ['#9da2aa'], ['#62666e'], ['#eceef1'], ['#5b8cff'], ['#3fb96f'], ['#e5a13a'], ['#f0676c'], ['#1f3124'], ['#3c1f1b']];
  const cv = ['#f7f8fa', '#fff', '#f5f6f8', '#eef0f3', 'rgb(35 45 70/.055)', 'rgb(35 45 70/.09)', '#eef3fd', 'rgb(15 23 42/.08)', 'rgb(15 23 42/.13)', '#2a2c2e', '#50555d', '#60666e', '#adb2ba', '#15171a', '#3867f0', '#1f9d55', '#c77f06', '#e0454b', '#e6f4e7', '#fce6e2'];
  const dv = ['#1a1a1d', '#141416', '#1d1d20', '#27272b', 'rgb(255 255 255/.06)', 'rgb(255 255 255/.1)', '#27282c', 'rgb(255 255 255/.075)', 'rgb(255 255 255/.12)', '#d2d4d7', '#b6bac1', '#9da2aa', '#62666e', '#eceef1', '#5b8cff', '#3fb96f', '#e5a13a', '#f0676c', '#1f3124', '#3c1f1b'];
  const pal = (vals, cols, hexes) => light.map((l, i) => `<div class="sw"><i style="background:${cols[i]}"></i><span>${l[0]}</span><em>${hexes[i]}</em></div>`).join('');
  const S = (t, k) => ({ title: t, agent: 'claude', ...k });
  const states = [
    ['默认', S('riffet 画布视图的价值'), {}], ['悬停', S('riffet 画布视图的价值'), { hov: 1, time: '' }], ['选中', S('riffet 画布视图的价值', { selected: true }), {}],
    ['运行中', S('Android 页面跳转动画卡顿排查', { state: 'running' }), {}], ['待确认', S('检查数据导出脚本', { agent: 'codex', state: 'awaiting' }), {}],
    ['未读', S('riffet 语音输入开源方案', { state: 'unread' }), {}], ['收藏', S('整理发布前的检查清单'), { pin: 1 }], ['归档', S('旧的 VPS 迁移记录', { agent: 'codex' }), {}],
  ];
  const row = (s, o, i) => {
    let h = srow(s, i, { time: i === 1 ? '' : '2 小时', ...o });
    if (i === 1) h = h.replace('<span class="tail"></span>', `<span class="tail"><span class="ibtn" style="width:20px;height:20px;margin-right:-4px">${ico('dots', 14)}</span></span>`);
    if (i === 7) h = h.replace('class="srow ', 'class="srow archived ').replace('<span class="tail">2 小时</span>', `<span class="tail">${ico('archive', 14)}</span>`);
    return h;
  };
  el.innerHTML = `
  <h1>Riffet · 设计基础<small>与 web 同一套 token，Mac 只改窗口外壳</small></h1>
  <div class="sc">
    <section><h2>字号</h2>
      ${T('标题', '18 / 26 · 600', 600, '弹层空状态、设置页标题', [18, 26, '要在 riffet 做什么'])}
      ${T('阅读', '15 / 25 · 400', 400, '对话正文、输入框、⌘K 条目', [15, 25, '导航时值变化会让整棵页面子树重新组合'])}
      ${T('界面', '14 / 22 · 400', 400, '侧栏、标签、按钮、列表行', [14, 22, '检查数据导出脚本'])}
      ${T('次级', '13 / 20 · 400', 400, '项目名、路径、分段、小按钮', [13, 20, 'apps/mobile/shared/src · main'])}
      ${T('辅助', '12 / 18 · 400', 400, '时间、分组标签、快捷键、计数', [12, 18, '本会话 · 41 分钟 · ⌘K'])}
      ${T('等宽', '13 / 20 · SF Mono', 400, '工具行、代码、diff、文件名', [13, 20, 'Read RiffetPageScaffold.kt +176', 'font-family:var(--mono)'])}
    </section>
    <section><h2>圆角</h2>
      <div class="rad"><div><i style="border-radius:6px"></i><b>6</b>行内代码<br>快捷键</div><div><i style="border-radius:8px"></i><b>8</b>行 · 按钮<br>标签 · 图标钮</div><div><i style="border-radius:12px"></i><b>12</b>代码块<br>权限卡 · 输入</div><div><i style="border-radius:16px"></i><b>16</b>主卡片 · 输入框<br>弹层</div><div><i style="border-radius:28px"></i><b>pill</b>chip<br>圆点</div></div>
    </section>
    <section><h2>动效</h2>
      <table class="mt">
        <tr><td>悬停 · 选中底色</td><td class="m">120ms</td><td class="m">ease-out</td></tr>
        <tr><td>侧栏 · 检查器开合</td><td class="m">250ms</td><td class="m">.32,.72,0,1</td></tr>
        <tr><td>标签切换 · 下划线</td><td class="m">200ms</td><td class="m">.2,0,0,1</td></tr>
        <tr><td>弹层进入 / 退出</td><td class="m">150 / 100ms</td><td class="m">.05,.7,.1,1 / .3,0,.8,.15</td></tr>
        <tr><td>会话行插入</td><td class="m">200ms 高度+淡入</td><td class="m">.2,.7,.2,1</td></tr>
        <tr><td>运行中转圈</td><td class="m">1s</td><td class="m">linear</td></tr></table>
    </section>
  </div>
  <div class="sc">
    <section><h2>色板 · 浅 / 深</h2>
      <div class="pal"><div class="set lt">${light.map((l, i) => `<div class="sw"><i style="background:${cv[i]}"></i><span>${l[0]}</span><em>${l[1]}</em></div>`).join('')}</div><div class="set dk">${light.map((l, i) => `<div class="sw"><i style="background:${dv[i]}"></i><span>${l[0]}</span><em>${dark[i][0]}</em></div>`).join('')}</div></div>
    </section>
    <section><h2>Agent</h2>
      <div class="ctl" style="gap:18px">${['claude', 'codex', 'cursor'].map(a => `<span style="display:flex;gap:8px;align-items:center">${agent(a, 18)}<span style="font-size:13px;color:var(--fg-2)">${a === 'claude' ? '#d97757' : a === 'codex' ? '渐变 #b1a7ff → #3941ff' : '跟随前景'}</span></span>`).join('')}</div>
    </section>
    <section><h2>层级与阴影</h2>
      <div class="ctl" style="gap:16px;padding:14px;background:var(--bg-sidebar);border-radius:12px">
        <div style="width:112px;height:58px;border-radius:16px;background:var(--bg);box-shadow:0 0 0 .5px var(--line-soft);font-size:12px;padding:8px 12px;color:var(--fg-3)">主卡片<br>仅靠底色分离</div>
        <div style="width:112px;height:58px;border-radius:16px;background:var(--bg);box-shadow:var(--shadow-composer);font-size:12px;padding:8px 12px;color:var(--fg-3)">输入框<br>composer</div>
        <div style="width:112px;height:58px;border-radius:16px;background:var(--bg-popover);box-shadow:var(--shadow-peek);font-size:12px;padding:8px 12px;color:var(--fg-3)">弹层<br>peek</div></div>
    </section>
    <section><h2>权限卡图标按语义着色</h2>
      <div class="ctl" style="gap:14px;font-size:13px;color:var(--fg-2)">
        <span style="display:flex;gap:7px;align-items:center"><span class="tic" style="width:22px;height:22px;border-radius:6px;display:grid;place-items:center;background:var(--bg-muted);color:var(--fg-3)">${ico('file', 14)}</span>读取 · 中性</span>
        <span style="display:flex;gap:7px;align-items:center"><span style="width:22px;height:22px;border-radius:6px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)">${ico('terminal', 14)}</span>执行 · accent</span>
        <span style="display:flex;gap:7px;align-items:center"><span style="width:22px;height:22px;border-radius:6px;display:grid;place-items:center;background:var(--danger-soft);color:var(--danger)">${ico('x', 14)}</span>删除 / 越界 · danger</span></div>
    </section>
  </div>
  <div class="sc">
    <section><h2>侧栏行</h2>
      <div class="sbwrap"><div class="lbls">${states.map(s => `<div>${s[0]}</div>`).join('')}</div>
      <div class="sbbox">${states.map(([l, s, o], i) => row(s, o, i)).join('')}</div></div>
    </section>
    <section><h2>控件</h2>
      <div class="ctlrow"><span>按钮</span><div class="ctl"><button class="btn pri">允许</button><button class="btn sec">复制</button><button class="btn quiet">拒绝</button><button class="ibtn" style="box-shadow:0 0 0 .5px var(--line-strong)">${ico('plus', 16)}</button><button class="ibtn on">${ico('panelR', 17)}</button></div></div>
      <div class="ctlrow"><span>分段</span><div class="seg"><span class="on">改动</span><span>检查点</span><span>Worktree</span></div></div>
      <div class="ctlrow"><span>Tab</span><div class="ctl" style="gap:20px"><span class="utab on" style="height:34px">变更</span><span class="utab" style="height:34px">文件</span><span class="utab" style="height:34px">终端</span></div></div>
      <div class="ctlrow"><span>会话标签</span><div class="ctl" style="gap:4px"><div class="tab on">${agent('claude', 14)}<span class="t">标签</span><span class="x">${ico('x', 11)}</span></div><div class="tab">${agent('codex', 14)}<span class="t">标签</span><i class="dot"></i></div></div></div>
      <div class="ctlrow"><span>输入</span><div class="ctl"><div class="inp">占位</div><div class="inp f">输入中</div></div></div>
      <div class="ctlrow"><span>chip</span><div class="ctl"><span class="chip">${ico('terminal', 15)}Shell 终端</span><span class="pill" style="box-shadow:0 0 0 .5px var(--line-strong)">${agent('claude', 15)}Claude Code</span><kbd style="margin:0">⌘K</kbd></div></div>
      <div class="ctlrow"><span>选项</span><div class="ctl" style="gap:2px"><div class="opt on" style="width:150px"><span class="radio"></span>仅此一次</div><div class="opt" style="width:150px"><span class="radio"></span>本会话内</div></div></div>
    </section>
    <section><h2>间距与尺寸</h2>
      <div class="mono" style="font-size:12px;color:var(--fg-3);margin-bottom:8px">4 · 8 · 12 · 16 · 24 · 40</div>
      <div class="kv" style="grid-template-columns:1fr 1fr 1fr"><span>侧栏<b>256</b></span><span>卡片外边距<b>8</b></span><span>标签栏<b>44</b></span><span>标签高<b>30</b></span><span>导航行<b>32</b></span><span>会话行<b>30</b></span><span>阅读列<b>≤776</b></span><span>列边距<b>76</b></span><span>检查器<b>380</b></span><span>大纲<b>212</b></span><span>输入框<b>96/120</b></span><span>弹层<b>620</b></span></div>
    </section>
  </div>`;
};
