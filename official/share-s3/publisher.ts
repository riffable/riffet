import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ShareCapability } from '@riffet/contracts';
import type { PluginHost, PublishedPreview, SharePublisher, ShareIdentity } from '@riffet/plugin-api';
import { ALIAS, type ShareS3Config, readConfig } from './config.js';
import { S3Client, S3Error } from './s3.js';

const UPLOAD_CONCURRENCY = 6;
const MAX_FILES = 5000;
const SWEEP_INTERVAL_MS = 60 * 60_000;
const SWEEP_LIMIT = 50;
const PROBE_TTL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm', '.map': 'application/json; charset=utf-8',
};
export const contentType = (file: string): string => TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
const cacheControl = (key: string): string => (/\.html?$|share-manifest\.json$/.test(key) ? 'no-cache' : 'public, max-age=3600');

/** The record kept next to each share's files; `find`, `verify` and expiry read it. */
interface ShareMeta { format: 'riffet-share-s3-v1'; alias: string; hash: string; publishedAt: string; expiresAt: string; username: string; profile?: string }

const isMeta = (value: unknown): value is ShareMeta => typeof value === 'object' && value !== null
  && (value as ShareMeta).format === 'riffet-share-s3-v1' && typeof (value as ShareMeta).hash === 'string' && Number.isFinite(Date.parse((value as ShareMeta).expiresAt));

async function listFiles(root: string): Promise<Array<{ key: string; file: string; size: number }>> {
  const files: Array<{ key: string; file: string; size: number }> = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, `${prefix}${entry.name}/`);
      else if (entry.isFile()) {
        if (files.length >= MAX_FILES) throw new Error('The share package has too many files');
        files.push({ key: `${prefix}${entry.name}`, file: path, size: (await stat(path)).size });
      }
    }
  };
  await walk(root, '');
  return files;
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

async function pool<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => { while (next < items.length) await run(items[next++]!); };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, items.length) }, worker));
}

/**
 * A share is the objects under `<prefix>/<alias>/` plus one record at `<prefix>/.meta/<alias>.json`.
 * The record is written first and removed last, so an interrupted publish or removal stays findable.
 */
export class S3SharePublisher implements SharePublisher {
  readonly label = 'S3';
  readonly audience = 'Anyone with the link';
  private probe?: { key: string; at: number; value: ShareCapability };
  private sweptAt = 0;
  private sweeping = false;
  /** Where the next sweep continues, so every record is reached over successive sweeps. */
  private sweepAfter?: string;

  constructor(private readonly host: Pick<PluginHost, 'settings' | 'secrets' | 'error' | 'logger'>) {}

  private read(): { config: ShareS3Config } | { problem: string } {
    return readConfig(this.host.settings(), this.host.secrets.get('secretAccessKey'));
  }

  private configured(): ShareS3Config {
    const value = this.read();
    if ('problem' in value) throw this.host.error('SHARE_PLATFORM_UNAVAILABLE', value.problem, 400);
    return value.config;
  }

  private dir(config: ShareS3Config, alias: string): string {
    if (!ALIAS.test(alias)) throw this.host.error('INVALID_SHARE_ALIAS', 'The share address is invalid');
    return `${config.keyPrefix}${alias}/`;
  }

  private metaKey(config: ShareS3Config, alias: string): string { return `${config.keyPrefix}.meta/${alias}.json`; }

  private identity(config: ShareS3Config): ShareIdentity { return { username: config.bucket, profile: config.endpoint.host }; }

  private pageUrl(config: ShareS3Config, alias: string): string { return `${config.publicBase}/${config.keyPrefix}${alias}/index.html`; }

  publicUrl(alias: string): string {
    const config = this.configured();
    this.dir(config, alias);
    return this.pageUrl(config, alias);
  }

  /** Maps a store failure to a code the host localizes. */
  private failure(error: unknown): Error {
    if (error instanceof S3Error) {
      if (['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'InvalidToken'].includes(error.code) || error.status === 401) return this.host.error('SHARE_LOGIN_REQUIRED', 'The storage rejected the access key', 401);
      if (error.status === 403) return this.host.error('SHARE_PERMISSION_DENIED', 'The access key cannot use this bucket', 403);
      this.host.logger?.warn(`S3 ${error.status} ${error.code}`);
    } else if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string' && (error as { code: string }).code.startsWith('SHARE_')) return error;
    else this.host.logger?.warn(`S3 request failed: ${error instanceof Error ? error.message : String(error)}`);
    return this.host.error('SHARE_PLATFORM_UNAVAILABLE', 'The storage did not respond; check the endpoint and network', 400);
  }

  async capability(options?: { fresh?: boolean }): Promise<ShareCapability> {
    const value = this.read();
    if ('problem' in value) return { available: false, reason: 'unavailable', message: value.problem };
    const { config } = value;
    const key = JSON.stringify([config.endpoint.href, config.region, config.bucket, config.pathStyle, config.accessKeyId, config.keyPrefix, config.publicBase, this.host.secrets.get('secretAccessKey')]);
    // A status read stays local while a recent probe for the same settings exists.
    const stale = !this.probe || this.probe.key !== key || Date.now() - this.probe.at > PROBE_TTL_MS;
    if (options?.fresh || stale) this.probe = { key, at: Date.now(), value: await this.check(config) };
    const result = this.probe?.value ?? { available: false };
    if (result.available) void this.sweep(config);
    return { ...result, ...(result.available ? this.identity(config) : {}) };
  }

  private async check(config: ShareS3Config): Promise<ShareCapability> {
    try {
      await new S3Client(config).list(`${config.keyPrefix}.meta/`, 1);
      return { available: true };
    } catch (error) {
      const own = this.failure(error) as Error & { statusCode?: number; code?: string };
      const reason = own.code === 'SHARE_LOGIN_REQUIRED' ? 'login_required' : own.code === 'SHARE_PERMISSION_DENIED' ? 'permission_denied' : 'unavailable';
      return { available: false, reason, message: own.message };
    }
  }

  private async readMeta(client: S3Client, config: ShareS3Config, alias: string): Promise<ShareMeta | undefined> {
    const body = await client.get(this.metaKey(config, alias));
    if (!body) return undefined;
    try { const value: unknown = JSON.parse(body.toString('utf8')); return isMeta(value) ? value : undefined; } catch { return undefined; }
  }

  private async purge(client: S3Client, config: ShareS3Config, alias: string): Promise<void> {
    const keys = await client.list(this.dir(config, alias));
    await pool(keys, key => client.delete(key));
    await client.delete(this.metaKey(config, alias));
  }

  private preview(config: ShareS3Config, meta: ShareMeta): PublishedPreview {
    return { id: meta.alias, url: this.pageUrl(config, meta.alias), expiresAt: meta.expiresAt };
  }

  async deploy(directory: string, alias: string, expiryDays: number, identity: ShareIdentity, override: boolean): Promise<PublishedPreview> {
    const config = this.configured();
    const prefix = this.dir(config, alias);
    const client = new S3Client(config);
    try {
      const manifest: unknown = JSON.parse(await readFile(join(directory, 'share-manifest.json'), 'utf8'));
      const hash = typeof manifest === 'object' && manifest !== null ? (manifest as { hash?: unknown }).hash : undefined;
      if (typeof hash !== 'string' || !hash) throw new Error('The share package has no content hash');
      const files = await listFiles(directory);
      const existing = await this.readMeta(client, config, alias);
      const live = existing && Date.parse(existing.expiresAt) > Date.now();
      const stale = await client.list(prefix);
      if (!override && (live || (!existing && stale.length))) throw this.host.error('SHARE_ALIAS_EXISTS', 'The share address already exists; check the publish status', 409);
      const now = Date.now();
      const meta: ShareMeta = { format: 'riffet-share-s3-v1', alias, hash, publishedAt: new Date(now).toISOString(), expiresAt: new Date(now + expiryDays * DAY_MS).toISOString(), username: identity.username, ...(identity.profile ? { profile: identity.profile } : {}) };
      await client.put(this.metaKey(config, alias), Buffer.from(JSON.stringify(meta)), 'application/json');
      // The entry page goes last, so a reader never sees it before the files it loads.
      const entries = files.filter(item => item.key !== 'index.html');
      const index = files.filter(item => item.key === 'index.html');
      const upload = async (item: { key: string; file: string; size: number }) => {
        const key = `${prefix}${item.key}`;
        await client.put(key, { file: item.file, size: item.size, sha256: await hashFile(item.file) }, contentType(item.file), cacheControl(key));
      };
      await pool(entries, upload);
      await pool(index, upload);
      const keep = new Set(files.map(item => `${prefix}${item.key}`));
      await pool(stale.filter(key => !keep.has(key)), key => client.delete(key));
      return this.preview(config, meta);
    } catch (error) { throw this.failure(error); }
  }

  async find(alias: string, _identity: ShareIdentity): Promise<PublishedPreview | undefined> {
    const config = this.configured();
    this.dir(config, alias);
    const client = new S3Client(config);
    try {
      const meta = await this.readMeta(client, config, alias);
      if (!meta) return undefined;
      if (Date.parse(meta.expiresAt) <= Date.now()) {
        await this.purge(client, config, alias).catch(() => undefined);
        return undefined;
      }
      return this.preview(config, meta);
    } catch (error) { throw this.failure(error); }
  }

  async remove(previewId: string, _identity: ShareIdentity): Promise<void> {
    const config = this.configured();
    this.dir(config, previewId);
    try { await this.purge(new S3Client(config), config, previewId); } catch (error) { throw this.failure(error); }
  }

  async verify(alias: string, hash: string): Promise<boolean> {
    try {
      const config = this.configured();
      const meta = await this.readMeta(new S3Client(config), config, alias);
      if (!meta || meta.hash !== hash || Date.parse(meta.expiresAt) <= Date.now()) return false;
      const url = `${config.publicBase}/${config.keyPrefix}${alias}/share-manifest.json?revision=${encodeURIComponent(hash)}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
      if (!response.ok || Number(response.headers.get('content-length')) > 4096) return false;
      const text = await response.text();
      return text.length <= 4096 && (JSON.parse(text) as { hash?: unknown }).hash === hash;
    } catch { return false; }
  }

  /** Riffet does not remove expired shares itself: this deletes the ones past `expiresAt`, at most hourly and in small batches. */
  private async sweep(config: ShareS3Config): Promise<void> {
    if (this.sweeping || Date.now() - this.sweptAt < SWEEP_INTERVAL_MS) return;
    this.sweeping = true;
    this.sweptAt = Date.now();
    try {
      const client = new S3Client(config);
      const keys = await client.list(`${config.keyPrefix}.meta/`, SWEEP_LIMIT * 4, this.sweepAfter);
      let removed = 0;
      let last: string | undefined;
      for (const key of keys) {
        if (removed >= SWEEP_LIMIT) break;
        last = key;
        const alias = key.endsWith('.json') ? key.slice(key.lastIndexOf('/') + 1, -'.json'.length) : '';
        if (!ALIAS.test(alias)) continue;
        const meta = await this.readMeta(client, config, alias);
        if (meta && Date.parse(meta.expiresAt) <= Date.now()) { await this.purge(client, config, alias); removed++; }
      }
      // The end of the records starts the next sweep from the beginning again.
      this.sweepAfter = keys.length < SWEEP_LIMIT * 4 && last === keys.at(-1) ? undefined : last;
    } catch (error) { this.host.logger?.warn(`Expired share cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { this.sweeping = false; }
  }

  /** For the settings page: checks the connection and that a page can be written and removed. */
  async test(): Promise<string> {
    const config = this.configured();
    const client = new S3Client(config);
    const key = `${config.keyPrefix}.meta/probe-${Date.now()}.tmp`;
    try {
      await client.put(key, Buffer.from('ok'), 'text/plain');
      await client.delete(key);
    } catch (error) { throw this.failure(error); }
    this.probe = undefined;
    return 'ok';
  }
}
