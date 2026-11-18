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

/** `folder` is where its file lives when that is not the conversation's own: a credential issued ahead of it (`provisional`). */
interface CredentialRow { hash: string; sessionId: string; createdAt: string; folder?: string }

/** The owner a provisional credential has until a conversation adopts it; no conversation has such an id. */
const PROVISIONAL = 'provisional-';
export const isProvisionalOwner = (owner: string): boolean => owner.startsWith(PROVISIONAL);

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

  credentialFile(sessionId: string): string { return path.join(this.folder(this.rowOf(sessionId)?.folder ?? sessionId), 'credential.json'); }

  private rowOf(sessionId: string): CredentialRow | undefined { return Object.values(this.rows()).find(row => row.sessionId === sessionId); }

  /** Where the server listens. Files written from now on carry it, and existing ones are rewritten. */
  setUrl(url: string): void {
    this.url = url;
    for (const row of Object.values(this.rows())) {
      try {
        const saved = JSON.parse(readFileSync(this.credentialFile(row.sessionId), 'utf8')) as { credential?: unknown };
        if (typeof saved.credential === 'string') this.writeFile(row.sessionId, saved.credential, row.folder);
      } catch { /* a missing file is reissued at the next launch */ }
    }
  }

  /** The conversation's credential file, issuing a credential when it has none on disk. */
  ensure(sessionId: string): string {
    const file = this.credentialFile(sessionId);
    if (this.rowOf(sessionId) && existsSync(file)) return file;
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

  /**
   * A credential for a CLI started before its conversation exists (a warm one, `WarmPool`): it opens
   * nothing until `adopt` gives it to the conversation that takes the CLI, and `revoke(owner)` ends it.
   * Its file stays where the CLI was told, so adopting needs no relaunch.
   */
  provisional(): { owner: string; command: string; args: string[] } {
    const owner = `${PROVISIONAL}${randomBytes(8).toString('hex')}`;
    const id = randomBytes(8).toString('hex'), secret = randomBytes(32).toString('base64url');
    this.store.setSetting(CREDENTIALS, { ...this.rows(), [id]: { hash: hashSecret(secret), sessionId: owner, createdAt: new Date().toISOString(), folder: owner } });
    this.writeFile(owner, `wkm_${id}_${secret}`, owner);
    return { owner, command: this.nodePath, args: [riffetMcpShimPath, '--credential', this.credentialFile(owner)] };
  }

  /** Gives a provisional credential to `sessionId`, which must hold none of its own. */
  adopt(owner: string, sessionId: string): void {
    this.folder(sessionId);
    const rows = this.rows();
    const entry = Object.entries(rows).find(([, row]) => row.sessionId === owner);
    if (!entry || !isProvisionalOwner(owner)) throw new AppError('RIFFET_MCP_CREDENTIAL_INVALID', 'This Riffet tool credential is not valid', 401);
    const [id, row] = entry;
    const kept = Object.fromEntries(Object.entries(rows).filter(([, other]) => other.sessionId !== sessionId));
    this.store.setSetting(CREDENTIALS, { ...kept, [id]: { ...row, sessionId } });
    try {
      const saved = JSON.parse(readFileSync(path.join(this.folder(row.folder ?? owner), 'credential.json'), 'utf8')) as { credential?: unknown };
      if (typeof saved.credential === 'string') this.writeFile(sessionId, saved.credential, row.folder);
    } catch { /* the shim reads the credential, not the conversation id, from it */ }
  }

  private writeFile(sessionId: string, credential: string, folderName = sessionId): void {
    const folder = this.folder(folderName);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, 'credential.json'), temporary = `${file}.${process.pid}.tmp`;
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
    const folders = new Set([sessionId, ...Object.values(rows).filter(row => row.sessionId === sessionId && row.folder).map(row => row.folder!)]);
    const kept = Object.fromEntries(Object.entries(rows).filter(([, row]) => row.sessionId !== sessionId));
    const revoked = Object.keys(kept).length !== Object.keys(rows).length;
    if (revoked) this.store.setSetting(CREDENTIALS, kept);
    for (const folder of folders) { try { rmSync(this.folder(folder), { recursive: true, force: true }); } catch { /* nothing to remove */ } }
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
