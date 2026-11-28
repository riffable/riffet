import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_BACKEND_SPECS,
  createExternalPluginBackendSpec,
  getBackendCompatSpec,
  listBackendCompatSpecs,
} from '../scripts/cli-compat/backends/index.js';
import {
  collectObservedRawVocabulary,
  compareVocabulary,
  exportRedactedDriftCandidate,
  extractCommittedVocabulary,
} from '../scripts/cli-compat/drift.js';
import { BUILTIN_CLI_BACKENDS, TCK_SCENARIO_IDS } from '../scripts/cli-compat/manifest.js';
import {
  assertIsolatedPath,
  createCompatSandbox,
  createHangingStubExecutable,
  productionRiffetStateDir,
  scrubNestedCliEnv,
} from '../scripts/cli-compat/sandbox.js';
import {
  TCK_SCENARIO_MAP,
  TCK_SCENARIOS,
  enableBuiltinPluginIfNeeded,
  evaluateScenarioApplicability,
} from '../scripts/cli-compat/tck.js';

describe('compat sandbox isolation and fixtures', () => {
  it('blocks production ~/.local/share/riffet and any descendant path', () => {
    const prod = productionRiffetStateDir();
    expect(() => assertIsolatedPath(prod)).toThrow(/production state dir/i);
    expect(() => assertIsolatedPath(join(prod, 'workbench.db'))).toThrow(/production state dir/i);
    expect(() => assertIsolatedPath(join(prod, 'nested', 'tmux.sock'))).toThrow(/production state dir/i);
    expect(() => assertIsolatedPath(join(tmpdir(), 'riffet-compat-safe-test'))).not.toThrow();
  });

  it('strips all provider/credential/config-dir env vars in mock mode and preserves user credentials in --live mode', () => {
    const sampleEnv = {
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_PID: '12345',
      CLAUDE_EFFORT: 'high',
      RIFFET_CLAUDE_HOOK_TOKEN: 'secret',
      AI_AGENT: '1',
      RIFFET_STATE_DIR: '/tmp/prod',
      RIFFET_DEV_PLUGINS: '/tmp/dev-plugin',
      TRAECLI_HOME: '/tmp/trae',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_API_KEY: 'test-key-1',
      ANTHROPIC_AUTH_TOKEN: 'test-token-1',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'test-key-2',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      DEEPSEEK_API_KEY: 'test-key-3',
      GEMINI_API_KEY: 'test-key-4',
      GOOGLE_GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com',
      CLAUDE_CONFIG_DIR: '/tmp/claude-cfg',
      CODEX_HOME: '/tmp/codex-home',
      PI_CODING_AGENT_DIR: '/tmp/pi-dir',
      DSH_CONFIG_DIR: '/tmp/dsh-dir',
      FACTORY_API_KEY: 'test-key-5',
      FACTORY_HOME_OVERRIDE: '/tmp/factory-home',
      SAFE_CUSTOM_VAR: 'keep-me',
    };

    const cleanedMock = scrubNestedCliEnv(sampleEnv);
    expect(cleanedMock).toEqual({
      PATH: '/usr/bin',
      SAFE_CUSTOM_VAR: 'keep-me',
    });

    const cleanedLive = scrubNestedCliEnv(sampleEnv, { live: true });
    expect(cleanedLive.CLAUDECODE).toBeUndefined();
    expect(cleanedLive.RIFFET_STATE_DIR).toBeUndefined();
    expect(cleanedLive.RIFFET_DEV_PLUGINS).toBeUndefined();
    expect(cleanedLive.ANTHROPIC_API_KEY).toBe('test-key-1');
    expect(cleanedLive.OPENAI_API_KEY).toBe('test-key-2');
    expect(cleanedLive.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-cfg');
    expect(cleanedLive.CODEX_HOME).toBe('/tmp/codex-home');
    expect(cleanedLive.SAFE_CUSTOM_VAR).toBe('keep-me');
  });

  it('creates an isolated git project with PNG, skill, subagent, and hanging stub, then cleans up', async () => {
    const sandbox = await createCompatSandbox({ backend: 'claude' });
    try {
      expect(existsSync(join(sandbox.projectDir, 'README.md'))).toBe(true);
      expect(existsSync(join(sandbox.projectDir, 'notes.txt'))).toBe(true);
      expect(existsSync(sandbox.imagePath)).toBe(true);
      expect(existsSync(sandbox.skillPath)).toBe(true);
      expect(existsSync(sandbox.agentPath)).toBe(true);
      expect(existsSync(sandbox.cliHome)).toBe(true);

      // Verify valid PNG signature magic bytes.
      const pngBytes = readFileSync(sandbox.imagePath);
      expect(pngBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);

      // Verify git repo initialized with an initial commit.
      const gitLog = execFileSync('git', ['log', '--oneline', '-n', '1'], {
        cwd: sandbox.projectDir,
        encoding: 'utf8',
      });
      expect(gitLog).toContain('init compat sandbox');

      // Verify hanging stub is executable and traps SIGTERM.
      const stubPath = await createHangingStubExecutable(sandbox.stubsDir);
      const stat = statSync(stubPath);
      expect(stat.mode & 0o111).not.toBe(0);
      const stubContent = readFileSync(stubPath, 'utf8');
      expect(stubContent).toContain('trap');
      expect(stubContent).toContain('sleep');
    } finally {
      const result = await sandbox.cleanup();
      expect(result.leakedTmux).toBe(false);
    }

    expect(existsSync(sandbox.root)).toBe(false);
  });
});

describe('backend compat specs', () => {
  it('covers all 8 built-in CLI backends and supports external plugin backends', () => {
    const specs = listBackendCompatSpecs();
    expect(specs.map(s => s.id)).toEqual([...BUILTIN_CLI_BACKENDS]);
    expect(BUILTIN_BACKEND_SPECS.antigravity.requiresPlugin).toBe('riffet.antigravity');
    expect(BUILTIN_BACKEND_SPECS.cursor.requiresPlugin).toBe('riffet.cursor');
    expect(BUILTIN_BACKEND_SPECS.cursor.tier).toBe('C');
    expect(BUILTIN_BACKEND_SPECS.traex.tier).toBe('B');

    const external = createExternalPluginBackendSpec('acme.agent', {
      pluginDir: '/tmp/acme-plugin',
      protocol: 'openai-chat',
    });
    expect(external.id).toBe('acme.agent');
    expect(external.tier).toBe('A');
    expect(external.pluginDir).toBe('/tmp/acme-plugin');

    const resolved = getBackendCompatSpec('acme.agent', { pluginDir: '/tmp/acme-plugin' });
    expect(resolved.id).toBe('acme.agent');

    // Verify accurate approval modes, capability declarations, and tool arg profiles.
    expect(BUILTIN_BACKEND_SPECS.codex.approvalModes?.auto).toBe('danger-full-access');
    expect(BUILTIN_BACKEND_SPECS.traex.approvalModes?.auto).toBe('danger-full-access');
    expect(BUILTIN_BACKEND_SPECS.dsh.approvalModes).toEqual({ ask: 'read-only', auto: 'danger-full-access' });
    expect(BUILTIN_BACKEND_SPECS.claude.supportsBackgroundTasks).toBe(true);
    expect(BUILTIN_BACKEND_SPECS.claude.supportsSubagents).toBe(true);
    expect(BUILTIN_BACKEND_SPECS.pi.supportsBackgroundTasks).toBe(false);
    expect(BUILTIN_BACKEND_SPECS.pi.supportsSubagents).toBe(false);
    expect(BUILTIN_BACKEND_SPECS.dsh.supportsSubagents).toBe(true);
    expect(BUILTIN_BACKEND_SPECS.dsh.supportsBackgroundTasks).toBe(false);
    expect(BUILTIN_BACKEND_SPECS.claude.toolMap.argProfile).toBe('claude');
    expect(BUILTIN_BACKEND_SPECS.codex.toolMap.argProfile).toBe('codex');
    expect(BUILTIN_BACKEND_SPECS.pi.toolMap.argProfile).toBe('pi');
    expect(BUILTIN_BACKEND_SPECS.droid.toolMap.argProfile).toBe('droid');
  });
});

describe('enableBuiltinPluginIfNeeded', () => {
  it('sends { enablement: "on" } and refreshes on 2xx, and throws on 400+', async () => {
    const calls: Array<{ method: string; url: string; payload: unknown }> = [];
    let refreshed = 0;
    await enableBuiltinPluginIfNeeded(
      async (method, url, payload) => {
        calls.push({ method, url, payload });
        return { statusCode: 200, body: '{"ok":true}', json: { ok: true } };
      },
      'riffet.antigravity',
      async () => { refreshed += 1; },
    );
    expect(calls).toEqual([
      { method: 'PATCH', url: '/api/integrations/riffet.antigravity', payload: { enablement: 'on' } },
    ]);
    expect(refreshed).toBe(1);

    await expect(
      enableBuiltinPluginIfNeeded(
        async () => ({ statusCode: 400, body: '{"error":"invalid payload"}', json: { error: 'invalid payload' } }),
        'riffet.cursor',
      ),
    ).rejects.toThrow(/Failed to enable built-in plugin "riffet\.cursor".*400/);
  });
});

describe('drift vocabulary extraction, diffing, and redaction', () => {
  it('extracts non-empty baseline vocabularies from real Codex, TraeX, and Claude fixtures', () => {
    const codex = extractCommittedVocabulary('codex');
    expect(codex.baselineVersion).toBeTruthy();
    expect(codex.jsonRpcMethods).toContain('turn/start');
    expect(codex.itemTypes.length).toBeGreaterThan(0);
    expect(codex.hookEvents).toContain('PreToolUse');
    expect(codex.transcriptRowTypes.length).toBeGreaterThan(0);
    expect(codex.tokens.length).toBeGreaterThan(10);

    const traex = extractCommittedVocabulary('traex');
    expect(traex.baselineVersion).toBeTruthy();
    expect(traex.jsonRpcMethods).toContain('turn/start');
    expect(traex.tokens.length).toBeGreaterThan(5);

    const claude = extractCommittedVocabulary('claude');
    expect(claude.baselineVersion).toBeTruthy();
    expect(claude.hookEvents).toContain('UserPromptSubmit');
    expect(claude.hookEvents).toContain('Stop');
    expect(claude.transcriptRowTypes).toContain('assistant');
    expect(claude.itemTypes).toContain('tool_use');
    expect(claude.tokens.length).toBeGreaterThan(10);
  });

  it('collects observed raw CLI vocabulary in the exact same namespace as extractCommittedVocabulary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'riffet-raw-vocab-'));
    try {
      const cliHome = join(root, 'cli-home');
      // 1. Codex rollout JSONL
      const codexSessions = join(cliHome, 'codex', 'sessions', '2026', '11', '28');
      mkdirSync(codexSessions, { recursive: true });
      writeFileSync(
        join(codexSessions, 'rollout-1.jsonl'),
        [
          JSON.stringify({ type: 'session_meta', payload: { id: 'thr-1' } }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
          JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }),
          JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
        ].join('\n') + '\n',
        'utf8',
      );
      const codexObserved = await collectObservedRawVocabulary('codex', { cliHome }, { baselineVersion: '0.172.0' });
      const codexCommitted = extractCommittedVocabulary('codex');
      expect(codexObserved.tokens).toContain('row:session_meta');
      expect(codexObserved.tokens).toContain('row:event_msg:task_started');
      expect(codexObserved.tokens).toContain('row:response_item:function_call');
      expect(codexObserved.tokens).toContain('row:response_item:message');
      for (const tok of ['row:session_meta', 'row:event_msg:task_started', 'row:response_item:function_call', 'row:response_item:message']) {
        expect(codexCommitted.tokens).toContain(tok);
      }

      // 2. Claude transcript JSONL
      const claudeProjects = join(cliHome, 'claude', 'projects', 'demo-project');
      mkdirSync(claudeProjects, { recursive: true });
      writeFileSync(
        join(claudeProjects, 'session-1.jsonl'),
        [
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'hmm' },
                { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: 'README.md' } },
                { type: 'text', text: 'done' },
              ],
            },
          }),
        ].join('\n') + '\n',
        'utf8',
      );
      const claudeObserved = await collectObservedRawVocabulary('claude', { cliHome }, { baselineVersion: '2.1.332' });
      const claudeCommitted = extractCommittedVocabulary('claude');
      expect(claudeObserved.tokens).toContain('item:thinking');
      for (const tok of ['row:user', 'row:assistant', 'item:tool_use', 'item:text']) {
        expect(claudeObserved.tokens).toContain(tok);
        expect(claudeCommitted.tokens).toContain(tok);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accurately detects added, missing, and drifted vocabulary tokens', () => {
    const same = compareVocabulary(['rpc:turn/start', 'hook:Stop'], ['hook:Stop', 'rpc:turn/start']);
    expect(same).toEqual({ drifted: false, added: [], missing: [] });

    const diff = compareVocabulary(
      ['rpc:turn/start', 'hook:Stop', 'item:agentMessage'],
      ['rpc:turn/start', 'hook:Stop', 'item:newUnknownBlock'],
    );
    expect(diff.drifted).toBe(true);
    expect(diff.added).toEqual(['item:newUnknownBlock']);
    expect(diff.missing).toEqual(['item:agentMessage']);
  });

  it('redacts local home paths, remote URLs, emails, and secrets before writing drift JSON', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'riffet-drift-test-'));
    try {
      const home = homedir();
      const sampleSecret = ['sk', 'ant', 'fake0123456789abcdefghijkl'].join('-');
      const sampleUserPath = `${home}/projects/secret-repo/file.ts`;
      const sampleEmail = ['developer', 'corp-internal.example'].join('@');
      const { filePath } = exportRedactedDriftCandidate(outDir, 'claude', '2.2.0', {
        cwd: sampleUserPath,
        endpoint: 'https://internal-gateway.corp.local/v1/messages',
        localLoopback: 'http://127.0.0.1:54321/v1/messages',
        apiKey: sampleSecret,
        rawLog: `error at ${sampleUserPath} for ${sampleEmail} using Bearer ${sampleSecret}`,
      });

      const written = readFileSync(filePath, 'utf8');
      expect(written).not.toContain(home);
      expect(written).not.toContain('internal-gateway.corp.local');
      expect(written).not.toContain(sampleSecret);
      expect(written).not.toContain(sampleEmail);
      expect(written).toContain('/home/user');
      expect(written).toContain('https://redacted.example.invalid/v1/messages');
      expect(written).toContain('http://127.0.0.1:<port>/v1/messages');
      expect(written).toContain('[REDACTED]');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('TCK scenario registry and 4-state applicability', () => {
  it('registers 100% of TCK_SCENARIO_IDS with no omissions and no extras', () => {
    const registeredIds = TCK_SCENARIOS.map(s => s.id);
    expect(registeredIds).toHaveLength(TCK_SCENARIO_IDS.length);
    expect(new Set(registeredIds).size).toBe(TCK_SCENARIO_IDS.length);
    expect([...registeredIds].sort()).toEqual([...TCK_SCENARIO_IDS].sort());
    for (const id of TCK_SCENARIO_IDS) {
      expect(TCK_SCENARIO_MAP.has(id)).toBe(true);
    }
  });

  it('computes 4-state verdicts cleanly from capabilities, traits, tier, live, and prevBin', () => {
    const steerScenario = TCK_SCENARIO_MAP.get('steer-valid')!;
    const compactScenario = TCK_SCENARIO_MAP.get('slash-compact')!;
    const restartScenario = TCK_SCENARIO_MAP.get('restart-idle')!;
    const crossVersionScenario = TCK_SCENARIO_MAP.get('cross-version-resume')!;
    const basicScenario = TCK_SCENARIO_MAP.get('basic-turn')!;
    const disconnectScenario = TCK_SCENARIO_MAP.get('stream-disconnect')!;

    // Missing capability -> not-applicable
    expect(
      evaluateScenarioApplicability(steerScenario, {
        tier: 'A',
        live: false,
        capabilities: { supportsSteer: false },
        traits: {},
        supportsSideChat: false,
      }),
    ).toEqual({
      run: false,
      verdict: { status: 'not-applicable', note: 'capability "supportsSteer" is not supported' },
    });

    // Missing trait (compactCommand) -> not-applicable
    expect(
      evaluateScenarioApplicability(compactScenario, {
        tier: 'A',
        live: false,
        capabilities: {},
        traits: {},
        supportsSideChat: false,
      }),
    ).toMatchObject({ run: false, verdict: { status: 'not-applicable' } });

    // Missing survivesRestart trait -> not-applicable
    expect(
      evaluateScenarioApplicability(restartScenario, {
        tier: 'A',
        live: false,
        capabilities: {},
        traits: { survivesRestart: false },
        supportsSideChat: false,
      }),
    ).toMatchObject({ run: false, verdict: { status: 'not-applicable' } });

    // Missing --prev-bin -> not-exercised
    expect(
      evaluateScenarioApplicability(crossVersionScenario, {
        tier: 'A',
        live: false,
        capabilities: { supportsResume: true },
        traits: {},
        supportsSideChat: false,
      }),
    ).toMatchObject({ run: false, verdict: { status: 'not-exercised' } });

    // With --prev-bin -> run
    expect(
      evaluateScenarioApplicability(crossVersionScenario, {
        tier: 'A',
        live: false,
        prevBin: '/tmp/prev-cli',
        capabilities: { supportsResume: true },
        traits: {},
        supportsSideChat: false,
      }),
    ).toEqual({ run: true });

    // Tier C offline on mockLlm scenario -> not-exercised
    expect(
      evaluateScenarioApplicability(basicScenario, {
        tier: 'C',
        live: false,
        capabilities: {},
        traits: {},
        supportsSideChat: false,
      }),
    ).toMatchObject({ run: false, verdict: { status: 'not-exercised' } });

    // Tier C with --live on basic-turn -> run
    expect(
      evaluateScenarioApplicability(basicScenario, {
        tier: 'C',
        live: true,
        capabilities: {},
        traits: {},
        supportsSideChat: false,
      }),
    ).toEqual({ run: true });

    // Mock-only fault injection skipped under --live -> not-exercised
    expect(
      evaluateScenarioApplicability(disconnectScenario, {
        tier: 'A',
        live: true,
        capabilities: {},
        traits: {},
        supportsSideChat: false,
      }),
    ).toMatchObject({ run: false, verdict: { status: 'not-exercised' } });
  });
});
