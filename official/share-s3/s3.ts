// A minimal S3 client: AWS Signature Version 4 over `node:http(s)`, for the few calls a share needs.
// Bodies stream from disk with an explicit Content-Length (S3-compatible stores reject chunked uploads).

import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream';

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface S3Config {
  endpoint: URL;
  region: string;
  bucket: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

const hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 percent-encoding as SigV4 defines it: only unreserved characters stay. */
export function encodeUri(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function encodeKey(key: string): string {
  return key.split('/').map(encodeUri).join('/');
}

export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface SignInput {
  method: string;
  /** Already percent-encoded, starting with `/`. */
  path: string;
  query?: Record<string, string>;
  /** Every header given here is signed; names are case-insensitive. Must include `host`. */
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  date: Date;
  service?: string;
}

/** The `Authorization` header value. */
export function sign(input: SignInput): string {
  const service = input.service ?? 's3';
  const stamp = amzDate(input.date);
  const day = stamp.slice(0, 8);
  const headers = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signed = headers.map(([name]) => name).join(';');
  const query = Object.entries(input.query ?? {}).map(([k, v]) => [encodeUri(k), encodeUri(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [input.method, input.path, query, headers.map(([k, v]) => `${k}:${v}\n`).join(''), signed, input.payloadHash].join('\n');
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), service), 'aws4_request');
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${createHmac('sha256', key).update(toSign).digest('hex')}`;
}

export class S3Error extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface S3Response { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

export interface S3Body { file: string; size: number; sha256: string }

const MAX_BODY = 8 * 1024 * 1024;

function xmlText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? unescapeXml(match[1]!) : undefined;
}

export function unescapeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity[0] === '#') return String.fromCodePoint(entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity]!;
  });
}

export class S3Client {
  constructor(private readonly config: S3Config) {}

  private target(key: string): { host: string; path: string } {
    const endpoint = this.config.endpoint;
    const base = endpoint.pathname.replace(/\/+$/, '');
    if (this.config.pathStyle) return { host: endpoint.host, path: `${base}/${encodeUri(this.config.bucket)}${key ? `/${encodeKey(key)}` : '/'}` };
    return { host: `${this.config.bucket}.${endpoint.host}`, path: `${base}/${encodeKey(key)}` };
  }

  /** One signed request. Rejects with `S3Error` for a non-2xx status, unless listed in `allow`. */
  async send(method: string, key: string, options: { query?: Record<string, string>; body?: Buffer | S3Body; headers?: Record<string, string>; timeoutMs?: number; allow?: number[] } = {}): Promise<S3Response> {
    const { host, path } = this.target(key);
    const body = options.body;
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : undefined;
    const file = body !== undefined && !Buffer.isBuffer(body) ? body : undefined;
    const length = payload ? payload.length : file?.size;
    const payloadHash = payload ? hex(payload) : file ? file.sha256 : EMPTY_SHA256;
    const date = new Date();
    const signedHeaders: Record<string, string> = { ...options.headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(date) };
    const authorization = sign({
      method, path, ...(options.query ? { query: options.query } : {}), headers: signedHeaders, payloadHash, region: this.config.region, date,
      accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey,
    });
    // Content-Length is sent but not signed: the body fixes it, and some proxies rewrite it.
    const headers = { ...signedHeaders, authorization, ...(length !== undefined ? { 'content-length': String(length) } : {}) };
    const search = options.query ? `?${Object.entries(options.query).map(([k, v]) => `${encodeUri(k)}=${encodeUri(v)}`).join('&')}` : '';
    const transport = this.config.endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const response = await new Promise<S3Response>((resolve, reject) => {
      const req = transport({
        method, host: this.config.endpoint.hostname, ...(this.config.endpoint.port ? { port: Number(this.config.endpoint.port) } : {}),
        // A file upload is bounded by idle time only (`timeout`): a large file on a slow uplink is not a stall.
        path: path + search, headers, ...(file ? {} : { signal: AbortSignal.timeout(timeoutMs) }), timeout: timeoutMs,
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY) { req.destroy(new Error('Response too large')); return; }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Request timed out')));
      req.on('error', reject);
      if (payload) req.end(payload);
      else if (file) pipeline(createReadStream(file.file), req, error => { if (error) req.destroy(error); });
      else req.end();
    });
    if (response.status >= 200 && response.status < 300) return response;
    if (options.allow?.includes(response.status)) return response;
    const text = response.body.toString('utf8');
    throw new S3Error(response.status, xmlText(text, 'Code') ?? String(response.status), xmlText(text, 'Message') ?? `HTTP ${response.status}`);
  }

  async get(key: string): Promise<Buffer | undefined> {
    const response = await this.send('GET', key, { allow: [404] });
    return response.status === 404 ? undefined : response.body;
  }

  async put(key: string, body: Buffer | S3Body, contentType: string, cacheControl?: string): Promise<void> {
    await this.send('PUT', key, { body, headers: { 'content-type': contentType, ...(cacheControl ? { 'cache-control': cacheControl } : {}) }, timeoutMs: 120_000 });
  }

  async delete(key: string): Promise<void> {
    await this.send('DELETE', key, { allow: [404] });
  }

  /** Every key under `prefix` (after `startAfter`, when given), following continuation tokens up to `limit`. */
  async list(prefix: string, limit = 10_000, startAfter?: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const response = await this.send('GET', '', { query: { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : startAfter ? { 'start-after': startAfter } : {}) } });
      const xml = response.body.toString('utf8');
      for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) keys.push(unescapeXml(match[1]!));
      token = xmlText(xml, 'IsTruncated') === 'true' ? xmlText(xml, 'NextContinuationToken') : undefined;
    } while (token && keys.length < limit);
    return keys.slice(0, limit);
  }
}
