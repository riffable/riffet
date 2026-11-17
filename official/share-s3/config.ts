import type { S3Config } from './s3.js';

export type Settings = Readonly<Record<string, string | undefined>>;

export interface ShareS3Config extends S3Config {
  /** Key prefix with a trailing slash, or empty. */
  keyPrefix: string;
  /** Where the bucket's root is served from, without a trailing slash. */
  publicBase: string;
}

export const ALIAS = /^riffet-[a-f0-9]{32}$/;

function loopback(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function webUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback(url.hostname))) return url;
  } catch { /* invalid */ }
  return undefined;
}

/** The configuration the settings describe, or the first thing wrong with them. Pure: no I/O. */
export function readConfig(settings: Settings, secret: string | undefined): { config: ShareS3Config } | { problem: string } {
  const text = (key: string) => (settings[key] ?? '').trim();
  const endpoint = text('endpoint');
  const region = text('region');
  const bucket = text('bucket');
  const accessKeyId = text('accessKeyId');
  const publicBase = text('publicBaseUrl');
  if (!endpoint || !region || !bucket || !accessKeyId || !secret || !publicBase) return { problem: 'Set the endpoint, region, bucket, public address, access key ID and secret access key' };
  const endpointUrl = webUrl(endpoint);
  if (!endpointUrl) return { problem: 'The endpoint must be an https address (http only for localhost)' };
  const publicUrl = webUrl(publicBase);
  if (!publicUrl) return { problem: 'The public address must be an https address (http only for localhost)' };
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return { problem: 'The bucket name is invalid' };
  if (!/^[a-z0-9-]{2,32}$/i.test(region)) return { problem: 'The region is invalid' };
  const prefix = text('prefix').replace(/^\/+|\/+$/g, '');
  // Kept to characters a URL path carries as they are, so the public address of a page is the key itself.
  if (prefix && (!/^[A-Za-z0-9._/-]+$/.test(prefix) || prefix.split('/').some(part => part === '' || part === '.' || part === '..'))) return { problem: 'The key prefix may use only letters, digits, and . _ - /' };
  const pathStyle = text('addressing') !== 'virtual';
  return { config: {
    endpoint: endpointUrl, region, bucket, pathStyle, accessKeyId, secretAccessKey: secret,
    keyPrefix: prefix ? `${prefix}/` : '', publicBase: publicUrl.href.replace(/\/+$/, ''),
  } };
}
