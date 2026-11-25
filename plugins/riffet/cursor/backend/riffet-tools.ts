import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentHost, AgentRiffetMcpServer } from '@riffet/plugin-api/experimental/agent';

/*
 * Riffet's own tools for Cursor CLIs (docs/DEVICES.md §2).
 * When the server exposes a Streamable HTTP MCP endpoint (`server.http`), each conversation (or warm
 * provisional owner) gets a `0700` `cursor-plugin/` directory right next to its `0600` `credential.json`
 * so the Bearer header lives only in a `0600` `.mcp.json` file (never in `ps`/tmux args or process env)
 * and is cleaned up automatically when `RiffetMcpCredentials.revoke()` removes the credential folder.
 * When `server.http` is absent (e.g. `RIFFET_MCP_TRANSPORT=stdio`), falls back to the shared stdio
 * plugin directory with `RIFFET_MCP_CREDENTIAL_FILE` expanded from the CLI's environment (`${env:…}`).
 */

export const RIFFET_MCP_CREDENTIAL_ENV = 'RIFFET_MCP_CREDENTIAL_FILE';
/** The plugin's name, which Cursor puts in the namespace of the server's tools (`plugin-riffet-tools-riffet`). */
export const RIFFET_TOOLS_PLUGIN = 'riffet-tools';

/** What a launch adds for Riffet's tools: the plugin directory, and any per-session environment variables. */
export interface CursorToolsLaunch { args: string[]; env: Record<string, string> }

/** The shim's command line without its per-conversation `--credential <file>`. */
const sharedArgs = (server: AgentRiffetMcpServer) => server.args.filter((arg, index, all) => arg !== '--credential' && all[index - 1] !== '--credential');

const usesHttpTransport = (server: AgentRiffetMcpServer): server is AgentRiffetMcpServer & { http: { url: string; headers: Record<string, string> } } =>
  Boolean(server.http?.url && server.http.headers?.Authorization);

async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
}

/** Writes the shared stdio shim plugin; the same for every CLI of this server. */
export async function writeRiffetToolsPlugin(stateDir: string, server: AgentRiffetMcpServer): Promise<string> {
  const plugin = join(stateDir, 'cursor-hook', 'riffet-tools');
  await mkdir(join(plugin, '.cursor-plugin'), { recursive: true, mode: 0o700 });
  await writeAtomic(join(plugin, '.cursor-plugin/plugin.json'), JSON.stringify({ name: RIFFET_TOOLS_PLUGIN, version: '1.0.0' }));
  await writeAtomic(join(plugin, '.mcp.json'), `${JSON.stringify({
    mcpServers: { [server.name]: { command: server.command, args: sharedArgs(server), env: { [RIFFET_MCP_CREDENTIAL_ENV]: `\${env:${RIFFET_MCP_CREDENTIAL_ENV}}` } } },
  }, null, 2)}\n`);
  return plugin;
}

/** Writes a per-conversation `0700` Streamable HTTP plugin directory alongside `server.credentialFile`. */
export async function writeRiffetToolsHttpPlugin(server: AgentRiffetMcpServer & { http: { url: string; headers: Record<string, string> } }): Promise<string> {
  const plugin = join(dirname(server.credentialFile), 'cursor-plugin');
  await mkdir(join(plugin, '.cursor-plugin'), { recursive: true, mode: 0o700 });
  await writeAtomic(join(plugin, '.cursor-plugin/plugin.json'), JSON.stringify({ name: RIFFET_TOOLS_PLUGIN, version: '1.0.0' }));
  await writeAtomic(join(plugin, '.mcp.json'), `${JSON.stringify({
    mcpServers: { [server.name]: { url: server.http.url, headers: server.http.headers } },
  }, null, 2)}\n`);
  return plugin;
}

/** Riffet's tools for the CLIs one Cursor runtime starts. */
export class CursorRiffetTools {
  private written?: { key: string; plugin: Promise<string> };

  /** `supported` tells whether the CLI takes `--plugin-dir` (the hook plugin's probe); an older one gets no tools rather than failing to start. */
  constructor(private readonly host: AgentHost, private readonly stateDir: string, private readonly supported: () => Promise<boolean>) {}

  private plugin(server: AgentRiffetMcpServer): Promise<string> {
    const key = JSON.stringify([server.name, server.command, sharedArgs(server)]);
    if (this.written?.key !== key) {
      const plugin = writeRiffetToolsPlugin(this.stateDir, server);
      this.written = { key, plugin };
      plugin.catch(() => { if (this.written?.plugin === plugin) this.written = undefined; });
    }
    return this.written.plugin;
  }

  private async launch(server: AgentRiffetMcpServer): Promise<CursorToolsLaunch> {
    if (usesHttpTransport(server)) {
      return { args: ['--plugin-dir', await writeRiffetToolsHttpPlugin(server)], env: {} };
    }
    return { args: ['--plugin-dir', await this.plugin(server)], env: { [RIFFET_MCP_CREDENTIAL_ENV]: server.credentialFile } };
  }

  /** For a conversation's own CLI; undefined when it gets no tools (archived, a quick chat). */
  async forSession(sessionId: string): Promise<CursorToolsLaunch | undefined> {
    if (!await this.supported()) return undefined;
    const server = await this.host.riffetMcp(sessionId);
    return server ? await this.launch(server) : undefined;
  }

  /** For a warm CLI: the tools a new conversation in the project gets, bound to the one that takes it with `adopt`. */
  async provisional(projectId: string): Promise<(CursorToolsLaunch & { signature: string; adopt(sessionId: string): void; revoke(): void }) | undefined> {
    if (!await this.supported()) return undefined;
    const provisional = await this.host.riffetMcpProvisional?.(projectId);
    if (!provisional) return undefined;
    try {
      return { ...await this.launch(provisional.server), signature: provisional.signature, adopt: provisional.adopt, revoke: provisional.revoke };
    } catch (error) { provisional.revoke(); throw error; }
  }

  /** What a conversation's tool list is decided by; a warm CLI is taken only by one whose signature is its own. */
  async signature(sessionId: string): Promise<string | undefined> {
    return await this.supported() ? await this.host.riffetMcpSignature?.(sessionId) : undefined;
  }
}
