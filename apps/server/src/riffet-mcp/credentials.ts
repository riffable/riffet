import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../errors.js';
import type { Store } from '../store.js';

const TOKEN = /^wkm_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
/** One JSON map in the settings table: few rows, written by one process. */
const CREDENTIALS = 'riffet-mcp:credentials';
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/** Next to this module in the source tree and in `dist/`, where the build copies it. */
export const riffetMcpShimPath = path.resolve(moduleDir, 'riffet-mcp.mjs');

interface CredentialRow { hash: string; sessionId: string; createdAt: string }

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

/**
 * The credentials a conversation's Riffet MCP shim presents. Each is bound to one conversation and
 * kept only as a hash; the secret lives in a 0600 file under the state directory, which the shim is
 * told about on its command line — never the secret itself, never a prompt or a repository file.
 * The file also carries the server's address and is rewritten on every start, so a CLI that
 * outlives the server reaches the next one without being relaunched.
 */
export class RiffetMcpCredentials {
  private readonly root: string;
  private url?: string;

  constructor(private readonly store: Store, stateDir: string, private readonly nodePath = process.execPath) {
    this.root = path.join(stateDir, 'riffet-mcp');
  }

  private rows(): Record<string, CredentialRow> {
    return Object.assign(Object.create(null) as Record<string, CredentialRow>, this.store.getSetting<Record<string, CredentialRow>>(CREDENTIALS, {}));
  }

  private folder(sessionId: string): string {
    if (!/^[0-9A-Za-z._-]{1,200}$/.test(sessionId) || sessionId.startsWith('.')) throw new AppError('INVALID_SESSION_ID', 'Session id is invalid');
    return path.join(this.root, sessionId);
  }

  credentialFile(sessionId: string): string { return path.join(this.folder(sessionId), 'credential.json'); }

  /** Where the server listens. Files written from now on carry it, and existing ones are rewritten. */
  setUrl(url: string): void {
    this.url = url;
    for (const row of Object.values(this.rows())) {
      try {
        const saved = JSON.parse(readFileSync(this.credentialFile(row.sessionId), 'utf8')) as { credential?: unknown };
        if (typeof saved.credential === 'string') this.writeFile(row.sessionId, saved.credential);
      } catch { /* a missing file is reissued at the next launch */ }
    }
  }

  /** The conversation's credential file, issuing a credential when it has none on disk. */
  ensure(sessionId: string): string {
    const file = this.credentialFile(sessionId);
    const held = Object.values(this.rows()).some(row => row.sessionId === sessionId);
    if (held && existsSync(file)) return file;
    return this.issue(sessionId);
  }

  /** Replaces whatever the conversation held with a new credential. */
  issue(sessionId: string): string {
    const id = randomBytes(8).toString('hex'), secret = randomBytes(32).toString('base64url');
    const rows = Object.fromEntries(Object.entries(this.rows()).filter(([, row]) => row.sessionId !== sessionId));
    this.store.setSetting(CREDENTIALS, { ...rows, [id]: { hash: hashSecret(secret), sessionId, createdAt: new Date().toISOString() } });
    this.writeFile(sessionId, `wkm_${id}_${secret}`);
    return this.credentialFile(sessionId);
  }

  private writeFile(sessionId: string, credential: string): void {
    const folder = this.folder(sessionId);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = this.credentialFile(sessionId), temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ url: this.url, credential, sessionId })}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  /** The command line a CLI spawns for this conversation's Riffet MCP server. */
  command(sessionId: string): { command: string; args: string[] } {
    return { command: this.nodePath, args: [riffetMcpShimPath, '--credential', this.ensure(sessionId)] };
  }

  /** Revokes the conversation's credential and removes its file; a later launch with tool groups issues a new one. */
  revoke(sessionId: string): boolean {
    const rows = this.rows();
    const kept = Object.fromEntries(Object.entries(rows).filter(([, row]) => row.sessionId !== sessionId));
    const revoked = Object.keys(kept).length !== Object.keys(rows).length;
    if (revoked) this.store.setSetting(CREDENTIALS, kept);
    try { rmSync(this.folder(sessionId), { recursive: true, force: true }); } catch { /* nothing to remove */ }
    return revoked;
  }

  /** Revokes every credential whose conversation no longer has tools (deleted, archived, cleared). */
  prune(keep: (sessionId: string) => boolean): void {
    for (const sessionId of new Set(Object.values(this.rows()).map(row => row.sessionId))) if (!keep(sessionId)) this.revoke(sessionId);
  }

  /** The conversation behind a presented credential; anything else is one generic refusal. */
  authenticate(header: string | undefined): string {
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const match = token ? TOKEN.exec(token) : null;
    const row = match ? this.rows()[match[1]!] : undefined;
    const presented = match ? Buffer.from(hashSecret(match[2]!)) : undefined;
    if (!row || !presented || !timingSafeEqual(presented, Buffer.from(row.hash))) {
      throw new AppError('RIFFET_MCP_CREDENTIAL_INVALID', 'This Riffet tool credential is not valid', 401);
    }
    return row.sessionId;
  }
}
