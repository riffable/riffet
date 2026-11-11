import { describe, expect, it } from 'vitest';
import { parsePsCommandLine } from '../../terminal/ps-argv.js';
import { codexInvocation, codexInvocationFingerprint } from './endpoint.js';

describe('Codex terminal endpoint identification', () => {
  const cwd = '/workspace/project';
  const threadId = 'a9d865e1-b3a4-4910-8487-222c985f0040';
  const endpoint = 'unix:///tmp/riffet-codex/app-server.sock';
  const argv = ['/opt/homebrew/bin/codex', '--remote', endpoint, '--cd', cwd, 'resume', threadId];

  it('extracts only the endpoint for the requested thread and exact working directory', () => {
    expect(codexInvocation(argv, cwd, threadId)).toEqual({ cwd, threadId, endpoint });
    expect(codexInvocation(argv, `${cwd}-other`, threadId)).toBeUndefined();
    expect(codexInvocation(argv, cwd, 'another-thread')).toBeUndefined();
  });

  it('rejects non-Codex processes, missing arguments, and ambiguous repeated flags', () => {
    expect(codexInvocation(['/bin/echo', ...argv.slice(1)], cwd, threadId)).toBeUndefined();
    expect(codexInvocation(['/opt/homebrew/bin/codex', '--remote', endpoint, 'resume', threadId], cwd, threadId)).toBeUndefined();
    expect(codexInvocation([...argv, '--remote', endpoint], cwd, threadId)).toBeUndefined();
    expect(codexInvocation(['/opt/homebrew/bin/codex', '--remote', 'wss://host/private-token', '--cd', cwd, 'resume', threadId], cwd, threadId)).toBeUndefined();
    expect(codexInvocation(['/opt/homebrew/bin/codex', '--remote', 'unix://relative/socket', '--cd', cwd, 'resume', threadId], cwd, threadId)).toBeUndefined();
  });

  it('parses ps output without evaluating quoted arguments', () => {
    expect(parsePsCommandLine(`/opt/homebrew/bin/codex --remote '${endpoint}' --cd "/Users/me/project with spaces" resume ${threadId}`))
      .toEqual(['/opt/homebrew/bin/codex', '--remote', endpoint, '--cd', '/Users/me/project with spaces', 'resume', threadId]);
    expect(parsePsCommandLine(`/opt/homebrew/bin/codex --cd "unfinished`)).toBeUndefined();
    // `ps` is a display string, not a reversible argv API. If a host omits quoting around a
    // project path with spaces, the exact --cd argument cannot be recovered, so lookup fails safe.
    const unquotedPath = parsePsCommandLine(`/opt/homebrew/bin/codex --remote '${endpoint}' --cd /Users/me/project with spaces resume ${threadId}`)!;
    expect(codexInvocation(unquotedPath, '/Users/me/project with spaces', threadId)).toBeUndefined();
  });

  it('stores only an opaque fingerprint for a launch identity', () => {
    const fingerprint = codexInvocationFingerprint({ cwd, threadId, endpoint });
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain(endpoint);
    expect(fingerprint).not.toBe(codexInvocationFingerprint({ cwd, threadId, endpoint: 'ws://127.0.0.1:43130/other' }));
  });

  it('accepts a TRAE CLI TUI on an authenticated loopback port, and no other host', () => {
    const loopback = 'ws://127.0.0.1:51688';
    const traex = ['/Users/me/.local/bin/traex', '-c', 'check_for_update_on_startup=false', '--remote', loopback, '--remote-auth-token-env', 'RIFFET_APP_SERVER_TOKEN', '--cd', cwd, 'resume', threadId];
    expect(codexInvocation(traex, cwd, threadId)).toEqual({ cwd, threadId, endpoint: loopback });
    expect(codexInvocation(traex.map(arg => arg === loopback ? 'ws://0.0.0.0:51688' : arg), cwd, threadId)).toBeUndefined();
    expect(codexInvocation(traex.map(arg => arg === loopback ? 'ws://127.0.0.1:51688/path' : arg), cwd, threadId)).toBeUndefined();
  });
});
