import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentHost, AgentRiffetMcpServer } from '@riffet/plugin-api/experimental/agent';

/*
 * Riffet's own tools for Cursor CLIs (docs/DEVICES.md §2). Cursor takes MCP servers per process only from a plugin
 * directory, and every CLI is given the same one, so the server cannot carry a conversation's credential on its command
 * line as Claude's and Codex's do. The plugin's `.mcp.json` starts the shim with `RIFFET_MCP_CREDENTIAL_FILE` taken
 * from the CLI's own environment (`${env:…}`, expanded by Cursor when it loads the plugin); each CLI is launched with the
 * file of its conversation, or of the provisional credential a warm CLI holds until a conversation adopts it.
 * Cursor passes a stdio server only HOME, LOGNAME, PATH, SHELL, TERM and USER of its own environment, so the
 * variable has to be named in the server's `env`.
 */

export const RIFFET_MCP_CREDENTIAL_ENV = 'RIFFET_MCP_CREDENTIAL_FILE';
/** The plugin's name, which Cursor puts in the namespace of the server's tools (`plugin-riffet-tools-riffet`). */
export const RIFFET_TOOLS_PLUGIN = 'riffet-tools';

/** What a launch adds for Riffet's tools: the plugin directory, and the credential file in the CLI's environment. */
export interface CursorToolsLaunch { args: string[]; env: Record<string, string> }

/** The shim's command line without its per-conversation `--credential <file>`. */
const sharedArgs = (server: AgentRiffetMcpServer) => server.args.filter((arg, index, all) => arg !== '--credential' && all[index - 1] !== '--credential');

async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
}

/** Writes the plugin that runs the shim; the same for every CLI of this server. */
export async function writeRiffetToolsPlugin(stateDir: string, server: AgentRiffetMcpServer): Promise<string> {
  const plugin = join(stateDir, 'cursor-hook', 'riffet-tools');
  await mkdir(join(plugin, '.cursor-plugin'), { recursive: true, mode: 0o700 });
  await writeAtomic(join(plugin, '.cursor-plugin/plugin.json'), JSON.stringify({ name: RIFFET_TOOLS_PLUGIN, version: '1.0.0' }));
  await writeAtomic(join(plugin, '.mcp.json'), `${JSON.stringify({
    mcpServers: { [server.name]: { command: server.command, args: sharedArgs(server), env: { [RIFFET_MCP_CREDENTIAL_ENV]: `\${env:${RIFFET_MCP_CREDENTIAL_ENV}}` } } },
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
