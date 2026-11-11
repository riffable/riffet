// Shared sample content so every draft shows the same app state; only the design differs.
window.DATA = {
  projects: [
    { name: 'riffet', branch: 'main' },
    { name: 'docs-site', branch: 'feat/search' },
  ],
  pinned: [
    { title: '整理发布前的检查清单', agent: 'claude' },
    { title: '设计系统 dev', agent: 'codex' },
  ],
  buckets: [
    {
      label: '今天',
      sessions: [
        { title: 'Android 页面跳转动画卡顿排查', agent: 'claude', state: 'running', selected: true, project: 'riffet' },
        { title: '检查数据导出脚本', agent: 'codex', state: 'awaiting', project: 'riffet' },
        { title: 'riffet 语音输入开源方案', agent: 'claude', state: 'unread', project: 'riffet' },
        { title: 'riffet mobile 的 agent use phase 2', agent: 'claude', project: 'riffet' },
        { title: '升级 docs-site 依赖', agent: 'codex', project: 'docs-site' },
        { title: 'riffet Android 项目构建插件', agent: 'claude', project: 'riffet' },
        { title: '部署预览环境', agent: 'codex', project: 'docs-site' },
        { title: 'Riffet 画布视图的价值', agent: 'claude', project: 'riffet' },
      ],
    },
    {
      label: '昨天',
      sessions: [
        { title: '检查开发机访问故障', agent: 'codex', project: 'riffet' },
        { title: '整理本周的用户反馈', agent: 'codex' },
        { title: 'web 异常提示问题修复', agent: 'claude', project: 'riffet' },
        { title: '优化深色模式 Tab 可读性', agent: 'codex', project: 'riffet' },
        { title: 'Cursor 无思考内容消息流式输出', agent: 'cursor', project: 'riffet' },
        { title: 'Web 端模型闪动问题', agent: 'claude', project: 'riffet' },
      ],
    },
  ],
  // The selected session's transcript.
  conversation: {
    title: 'Android 页面跳转动画卡顿排查',
    agent: 'claude',
    model: 'Opus 5.5',
    project: 'riffet',
    branch: 'main',
    turns: [
      {
        role: 'user',
        text: '真机上从任务列表点进会话，转场前 200ms 明显掉帧，帮我查一下是哪一层在重组。',
      },
      {
        role: 'assistant',
        thinking: '先看转场期间哪些子树被重新挂载，再对照 RiffetPageScaffold 的淡入时机。',
        tools: [
          { name: 'Read', target: 'shared/src/commonMain/kotlin/riffet/ui/RiffetPageScaffold.kt', meta: '212 行' },
          { name: 'Bash', target: 'adb logcat -s RiffetLifecycle', meta: '1.8s' },
          { name: 'Grep', target: 'staticCompositionLocalOf', meta: '6 处' },
        ],
        text: '找到了。`LocalScrollState` 用的是 `staticCompositionLocalOf`，导航时值变化会让整棵页面子树重新组合；日志里 `TaskList` 在转场开始时出现了一次 `-` 再 `+`。',
        code: {
          lang: 'kotlin',
          file: 'ui/LocalScroll.kt',
          diff: [
            ['-', 'val LocalScrollState = staticCompositionLocalOf { ScrollState(0) }'],
            ['+', 'val LocalScrollState = compositionLocalOf { ScrollState(0) }'],
          ],
        },
      },
      {
        role: 'approval',
        tool: 'Bash',
        command: './gradlew :androidApp:installDebug',
        text: '安装到已连接的测试手机',
      },
    ],
    running: '正在编辑 ui/LocalScroll.kt',
  },
  inspector: {
    tabs: ['变更', '文件', '终端', '任务'],
    changes: [
      { file: 'ui/LocalScroll.kt', add: 1, del: 1 },
      { file: 'ui/tasks/TaskListScreen.kt', add: 14, del: 9 },
      { file: 'ui/RiffetPageScaffold.kt', add: 3, del: 0 },
    ],
  },
  commands: [
    { group: '会话', items: ['Android 页面跳转动画卡顿排查', 'Android 文件预览下载按钮崩溃', 'Android 页面转场画卡顿架构'] },
    { group: '操作', items: ['新建任务', '快速对话', '切换检查器', '打开设置'] },
  ],
  settings: {
    nav: ['通用', '外观', 'Agent', '输入', '快速对话', '文件', '备份', '诊断'],
    selected: '外观',
  },
  suggestions: ['继续昨天的 Web 端模型闪动问题', '审查 main 上未提交的改动', '为 docs-site 写升级说明'],
};
