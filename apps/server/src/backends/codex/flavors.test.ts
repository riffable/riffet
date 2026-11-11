import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexFlavor, readProbe, traexFlavor } from './flavors.js';
import { supportsSteerVersion } from './config.js';
import type { ModelSourceProvider, ResolvedSource } from '@riffet/plugin-api';
import { provideModelSources } from '../shared/model-source.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); provideModelSources(() => []); });

/** A source as a plugin provides it: whatever it resolves to is all the driver sees. */
function source(id: string, resolve: ModelSourceProvider['resolve'], served: Pick<ModelSourceProvider, 'protocols' | 'backends'> = { backends: ['codex'] }): ModelSourceProvider {
  return { id, label: id, ...served, resolve, catalog: async () => [] };
}

const traexApp = 'Usage: traecli app-server [OPTIONS]\n--listen <URL>  `stdio://` (default), `unix://`, `unix://PATH`, `ws://IP:PORT`, `off`\n--ws-auth <MODE>\n--ws-token-file <PATH>';
const traexResume = 'Usage: traecli resume [OPTIONS]\n--remote <ADDR>\n  Accepted forms: `ws://host:port` or `wss://host:port`.\n--remote-auth-token-env <ENV_VAR>';
const codexApp = 'Usage: codex app-server [OPTIONS]\n--listen <URL>  `stdio://`, `unix://`, `unix://PATH`';
const codexResume = 'Usage: codex resume\n--remote <ADDR>\n  Accepted forms: `ws://host:port`, `wss://host:port`, `unix://`, or `unix://PATH`.\n--no-alt-screen';

describe('app-server flavors', () => {
  it('passes a source static key to Codex privately, at the Responses base the source resolved', () => {
    provideModelSources(() => [source('acme-gateway', overrides => ({ codexBaseUrl: `${overrides.apiEndpoint}/v1`, credential: { kind: 'static', key: overrides.apiKey ?? 'source-key' } }))]);
    const config = { modelSource: 'acme-gateway', apiEndpoint: 'https://region.example', apiKey: 'profile-only-key' };
    const args = codexFlavor.args(config);
    expect(args).toContain('model_providers.riffet.base_url="https://region.example/v1"');
    expect(args).toContain('model_providers.riffet.env_key="RIFFET_CODEX_API_KEY"');
    expect(args.join(' ')).not.toContain('profile-only-key');
    expect(args.some(arg => arg.includes('supports_websockets') || arg.includes('env_http_headers'))).toBe(false);
    expect(codexFlavor.env(config)).toEqual({ RIFFET_CODEX_API_KEY: 'profile-only-key' });
    expect(codexFlavor.env({ modelSource: 'acme-gateway', apiEndpoint: 'https://region.example' })).toEqual({ RIFFET_CODEX_API_KEY: 'source-key' });
  });

  it('runs a source command credential with its headers, without mixing in a static key', () => {
    const resolved: ResolvedSource = {
      codexBaseUrl: 'https://cli-proxy.example/v2',
      credential: { kind: 'command', command: '/usr/local/bin/acme', args: ['auth', 'token'] },
      headers: { claude: { 'X-Acme-X-Client': 'claude-code' }, codex: { 'X-Acme-X-Client': 'codex', 'Acme Route': 'b', 'hook-url': 'https://source.example/hook' } },
      disableWebsockets: true,
    };
    provideModelSources(() => [source('acme-cli', () => resolved)]);
    const config = { modelSource: 'acme-cli', apiKey: 'unused-old-key', configDir: '/tmp/codex-home' };
    expect(codexFlavor.args(config)).toEqual([
      '-c', 'model_provider="riffet"',
      '-c', 'model_providers.riffet.name="Riffet"',
      '-c', 'model_providers.riffet.base_url="https://cli-proxy.example/v2"',
      '-c', 'model_providers.riffet.wire_api="responses"',
      '-c', 'model_providers.riffet.auth.command="/usr/local/bin/acme"',
      '-c', 'model_providers.riffet.auth.args=["auth","token"]',
      '-c', 'model_providers.riffet.supports_websockets=false',
      '-c', 'model_providers.riffet.env_http_headers.X-Acme-X-Client="RIFFET_SOURCE_HEADER_X_ACME_X_CLIENT"',
      '-c', 'model_providers.riffet.env_http_headers."Acme Route"="RIFFET_SOURCE_HEADER_ACME_ROUTE"',
      '-c', 'model_providers.riffet.env_http_headers.hook-url="RIFFET_SOURCE_HEADER_HOOK_URL"',
      '-c', 'model_providers.riffet.requires_openai_auth=false',
    ]);
    const env = codexFlavor.env(config);
    expect(env).toEqual({ CODEX_HOME: '/tmp/codex-home', RIFFET_SOURCE_HEADER_X_ACME_X_CLIENT: 'codex', RIFFET_SOURCE_HEADER_ACME_ROUTE: 'b', RIFFET_SOURCE_HEADER_HOOK_URL: 'https://source.example/hook' });
    // A header name a source picks never lands on a variable Riffet itself sets (`hook-url` is not `RIFFET_HOOK_URL`).
    expect(Object.keys(env).filter(name => name.startsWith('RIFFET_') && !name.startsWith('RIFFET_SOURCE_HEADER_'))).toEqual([]);
  });

  it('launches a source that declares protocols and endpoints exactly as one that declares the older members', () => {
    const credential = { kind: 'static', key: 'k' } as const;
    const older: ResolvedSource = { codexBaseUrl: 'https://gw.example/v1', credential, headers: { codex: { 'X-Gw-Client': 'codex' } }, disableWebsockets: true };
    const declared: ResolvedSource = { endpoints: { 'openai-responses': { baseUrl: 'https://gw.example/v1', headers: { 'X-Gw-Client': 'codex' } } }, credential, disableWebsockets: true };
    const config = { modelSource: 'gw', configDir: '/tmp/codex-home' };
    provideModelSources(() => [source('gw', () => older)]);
    const before = { args: codexFlavor.args(config), env: codexFlavor.env(config) };
    provideModelSources(() => [source('gw', () => declared, { protocols: ['openai-responses'] })]);
    expect({ args: codexFlavor.args(config), env: codexFlavor.env(config) }).toEqual(before);
    expect(before.env).toEqual({ CODEX_HOME: '/tmp/codex-home', RIFFET_CODEX_API_KEY: 'k', RIFFET_SOURCE_HEADER_X_GW_CLIENT: 'codex' });
    // A source that serves only Anthropic Messages gives Codex no address.
    provideModelSources(() => [source('gw', () => ({ endpoints: { 'anthropic-messages': { baseUrl: 'https://gw.example' } }, credential }), { protocols: ['anthropic-messages'] })]);
    expect(codexFlavor.args(config)).toEqual([]);
  });

  it('shares a TRAE CLI TUI only over an authenticated WebSocket', () => {
    const probe = readProbe('traecli 0.210.1\ninstallation: npm\n', traexApp, traexResume);
    expect(probe).toMatchObject({ version: 'traecli 0.210.1', appServer: true, unixSocket: true, wsAuth: true, remoteUnix: false, remoteWs: true });
    expect(supportsSteerVersion(probe.version, 'traex')).toBe(true);
    expect(supportsSteerVersion('riffet/0.210.1 (Mac OS 26.4.0; arm64) tmux/3.6b (riffet; 0.1.0)', 'traex')).toBe(true);
    expect(supportsSteerVersion('traecli 0.210.0', 'traex')).toBe(false);
    expect(supportsSteerVersion('traecli 0.210.1-alpha.1', 'traex')).toBe(false);
    expect(supportsSteerVersion(undefined, 'traex')).toBe(false);
    expect(traexFlavor.unavailableReason(probe, 'traex')).toBeUndefined();
    expect(traexFlavor.terminalTransport(probe)).toBe('ws');
    expect(probe.noAltScreen).toBe(false);
    expect(traexFlavor.terminalTransport({ ...probe, wsAuth: false })).toBe('none');
  });

  it('keeps Codex on its Unix socket', () => {
    const probe = readProbe('codex-cli 0.160.0', codexApp, codexResume);
    expect(supportsSteerVersion(probe.version)).toBe(true);
    expect(codexFlavor.unavailableReason(probe, 'codex')).toBeUndefined();
    expect(codexFlavor.terminalTransport(probe)).toBe('unix');
    expect(probe.noAltScreen).toBe(true);
    expect(codexFlavor.unavailableReason({ ...probe, remoteUnix: false }, 'codex')).toContain('does not support attaching');
  });

  it('finds TRAE CLI sessions under the cli directory of its home, not under CODEX_HOME', () => {
    const saved = { TRAECLI_HOME: process.env.TRAECLI_HOME, TRAE_HOME: process.env.TRAE_HOME };
    delete process.env.TRAECLI_HOME;
    delete process.env.TRAE_HOME;
    try {
      expect(traexFlavor.stateHome({ configDir: '/tmp/trae-home' })).toBe('/tmp/trae-home/cli');
      expect(traexFlavor.env({ configDir: '/tmp/trae-home' })).toEqual({ TRAE_HOME: '/tmp/trae-home' });
      process.env.TRAECLI_HOME = '/tmp/trae-state';
      expect(traexFlavor.stateHome({ configDir: '/tmp/trae-home' })).toBe('/tmp/trae-state');
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
});
