// Stress data shared by the client performance scripts (scripts/android-perf.mjs, scripts/web-perf.mjs).
//
// Writes Claude Code transcripts under <dir>/claude and git projects under <dir>/work, then imports the
// transcripts into a server started with CLAUDE_CONFIG_DIR=<dir>/claude RIFFET_ENV_KEEP=CLAUDE_CONFIG_DIR
// --no-auth. Nothing is sent to an agent. <dir>/seed.json lists every session with its transcript file,
// so a script can append to one and the server reads the new lines as a session in progress.
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function png(width, height, seed) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0, at = 0; y < height; y++) {
    raw[at++] = 0;
    for (let x = 0; x < width; x++) {
      raw[at++] = (seed * 40 + x * 255 / width) & 255;
      raw[at++] = (seed * 90 + y * 255 / height) & 255;
      raw[at++] = (x ^ y) & 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const prose = '渲染管线在每一帧里先测量再布局最后绘制，任何在组合阶段读取的状态都会让整棵子树重新执行。The diff viewer keeps a window of rows around the viewport and recycles the rest. ';
const code = '```kotlin\n@Composable\nfun Row(item: Item) {\n    val layout = remember(item.id) { item.prepared }\n    Text(layout.text)\n}\n```';
const table = '| 场景 | 帧数 | >16ms |\n|---|---:|---:|\n| 列表快滑 | 412 | 3 |\n| 转录慢滑 | 980 | 11 |';
const lines = (n, f) => Array.from({ length: n }, (_, k) => f(k)).join('\n');
export const markdown = i => [`## 第 ${i} 步`, prose.repeat(2), '- **加粗** 与 `code`\n  - 嵌套', i % 2 ? table : code, '> 引用', i % 5 === 0 ? '$$E = mc^2$$' : '', i % 7 === 0 ? '```mermaid\ngraph TD; A-->B; B-->C\n```' : ''].filter(Boolean).join('\n\n');

/** One transcript writer: `turn(i)` adds a user prompt, the turn's tools and the final answer. */
function transcript(root, cwd, id, start, existing) {
  const folder = join(root, 'claude', 'projects', cwd.replaceAll('/', '-'));
  if (!existing) mkdirSync(folder, { recursive: true });
  const file = existing ?? join(folder, `${id}.jsonl`);
  let parent = null;
  let time = start;
  const rows = [];
  const add = (type, message) => {
    time += 9000;
    const uuid = randomUUID();
    rows.push({ parentUuid: parent, isSidechain: false, type, message, uuid, timestamp: new Date(time).toISOString(), userType: 'external', entrypoint: 'cli', cwd, sessionId: id, version: '2.1.322', gitBranch: 'main' });
    parent = uuid;
  };
  const turn = (i, tools) => {
    add('user', { role: 'user', content: `第 ${i + 1} 轮：检查一下性能并给出修改。` });
    const messageId = `msg_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    tools?.(i, cwd, (name, input, output) => {
      const toolId = `toolu_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
      add('assistant', { model: 'claude-opus-5-5', id: messageId, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: toolId, name, input }], stop_reason: 'tool_use' });
      add('user', { role: 'user', content: [{ tool_use_id: toolId, type: 'tool_result', content: output }] });
    });
    add('assistant', { model: 'claude-opus-5-5', id: messageId, type: 'message', role: 'assistant', content: [{ type: 'text', text: i % 2 ? prose.repeat(3) : markdown(i) }], stop_reason: 'end_turn' });
  };
  /** Moves the rows written so far into the file. */
  const flush = () => {
    if (rows.length) appendFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    rows.length = 0;
  };
  return { file, turn, flush, add };
}

/** Small turn: a test run and a 40-line edit. */
export const smallTurn = (i, cwd, tool) => {
  tool('Bash', { command: './gradlew test', description: 'Run tests' }, lines(i % 3 ? 40 : 300, k => `[${k}] PASS Case${k}`));
  tool('Edit', { file_path: `${cwd}/src/Feature${i % 25}.kt`, old_string: lines(40, n => `    val line${n} = compute(${n})`), new_string: lines(40, n => `    val line${n} = computeFast(${n}, cache)`) }, 'The file has been updated.');
};

/**
 * Appends `turns` more turns to a seeded transcript, one every `everyMs`, so the server streams them to
 * clients as a session in progress.
 */
export async function appendTurns({ file, cwd, nativeSessionId }, turns, everyMs) {
  const writer = transcript('', cwd, nativeSessionId, Date.now(), file);
  for (let i = 0; i < turns; i++) {
    writer.turn(i, smallTurn);
    writer.flush();
    await new Promise(r => setTimeout(r, everyMs));
  }
}

/**
 * `shortSessions` short conversations spread over the projects; past 44 they get 1–3 turns each so a
 * list of thousands imports in minutes.
 */
export async function seed(dir, server, { shortSessions = 44 } = {}) {
  if (!dir) throw new Error('seed needs a directory');
  const root = resolve(dir);
  const projects = ['riffet-mobile', 'payments-api', 'design-system', 'data-pipeline'].map(name => {
    const project = join(root, 'work', name);
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(join(project, 'assets'), { recursive: true });
    for (let k = 0; k < 25; k++) writeFileSync(join(project, 'src', `Feature${k}.kt`), lines(40, n => `    val line${n} = compute(${n})`) + '\n' + code);
    writeFileSync(join(project, 'README.md'), `# ${name}\n\n` + Array.from({ length: 6 }, (_, i) => markdown(i)).join('\n\n'));
    writeFileSync(join(project, 'build.log'), lines(20000, k => `[${k}] PASS Case${k} (${k % 900}ms)`));
    for (let k = 0; k < 4; k++) writeFileSync(join(project, 'assets', `shot${k}.png`), png(k % 2 ? 900 : 1600, k % 2 ? 2400 : 1000, k));
    if (!existsSync(join(project, '.git'))) {
      const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'user.name=perf', '-c', 'user.email=perf@example.com', '-C', project, ...args]);
      git('init', '-q'); git('add', '.'); git('commit', '-qm', 'init');
      for (let k = 0; k < 5; k++) writeFileSync(join(project, 'src', `Feature${k}.kt`), `// pending ${k}\n`, { flag: 'a' });
    }
    return project;
  });

  const sessions = [];
  const session = (cwd, title, turns, start, tools) => {
    const id = randomUUID();
    const writer = transcript(root, cwd, id, start);
    for (let i = 0; i < turns; i++) writer.turn(i, tools);
    writer.flush();
    appendFileSync(writer.file, JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: id }) + '\n');
    sessions.push({ nativeSessionId: id, title, cwd, file: writer.file, turns });
  };
  const before = lines(700, k => `    fun handler${k}(req: Request): Response = process(req.copy(id = ${k}), retries = 3)`);
  const after = lines(700, k => k % 3 ? `    fun handler${k}(req: Request): Response = processIdempotent(req.copy(id = ${k}), key = req.key)` : `    fun handler${k}(req: Request): Response = process(req.copy(id = ${k}), retries = 3)`);
  const now = Date.now();
  session(projects[0], '转录渲染（超长）', 260, now - 30 * 3600e3, smallTurn);
  session(projects[1], '大 diff 与长输出', 6, now - 20 * 3600e3, (i, cwd, tool) => {
    tool('Edit', { file_path: `${cwd}/src/Handlers${i}.kt`, old_string: before, new_string: after }, 'The file has been updated.');
    tool('Bash', { command: './gradlew test --info', description: 'Run all tests' }, lines(6000, k => `[${k}] ${k % 37 ? 'PASS' : 'FAIL'} PaymentsTest.case${k}`));
    tool('Read', { file_path: `${cwd}/src/Handlers${i}.kt` }, lines(2100, k => `${k + 1}\t${before.split('\n')[k % 700]}`));
  });
  session(projects[0], '截图审阅（大量图片）', 40, now - 10 * 3600e3, (i, cwd, tool) => {
    for (let k = 0; k < 2; k++) {
      const file = `${cwd}/assets/shot${(i + k) % 4}.png`;
      tool('Read', { file_path: file }, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(64, 64, i + k).toString('base64') } }]);
    }
  });
  session(projects[2], '进行中（追加写入）', 4, now - 3600e3, smallTurn);
  const topics = ['修复登录态过期', '升级 Gradle 插件', '重构网络层重试', 'Fix flaky sync test', 'Add CSV export', 'Investigate memory leak'];
  for (let n = 0; n < shortSessions; n++) {
    const turns = n < 44 ? 2 + (n % 12) : 1 + (n % 3);
    session(projects[n % 4], `${topics[n % topics.length]} #${n + 1}`, turns, now - (n + 40) * 3600e3, n < 44 ? smallTurn : undefined);
  }
  writeFileSync(join(root, 'seed.json'), JSON.stringify({ server, sessions }, null, 2));

  const status = await fetch(`${server}/api/auth/status`);
  const cookie = status.headers.get('set-cookie')?.split(';')[0] ?? '';
  const { csrfToken } = await status.json();
  const queue = [...sessions];
  let done = 0;
  // A few imports at a time; the server parses each transcript on import.
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const response = await fetch(`${server}/api/external-sessions/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: server, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ backendId: 'claude', backendProfileId: 'local', nativeSessionId: next.nativeSessionId }),
      });
      if (!response.ok) throw new Error(`import ${next.nativeSessionId}: ${response.status} ${await response.text()}`);
      if (++done % 250 === 0) console.log(`imported ${done}/${sessions.length}`);
    }
  }));
  console.log(`Imported ${sessions.length} sessions from ${join(root, 'claude')} into ${server}.`);
}
