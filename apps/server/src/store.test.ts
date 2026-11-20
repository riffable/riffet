import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from './store.js';

const directories: string[] = [];
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'riffet-store-'));
  directories.push(directory);
  return join(directory, 'workbench.db');
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** A schema-v1 database as the retired ACP workbench wrote it, including ACP-only tables. */
function writeLegacyDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE projects (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), json TEXT NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), command_id TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(session_id,command_id));
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), json TEXT NOT NULL);
    CREATE TABLE interactions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), json TEXT NOT NULL);
    CREATE TABLE terminals (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    PRAGMA user_version=1;`);
  const stamp = '2026-01-01T00:00:00.000Z';
  const project = { id: 'p1', cwd: '/tmp/legacy', name: 'legacy', createdAt: stamp, updatedAt: stamp };
  const acp = { id: 's-acp', projectId: 'p1', kind: 'acp', title: 'ACP chat', tags: [], state: 'idle', mode: 'agent', createdAt: stamp, updatedAt: stamp };
  const native = { id: 's-native', projectId: 'p1', kind: 'native', title: 'Terminal', tags: [], state: 'idle', mode: 'agent', createdAt: stamp, updatedAt: stamp };
  db.prepare('INSERT INTO projects(id,json) VALUES(?,?)').run(project.id, JSON.stringify(project));
  db.prepare('INSERT INTO sessions(id,project_id,json) VALUES(?,?,?)').run(acp.id, project.id, JSON.stringify(acp));
  db.prepare('INSERT INTO sessions(id,project_id,json) VALUES(?,?,?)').run(native.id, project.id, JSON.stringify(native));
  db.prepare('INSERT INTO runs(id,session_id,command_id,json) VALUES(?,?,?,?)').run('r-acp', acp.id, 'c-acp', JSON.stringify({ id: 'r-acp', sessionId: acp.id, commandId: 'c-acp', prompt: 'hi', state: 'completed', createdAt: stamp, updatedAt: stamp }));
  // A native run interrupted by the restart: no `native` details, state left as running by v1.
  db.prepare('INSERT INTO runs(id,session_id,command_id,json) VALUES(?,?,?,?)').run('r-native', native.id, 'c-native', JSON.stringify({ id: 'r-native', sessionId: native.id, commandId: 'c-native', prompt: 'go', state: 'running', createdAt: stamp, updatedAt: stamp }));
  db.prepare('INSERT INTO events(session_id,json) VALUES(?,?)').run(acp.id, JSON.stringify({ sessionId: acp.id, type: 'agent_message_chunk', data: {}, createdAt: stamp }));
  db.prepare('INSERT INTO events(session_id,json) VALUES(?,?)').run(native.id, JSON.stringify({ sessionId: native.id, type: 'user_message_chunk', data: {}, createdAt: stamp }));
  db.prepare('INSERT INTO interactions(id,session_id,json) VALUES(?,?,?)').run('i1', acp.id, JSON.stringify({ id: 'i1', sessionId: acp.id, generation: 'g', kind: 'permission', status: 'pending', payload: {}, createdAt: stamp }));
  db.close();
}

describe('Store schema v2 migration', () => {
  it('purges ACP conversations, keeps native history, and drops the interactions table', () => {
    const path = scratch();
    writeLegacyDatabase(path);
    const store = new Store(path);
    try {
      expect(store.listSessions().map((session) => session.id)).toEqual(['s-native']);
      expect(store.getEvents('s-native')).toHaveLength(1);
      expect(store.getEvents('s-acp')).toEqual([]);
      expect(store.listRuns('s-acp')).toEqual([]);
      expect(store.getProject('p1').name).toBe('legacy');
      const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).not.toContain('interactions');
      expect((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5);

      store.recoverInterruptedRuns();
      expect(store.getRun('r-native').state).toBe('interrupted');
    } finally { store.close(); }
  });

  it('reopens a migrated database without purging native work again', () => {
    const path = scratch();
    writeLegacyDatabase(path);
    const first = new Store(path); first.close();
    const second = new Store(path);
    try {
      expect(second.listSessions().map((session) => session.id)).toEqual(['s-native']);
      expect(second.getEvents('s-native')).toHaveLength(1);
    } finally { second.close(); }
  });

  it('refuses a database written by a newer schema instead of bypassing its rules', () => {
    const path = scratch();
    const newer = new DatabaseSync(path);
    newer.exec('PRAGMA user_version=6;');
    newer.close();
    expect(() => new Store(path)).toThrow(expect.objectContaining({ code: 'DATABASE_VERSION_NEWER' }));
  });

  it('creates a fresh database directly at the current schema version', () => {
    const store = new Store(scratch());
    try {
      expect((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5);
    } finally { store.close(); }
  });

  it('drops spaces, their tables and stored memberships when upgrading a v3 database', () => {
    const path = scratch();
    const store = new Store(path);
    const project = store.createProject('/tmp/v3-spaces', 'v3');
    const session = store.createSession({ projectId: project.id, kind: 'native' });
    const stamp = new Date().toISOString();
    store.db.prepare('INSERT INTO runs(id,session_id,command_id,json) VALUES(?,?,?,?)').run(
      'run-1', session.id, 'command-1',
      JSON.stringify({ id: 'run-1', sessionId: session.id, commandId: 'command-1', prompt: 'hi', state: 'completed', createdAt: stamp, updatedAt: stamp, native: { spaceContext: { spaceId: 'space-1' }, configRevision: 0 } }),
    );
    store.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`PRAGMA user_version=3;
      CREATE TABLE spaces (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE space_entries (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE space_entry_revisions (entry_id TEXT NOT NULL, revision INTEGER NOT NULL, space_id TEXT NOT NULL, asset_hash TEXT, json TEXT NOT NULL, PRIMARY KEY (entry_id, revision));
      CREATE TABLE space_mutations (space_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (space_id, request_id));
      CREATE TABLE space_credentials (id TEXT PRIMARY KEY, hash TEXT NOT NULL, server_id TEXT NOT NULL, space_id TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE space_injections (session_id TEXT PRIMARY KEY, space_id TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE space_messages (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, to_session_id TEXT NOT NULL, sender_session_id TEXT, sequence INTEGER NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(to_session_id, sequence));
      CREATE INDEX session_space ON sessions(json_extract(json,'$.spaceId')) WHERE json_extract(json,'$.spaceId') IS NOT NULL;
      UPDATE sessions SET json=json_set(json,'$.spaceId','space-1') WHERE id='${session.id}';`);
    legacy.close();

    const migrated = new Store(path);
    try {
      expect((migrated.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5);
      const names = (migrated.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as Array<{ name: string }>).map(row => row.name);
      for (const name of ['spaces','space_entries','space_entry_revisions','space_mutations','space_credentials','space_injections','space_messages','session_space']) {
        expect(names, name).not.toContain(name);
      }
      const sessionJson = JSON.parse((migrated.db.prepare('SELECT json FROM sessions WHERE id=?').get(session.id) as { json: string }).json) as { spaceId?: string };
      expect(sessionJson).not.toHaveProperty('spaceId');
      const runJson = JSON.parse((migrated.db.prepare('SELECT json FROM runs WHERE id=?').get('run-1') as { json: string }).json) as { native?: { spaceContext?: unknown } };
      expect(runJson.native).not.toHaveProperty('spaceContext');
    } finally { migrated.close(); }
  });

  it('stays at v1 when the purge fails, then retries on the next start', () => {
    const path = scratch();
    writeLegacyDatabase(path);
    // Force the ACP delete to abort, so the migration cannot commit.
    const blocker = new DatabaseSync(path);
    blocker.exec(`CREATE TRIGGER block_acp_delete BEFORE DELETE ON sessions
      WHEN json_extract(OLD.json,'$.kind') IS NOT 'native'
      BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);
    blocker.close();

    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = new Store(path);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[riffet] store migration purge-acp'), expect.anything());
    logged.mockRestore();
    try {
      // Opening must succeed, claim nothing was migrated, and leave the row and table in place.
      expect((first.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
      expect(first.listSessions().map((session) => session.id).sort()).toEqual(['s-acp', 's-native']);
      expect(first.getEvents('s-acp')).toHaveLength(1);
      const tables = (first.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toContain('interactions');
    } finally { first.close(); }

    const unblock = new DatabaseSync(path);
    unblock.exec('DROP TRIGGER block_acp_delete;');
    unblock.close();

    const second = new Store(path);
    try {
      expect(second.listSessions().map((session) => session.id)).toEqual(['s-native']);
      expect((second.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5);
    } finally { second.close(); }
  });
});

/** The v1 fixture advanced to what `version` left behind: v2 has no ACP rows, v3 adds spaces and unreleased project tables, v4 has neither. */
function writeDatabaseAt(path: string, version: 1 | 2 | 3 | 4): void {
  writeLegacyDatabase(path);
  if (version === 1) return;
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; DROP TABLE interactions; DELETE FROM events WHERE session_id='s-acp'; DELETE FROM runs WHERE session_id='s-acp'; DELETE FROM sessions WHERE id='s-acp';`);
  if (version === 3) {
    db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE space_messages (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, to_session_id TEXT NOT NULL, sequence INTEGER NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE project_entries (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      INSERT INTO spaces(id,revision,json) VALUES('space-1',1,'{}');
      UPDATE sessions SET json=json_set(json,'$.spaceId','space-1');
      UPDATE runs SET json=json_set(json,'$.native',json_object('spaceContext',json_object('spaceId','space-1')));`);
  }
  db.exec(`PRAGMA user_version=${version};`);
  db.close();
}

describe('Store upgrade from each earlier schema version', () => {
  for (const version of [1, 2, 3, 4] as const) {
    it(`brings a v${version} database to the current version with its native history intact, once`, () => {
      const path = scratch();
      writeDatabaseAt(path, version);
      for (let pass = 1; pass <= 2; pass++) {
        const store = new Store(path);
        try {
          expect((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5);
          expect(store.listSessions().map(session => session.id)).toEqual(['s-native']);
          expect(store.getProject('p1').name).toBe('legacy');
          expect(store.getEvents('s-native')).toHaveLength(1);
          expect(store.getEvents('s-acp')).toEqual([]);
          expect(store.listRuns('s-native').map(run => run.id)).toEqual(['r-native']);
          const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name);
          for (const gone of ['interactions', 'spaces', 'space_messages', 'project_entries']) expect(tables, gone).not.toContain(gone);
          expect(store.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(json,'$.spaceId') IS NOT NULL").get()).toEqual({ n: 0 });
          expect(store.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE json_extract(json,'$.native.spaceContext') IS NOT NULL").get()).toEqual({ n: 0 });
        } finally { store.close(); }
      }
    });
  }
});

describe('session updates', () => {
  it('leaves an unchanged session untouched so streams are not pushed a no-op frame', async () => {
    const store = new Store(':memory:');
    try {
      const project = store.createProject('/tmp/session-noop', 'No-op');
      const created = store.createSession({ projectId: project.id, kind: 'native', state: 'idle' });
      const idle = store.updateSession(created.id, { state: 'idle' });
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(store.updateSession(created.id, { state: 'idle', error: undefined }).updatedAt).toBe(idle.updatedAt);
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(store.updateSession(created.id, { state: 'running' }).updatedAt).not.toBe(idle.updatedAt);
    } finally { store.close(); }
  });

  it('stamps activeSince when a turn opens and keeps it while the turn stays active', async () => {
    const store = new Store(':memory:');
    try {
      const project = store.createProject('/tmp/session-active', 'Active');
      const created = store.createSession({ projectId: project.id, kind: 'native', state: 'idle' });
      expect(created.activeSince).toBeUndefined();
      const running = store.updateSession(created.id, { state: 'running' });
      expect(running.activeSince).toBe(running.updatedAt);
      await new Promise(resolve => setTimeout(resolve, 5));
      store.updateSessionActivity(created.id);
      expect(store.updateSession(created.id, { state: 'waiting' }).activeSince).toBe(running.activeSince);
      store.updateSession(created.id, { state: 'idle' });
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(store.updateSession(created.id, { state: 'starting' }).activeSince).not.toBe(running.activeSince);
    } finally { store.close(); }
  });

  it('max-merges what was seen, writes nothing on a repeat, and keeps it across a reopen', () => {
    const path = scratch();
    writeLegacyDatabase(path);
    const store = new Store(path);
    const legacy = store.getSession('s-native');
    expect(legacy.seenActivityAt).toBe(legacy.lastActivityAt);
    const created = store.createSession({ projectId: 'p1', kind: 'native' });
    expect(created.seenActivityAt).toBe(created.lastActivityAt);
    store.updateSessionActivity(created.id, '2030-01-01T00:00:02.000Z');
    const revision = store.listRevision;
    expect(store.markSessionSeen(created.id, '2030-01-01T00:00:01.000Z')?.seenActivityAt).toBe('2030-01-01T00:00:01.000Z');
    expect(store.markSessionSeen(created.id, '2030-01-01T00:00:01.000Z')).toBeUndefined();
    expect(store.markSessionSeen(created.id, '2030-01-01T00:00:00.500Z')).toBeUndefined();
    // Never past the conversation's own activity, whatever the reporting device's clock says.
    expect(store.markSessionSeen(created.id, '2031-01-01T00:00:00.000Z')?.seenActivityAt).toBe('2030-01-01T00:00:02.000Z');
    expect(store.markSessionSeen(created.id)).toBeUndefined();
    expect(store.listRevision).toBe(revision + 2);
    store.close();
    const reopened = new Store(path);
    try {
      expect(reopened.getSession(created.id).seenActivityAt).toBe('2030-01-01T00:00:02.000Z');
      expect(reopened.getSession('s-native').seenActivityAt).toBe(legacy.lastActivityAt);
    } finally { reopened.close(); }
  });
});

describe('conversation naming', () => {
  it('names a conversation after the message a client accepted, and only once', () => {
    const store = new Store(':memory:');
    try {
      const project = store.createProject('/tmp/naming', 'Naming');
      const created = store.createSession({ projectId: project.id, kind: 'native', state: 'idle' });
      expect(created.title).toBe('New conversation');
      store.createRun(created.id, 'command-1', '远端有更新，你拉取一下，然后 git push 到远端\n第二行');
      expect(store.getSession(created.id)).toMatchObject({ title: '远端有更新，你拉取一下，然后 git push 到远端', titleSource: 'prompt' });
      store.createRun(created.id, 'command-2', '再改一下');
      expect(store.getSession(created.id).title).toBe('远端有更新，你拉取一下，然后 git push 到远端');
    } finally { store.close(); }
  });

  it('names a native submission from its first message, whichever CLI runs it', () => {
    const store = new Store(':memory:');
    try {
      const project = store.createProject('/tmp/naming-submission', 'Naming submission');
      const { session } = store.createNativeSubmission('client-session', { projectId: project.id, backendId: 'dsh', mode: 'agent' }, 'command-1', { text: '  为啥顶部的标题栏只能显示这么点字  ', attachmentIds: [], context: [] });
      expect(session).toMatchObject({ title: '为啥顶部的标题栏只能显示这么点字', titleSource: 'prompt' });
    } finally { store.close(); }
  });

  it('keeps a title the reader typed', () => {
    const store = new Store(':memory:');
    try {
      const project = store.createProject('/tmp/naming-user', 'Naming user');
      const created = store.createSession({ projectId: project.id, kind: 'native', state: 'idle' });
      store.updateSession(created.id, { title: '我的会话', titleSource: 'user' });
      store.createRun(created.id, 'command-1', '随便一条消息');
      expect(store.getSession(created.id).title).toBe('我的会话');
    } finally { store.close(); }
  });

  it('leaves an existing conversation that already had a name of its own', () => {
    const store = new Store(':memory:');
    try {
      const project = store.createProject('/tmp/naming-legacy', 'Naming legacy');
      const created = store.createSession({ projectId: project.id, kind: 'native', title: '理解一下未提交代码的改动，然后把他们移动到新分支…' });
      store.createRun(created.id, 'command-1', '再改一下');
      expect(store.getSession(created.id).title).toBe('理解一下未提交代码的改动，然后把他们移动到新分支…');
    } finally { store.close(); }
  });
});

describe('native backend session identity', () => {
  it('preserves durable receipt knowledge across restart while fencing genuinely ambiguous writes', () => {
    const file = scratch(), first = new Store(file);
    const project = first.createProject('/tmp/native-receipt-recovery', 'Receipt recovery');
    const session = first.createSession({ projectId: project.id, kind: 'native', backendId: 'claude', nativeSessionId: 'claude-thread' });
    const input = { text: 'continue', attachmentIds: [], context: [] };
    const observed = first.acceptNativeRun(session.id, 'observed', input, { mode: 'agent' });
    const oldUnknown = first.acceptNativeRun(session.id, 'old-outcome-unknown', input, { mode: 'agent' });
    const ambiguous = first.acceptNativeRun(session.id, 'ambiguous-write', input, { mode: 'agent' });
    const unreceipted = first.acceptNativeRun(session.id, 'unreceipted-outcome', input, { mode: 'agent' });
    first.transitionNativeRun(observed.id, ['queued'], { delivery: 'observed', expectsTurnOutcome: true, nativeMessageId: 'receipt-one', nativeTurnId: 'turn-one' }, { state: 'running' });
    first.transitionNativeRun(oldUnknown.id, ['queued'], { delivery: 'uncertain', stage: 'turn_outcome_unknown', expectsTurnOutcome: true, nativeMessageId: 'receipt-two', nativeTurnId: 'turn-two' }, { state: 'interrupted', error: 'old outcome check' });
    first.transitionNativeRun(ambiguous.id, ['queued'], { delivery: 'input_sent', expectsTurnOutcome: true });
    first.transitionNativeRun(unreceipted.id, ['queued'], { delivery: 'uncertain', stage: 'turn_outcome_unknown', expectsTurnOutcome: true }, { state: 'interrupted' });
    // Codex keeps its app-server through a restart: its observed turn waits for the daemon's record of the end.
    const codex = first.createSession({ projectId: project.id, kind: 'native', backendId: 'codex', nativeSessionId: 'codex-thread' });
    const codexObserved = first.acceptNativeRun(codex.id, 'codex-observed', input, { mode: 'default' });
    const codexUnknown = first.acceptNativeRun(codex.id, 'codex-old-unknown', input, { mode: 'default' });
    first.transitionNativeRun(codexObserved.id, ['queued'], { delivery: 'observed', stage: 'executing', nativeMessageId: 'codex-receipt', nativeTurnId: 'codex-turn' }, { state: 'running' });
    first.transitionNativeRun(codexUnknown.id, ['queued'], { delivery: 'uncertain', stage: 'turn_outcome_unknown', nativeMessageId: 'codex-receipt-2', nativeTurnId: 'codex-turn-2' }, { state: 'interrupted', error: 'old outcome check' });
    // Droid dies with the service; recovery leaves its run to the idle/exit rules.
    const droid = first.createSession({ projectId: project.id, kind: 'native', backendId: 'droid', nativeSessionId: 'droid-chat' });
    const droidObserved = first.acceptNativeRun(droid.id, 'droid-observed', input, { mode: 'default' });
    first.transitionNativeRun(droidObserved.id, ['queued'], { delivery: 'observed', stage: 'executing', nativeMessageId: 'droid-receipt', nativeTurnId: 'droid-turn' }, { state: 'running' });
    first.close();
    const restored = new Store(file);
    try {
      restored.recoverInterruptedRuns();
      for (const run of [observed, oldUnknown]) {
        expect(restored.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', stage: 'executing', expectsTurnOutcome: true } });
        expect(restored.getRun(run.id).native?.nativeMessageId).toBeDefined();
        expect(restored.getRun(run.id).error).toBeUndefined();
      }
      for (const run of [ambiguous, unreceipted]) expect(restored.getRun(run.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain' } });
      expect(restored.getRun(codexObserved.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', stage: 'executing', expectsTurnOutcome: true, nativeTurnId: 'codex-turn' } });
      expect(restored.getRun(codexUnknown.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain', stage: 'turn_outcome_unknown' } });
      expect(restored.getRun(droidObserved.id).native?.expectsTurnOutcome).toBeUndefined();
    } finally { restored.close(); }
  });

  it('keeps backend and profile in the idempotent session creation identity', () => {
    const store = new Store(':memory:');
    try {
      const project = store.createProject('/tmp/native-profile-identity', 'Native profile identity');
      const input = { text: 'start this thread', attachmentIds: [], context: [] };
      const first = store.createNativeSubmission('client-session', { projectId: project.id, backendId: 'codex', backendProfileId: 'personal', mode: 'default' }, 'initial-command', input);
      expect(first.session).toMatchObject({ backendId: 'codex', backendProfileId: 'personal' });
      const retry = store.createNativeSubmission('client-session', { projectId: project.id, backendId: 'codex', backendProfileId: 'personal', mode: 'default' }, 'initial-command', input);
      expect(retry.session.id).toBe(first.session.id);
      expect(retry.run.id).toBe(first.run.id);
      expect(() => store.createNativeSubmission('client-session', { projectId: project.id, backendId: 'codex', backendProfileId: 'team', mode: 'default' }, 'initial-command', input)).toThrow(expect.objectContaining({ code: 'SESSION_ID_CONFLICT' }));
      expect(() => store.createNativeSubmission('client-session', { projectId: project.id, backendId: 'claude', backendProfileId: 'personal', mode: 'default' }, 'initial-command', input)).toThrow(expect.objectContaining({ code: 'SESSION_ID_CONFLICT' }));
    } finally { store.close(); }
  });

  it('exclusively binds provider session ids across profiles, legacy Cursor ids, archives, and unresolved run receipts', () => {
    const store = new Store(':memory:');
    try {
      const projectA = store.createProject('/tmp/native-id-owner-a', 'Owner A');
      const projectB = store.createProject('/tmp/native-id-owner-b', 'Owner B');
      const dshOwner = store.createSession({
        projectId: projectA.id, kind: 'native', backendId: 'dsh', backendProfileId: 'personal', nativeSessionId: 'dsh-shared-id',
      });
      expect(() => store.createSession({
        projectId: projectB.id, kind: 'native', backendId: 'dsh', backendProfileId: 'team', nativeSessionId: 'dsh-shared-id',
      })).toThrow(expect.objectContaining({ code: 'NATIVE_SESSION_ID_IN_USE' }));
      expect(() => store.createNativeSubmission('duplicate-dsh-session', {
        projectId: projectB.id, backendId: 'dsh', backendProfileId: 'team', nativeSessionId: 'dsh-shared-id', mode: 'agent',
      }, 'duplicate-command', { text: 'must not bind twice', attachmentIds: [], context: [] }))
        .toThrow(expect.objectContaining({ code: 'NATIVE_SESSION_ID_IN_USE' }));
      const lateBound = store.createSession({ projectId: projectB.id, kind: 'native', backendId: 'dsh', backendProfileId: 'team' });
      expect(() => store.updateSession(lateBound.id, { nativeSessionId: 'dsh-shared-id' }))
        .toThrow(expect.objectContaining({ code: 'NATIVE_SESSION_ID_IN_USE' }));

      // A native id is scoped to its provider, not globally across unrelated CLIs.
      expect(store.createSession({ projectId: projectB.id, kind: 'native', backendId: 'codex', nativeSessionId: 'dsh-shared-id' }))
        .toMatchObject({ backendId: 'codex', nativeSessionId: 'dsh-shared-id' });

      const legacyCursor = store.createSession({ projectId: projectA.id, kind: 'native', cursorSessionId: 'legacy-cursor-id' });
      expect(() => store.createSession({ projectId: projectB.id, kind: 'native', backendId: 'cursor', nativeSessionId: 'legacy-cursor-id' }))
        .toThrow(expect.objectContaining({ code: 'NATIVE_SESSION_ID_IN_USE' }));

      const transferSource = store.createSession({ projectId: projectA.id, kind: 'native', backendId: 'claude', nativeSessionId: 'archived-transfer-id' });
      store.updateSession(transferSource.id, { archivedAt: '2026-10-03T00:00:00.000Z', state: 'archived' });
      const transferTarget = store.createSession({ projectId: projectB.id, kind: 'native', backendId: 'claude', nativeSessionId: 'archived-transfer-id' });
      expect(() => store.updateSession(transferSource.id, { archivedAt: undefined, state: 'idle' }))
        .toThrow(expect.objectContaining({ code: 'NATIVE_SESSION_ID_IN_USE' }));
      expect(store.getSession(transferTarget.id).archivedAt).toBeUndefined();

      const runInput = { text: 'keep this receipt bound', attachmentIds: [], context: [] };
      const driftOwner = store.createSession({ projectId: projectA.id, kind: 'native', backendId: 'dsh', nativeSessionId: 'old-live-id' });
      const run = store.acceptNativeRun(driftOwner.id, 'old-id-command', runInput, { mode: 'agent' });
      // Native adapters can switch their current chat id while an earlier run keeps its exact id.
      store.updateSession(driftOwner.id, { nativeSessionId: 'new-live-id' });
      expect(store.getSession(driftOwner.id).nativeSessionId).toBe('new-live-id');
      expect(store.getRun(run.id).native?.nativeSessionId).toBe('old-live-id');
      expect(() => store.createSession({ projectId: projectB.id, kind: 'native', backendId: 'dsh', nativeSessionId: 'old-live-id' }))
        .toThrow(expect.objectContaining({ code: 'NATIVE_SESSION_ID_IN_USE' }));
      store.updateSession(driftOwner.id, { nativeSessionId: 'old-live-id' });
      expect(store.getSession(driftOwner.id).nativeSessionId).toBe('old-live-id');
      store.updateSession(driftOwner.id, { archivedAt: '2026-10-03T00:00:00.000Z', state: 'archived' });
      expect(() => store.createSession({ projectId: projectB.id, kind: 'native', backendId: 'dsh', nativeSessionId: 'old-live-id' }))
        .toThrow(expect.objectContaining({ code: 'NATIVE_SESSION_ID_IN_USE' }));

      // Preserve Cursor's legacy alias when applying the same uniqueness rule.
      expect(store.getSession(legacyCursor.id).backendId ?? 'cursor').toBe('cursor');
    } finally { store.close(); }
  });

  it('keeps Cursor\'s canonical and legacy chat ids in one value across switches and clears', () => {
    const store = new Store(':memory:');
    try {
      const project = store.createProject('/tmp/cursor-id-mirror', 'Cursor id mirror');
      const owner = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor', nativeSessionId: 'chat-a', cursorSessionId: 'chat-a' });
      const peer = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor', nativeSessionId: 'chat-b', cursorSessionId: 'chat-b' });

      // A switch may name either field; the row must never end up naming two chats.
      expect(store.updateSession(owner.id, { cursorSessionId: 'chat-c' })).toMatchObject({ nativeSessionId: 'chat-c', cursorSessionId: 'chat-c' });
      expect(store.updateSession(owner.id, { nativeSessionId: 'chat-d' })).toMatchObject({ nativeSessionId: 'chat-d', cursorSessionId: 'chat-d' });

      // The canonical field is the one exclusivity uses; the mirror cannot smuggle a chat past its
      // owner, and a refused switch leaves the peer on its own chat.
      expect(() => store.updateSession(peer.id, { cursorSessionId: 'chat-d' }))
        .toThrow(expect.objectContaining({ code: 'NATIVE_SESSION_ID_IN_USE' }));
      expect(store.getSession(peer.id)).toMatchObject({ nativeSessionId: 'chat-b', cursorSessionId: 'chat-b' });

      // Two different ids in one write are ambiguous, and nothing is written.
      expect(() => store.updateSession(owner.id, { nativeSessionId: 'chat-e', cursorSessionId: 'chat-f' }))
        .toThrow(expect.objectContaining({ code: 'INVALID_NATIVE_SESSION_ID' }));
      expect(store.getSession(owner.id)).toMatchObject({ nativeSessionId: 'chat-d', cursorSessionId: 'chat-d' });

      // Clearing either field unbinds the pair, so the chat is free for another conversation.
      const cleared = store.updateSession(owner.id, { nativeSessionId: undefined });
      expect(cleared.nativeSessionId).toBeUndefined();
      expect(cleared.cursorSessionId).toBeUndefined();
      // Repeating the clear is a no-op, so streams are not pushed a frame for it.
      expect(store.updateSession(owner.id, { cursorSessionId: undefined }).updatedAt).toBe(cleared.updatedAt);
      expect(store.updateSession(peer.id, { cursorSessionId: 'chat-d' })).toMatchObject({ nativeSessionId: 'chat-d', cursorSessionId: 'chat-d' });

      // A caller that only names the legacy field still ends up on one canonical chat.
      const legacy = store.createSession({ projectId: project.id, kind: 'native', cursorSessionId: 'legacy-chat' });
      expect(legacy).toMatchObject({ backendId: 'cursor', nativeSessionId: 'legacy-chat', cursorSessionId: 'legacy-chat' });
      expect(store.updateSession(legacy.id, { cursorSessionId: 'legacy-next' })).toMatchObject({ nativeSessionId: 'legacy-next', cursorSessionId: 'legacy-next' });

      // Another backend keeps the id it was given and never grows a Cursor mirror.
      const codex = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex', nativeSessionId: 'thread-1' });
      expect(store.updateSession(codex.id, { nativeSessionId: 'thread-2' })).toMatchObject({ nativeSessionId: 'thread-2' });
      expect(store.getSession(codex.id).cursorSessionId).toBeUndefined();
    } finally { store.close(); }
  });

  it('reads rows written before backendId and nativeSessionId existed as one Cursor chat, leaving them as stored', () => {
    const store = new Store(':memory:');
    try {
      const project = store.createProject('/tmp/legacy-identity', 'Legacy identity');
      const stamp = '2026-01-01T00:00:00.000Z';
      store.db.prepare('INSERT INTO sessions(id,project_id,json) VALUES(?,?,?)').run('legacy-s', project.id, JSON.stringify({
        id: 'legacy-s', projectId: project.id, kind: 'native', title: 'Old', tags: [], state: 'idle', mode: 'agent', cursorSessionId: 'old-chat', createdAt: stamp, updatedAt: stamp,
      }));
      store.db.prepare('INSERT INTO runs(id,session_id,command_id,json) VALUES(?,?,?,?)').run('legacy-r', 'legacy-s', 'legacy-c', JSON.stringify({
        id: 'legacy-r', sessionId: 'legacy-s', commandId: 'legacy-c', prompt: 'hi', state: 'running', createdAt: stamp, updatedAt: stamp,
        native: { input: { text: 'hi', attachmentIds: [], context: [] }, config: { mode: 'agent' }, fingerprint: 'f', delivery: 'observed', attempt: 0, cursorSessionId: 'old-chat' },
      }));

      expect(store.getSession('legacy-s')).toMatchObject({ backendId: 'cursor', nativeSessionId: 'old-chat', cursorSessionId: 'old-chat' });
      expect(store.listSessions().find(session => session.id === 'legacy-s')).toMatchObject({ backendId: 'cursor', nativeSessionId: 'old-chat' });
      expect(store.getRun('legacy-r').native).toMatchObject({ backendId: 'cursor', nativeSessionId: 'old-chat', cursorSessionId: 'old-chat' });
      expect(store.listUnfinishedNativeRuns('legacy-s')[0]!.native).toMatchObject({ backendId: 'cursor', nativeSessionId: 'old-chat' });
      // The SQL filters read the missing backend the same way, and the chat stays exclusive.
      expect(store.sessionsMissingMessages(['cursor'], 10).map(session => session.id)).toContain('legacy-s');
      expect(() => store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor', nativeSessionId: 'old-chat' }))
        .toThrow(expect.objectContaining({ code: 'NATIVE_SESSION_ID_IN_USE' }));
      // Reading does not rewrite the row.
      expect(JSON.parse((store.db.prepare('SELECT json FROM sessions WHERE id=?').get('legacy-s') as { json: string }).json)).not.toHaveProperty('backendId');
    } finally { store.close(); }
  });

  it('persists protocol interaction idempotency receipts and rejects a changed retry after restart', () => {
    const path = scratch();
    let store = new Store(path);
    const project = store.createProject('/tmp/native-interaction-receipt', 'Native interaction receipt');
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'claude', backendProfileId: 'local' });
    const candidate = {
      fingerprint: 'response-fingerprint', interactionId: 'claude-permission:provider-id', revision: '1',
      result: { status: 'uncertain' as const, message: 'Waiting for Claude confirmation.' }, createdAt: '2026-10-03T00:00:00.000Z',
    };
    store.saveNativeInteractionReceipt(session.id, 'web-request-uuid', candidate);
    store.close();

    store = new Store(path);
    try {
      expect(store.getNativeInteractionReceipt(session.id, 'web-request-uuid')).toEqual(candidate);
      const completed = { ...candidate, result: { status: 'completed' as const, message: 'Claude confirmed the decision.' } };
      store.saveNativeInteractionReceipt(session.id, 'web-request-uuid', completed);
      expect(store.getNativeInteractionReceipt(session.id, 'web-request-uuid')).toEqual(completed);
      expect(() => store.saveNativeInteractionReceipt(session.id, 'web-request-uuid', { ...completed, fingerprint: 'different-answer' }))
        .toThrow(expect.objectContaining({ code: 'NATIVE_INTERACTION_REQUEST_CONFLICT' }));
    } finally { store.close(); }
  });

  it('drops expired interaction receipts and caps the rest per session, never the one being saved', () => {
    const store = new Store(':memory:');
    try {
      const project = store.createProject('/tmp/native-receipt-retention', 'Receipt retention');
      const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'claude' });
      const receipt = (createdAt: string) => ({ fingerprint: 'f', interactionId: 'i', revision: '1', result: { status: 'completed' as const, message: 'ok' }, createdAt });
      const day = 24 * 60 * 60_000;
      // The receipt being written survives even when it is already past the TTL.
      store.saveNativeInteractionReceipt(session.id, 'stale', receipt(new Date(Date.now() - 8 * day).toISOString()));
      expect(store.getNativeInteractionReceipt(session.id, 'stale')).toBeDefined();
      store.saveNativeInteractionReceipt(session.id, 'recent', receipt(new Date(Date.now() - day).toISOString()));
      expect(store.getNativeInteractionReceipt(session.id, 'stale')).toBeUndefined();
      expect(store.getNativeInteractionReceipt(session.id, 'recent')).toBeDefined();

      for (let index = 0; index < 250; index += 1) store.saveNativeInteractionReceipt(session.id, `bulk-${index}`, receipt(new Date(Date.now() - (250 - index) * 1000).toISOString()));
      const kept = store.getSetting<Record<string, unknown>>(`native-interactions:${session.id}`, {});
      expect(Object.keys(kept)).toHaveLength(200);
      expect(store.getNativeInteractionReceipt(session.id, 'bulk-249')).toBeDefined();
      expect(store.getNativeInteractionReceipt(session.id, 'bulk-0')).toBeUndefined();
    } finally { store.close(); }
  });

  it('bumps configRevision from the stored value, not from a caller copy', () => {
    const store = new Store(':memory:');
    try {
      const project = store.createProject('/tmp/native-bump-config', 'Bump config');
      const stale = store.createSession({ projectId: project.id, kind: 'native', configRevision: 2 });
      store.bumpConfig(stale.id, { approval: 'unrestricted' });
      const second = store.bumpConfig(stale.id, { model: 'next', configRevision: 99 });
      expect(second).toMatchObject({ configRevision: 4, approval: 'unrestricted', model: 'next' });
    } finally { store.close(); }
  });

  it('keeps only the newest session snapshot events, leaving other events alone', () => {
    const store = new Store(':memory:');
    try {
      const project = store.createProject('/tmp/native-session-snapshots', 'Session snapshots');
      const session = store.createSession({ projectId: project.id, kind: 'native' });
      store.appendEvent(session.id, 'run_updated', { run: {} });
      for (let index = 0; index < 120; index += 1) store.appendEvent(session.id, 'session', { session: { ...session, title: `t${index}` } });
      const events = store.getEvents(session.id);
      const snapshots = events.filter(event => event.type === 'session');
      expect(snapshots.length).toBeLessThanOrEqual(15);
      expect(snapshots.length).toBeGreaterThanOrEqual(5);
      expect((snapshots.at(-1)!.data.session as { title: string }).title).toBe('t119');
      expect(events.filter(event => event.type === 'run_updated')).toHaveLength(1);
      expect(store.pruneSessionSnapshots(session.id, 3)).toBe(snapshots.length - 3);
      expect(store.getEvents(session.id).filter(event => event.type === 'session')).toHaveLength(3);
    } finally { store.close(); }
  });
});
