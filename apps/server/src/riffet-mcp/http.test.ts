import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

describe('Riffet MCP Streamable HTTP endpoint', () => {
  it('handles JSON-RPC initialize, notifications, tools/list, tools/call and rejects invalid credentials', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'riffet-mcp-http-'));
    const booted = await createApp({ stateDir, auth: true, token: 'test-owner-token' });
    try {
      const project = booted.store.createProject(stateDir, 'HTTP MCP');
      const session = booted.store.createSession({ projectId: project.id, kind: 'native', backendId: 'claude', state: 'idle' });
      const spec = booted.riffetMcp.server(session.id)!;
      expect(spec).toBeDefined();
      const saved = JSON.parse(readFileSync(spec.credentialFile, 'utf8')) as { credential: string };
      const auth = { authorization: `Bearer ${saved.credential}` };

      // Unauthenticated request is rejected with 401.
      const unauth = await booted.app.inject({
        method: 'POST',
        url: '/api/riffet-mcp/http',
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      });
      expect(unauth.statusCode).toBe(401);

      // initialize negotiates protocol version and advertises tools.
      const init = await booted.app.inject({
        method: 'POST',
        url: '/api/riffet-mcp/http',
        headers: auth,
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      });
      expect(init.statusCode).toBe(200);
      expect(init.json()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-06-18', serverInfo: { name: 'riffet', version: '1' } },
      });

      // Notification returns 202 Accepted with empty body.
      const notif = await booted.app.inject({
        method: 'POST',
        url: '/api/riffet-mcp/http',
        headers: auth,
        payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
      });
      expect(notif.statusCode).toBe(202);

      // tools/list returns this conversation's tools.
      const list = await booted.app.inject({
        method: 'POST',
        url: '/api/riffet-mcp/http',
        headers: auth,
        payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      });
      expect(list.statusCode).toBe(200);
      const listed = list.json() as { result: { tools: Array<{ name: string }> } };
      expect(listed.result.tools.map(t => t.name)).toContain('notify_user');

      // tools/call executes a core tool and persists its effect.
      const call = await booted.app.inject({
        method: 'POST',
        url: '/api/riffet-mcp/http',
        headers: auth,
        payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'notify_user', arguments: { body: 'hello via http' } } },
      });
      expect(call.statusCode).toBe(200);
      expect(call.json().result?.isError).toBeUndefined();
      expect(booted.notices.list(session.id).map(n => n.body)).toContain('hello via http');

      // GET -> 405 (no SSE stream), DELETE -> 204.
      expect((await booted.app.inject({ method: 'GET', url: '/api/riffet-mcp/http', headers: auth })).statusCode).toBe(405);
      expect((await booted.app.inject({ method: 'DELETE', url: '/api/riffet-mcp/http', headers: auth })).statusCode).toBe(204);
    } finally {
      await booted.app.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('publishes http spec once listening and falls back to stdio when RIFFET_MCP_TRANSPORT=stdio', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'riffet-mcp-spec-'));
    const booted = await createApp({ stateDir, auth: true, token: 'test-owner-token' });
    const prev = process.env.RIFFET_MCP_TRANSPORT;
    try {
      const project = booted.store.createProject(stateDir, 'HTTP spec');
      const session = booted.store.createSession({ projectId: project.id, kind: 'native', backendId: 'claude', state: 'idle' });

      // Before listen, server URL is unknown -> stdio fallback.
      expect(booted.riffetMcp.server(session.id)?.http).toBeUndefined();

      await booted.app.listen({ host: '127.0.0.1', port: 0 });
      const spec = booted.riffetMcp.server(session.id)!;
      expect(spec.http?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/riffet-mcp\/http$/);
      expect(spec.http?.headers.Authorization).toMatch(/^Bearer wkm_/);

      process.env.RIFFET_MCP_TRANSPORT = 'stdio';
      expect(booted.riffetMcp.server(session.id)?.http).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.RIFFET_MCP_TRANSPORT;
      else process.env.RIFFET_MCP_TRANSPORT = prev;
      await booted.app.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
