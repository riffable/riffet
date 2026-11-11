import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import { CLIENT_FEATURES_HEADER } from '../../../../packages/contracts/src/index.js';

export function sequence(value: unknown) { const n=Number(Array.isArray(value)?value[0]:value??0);return Number.isSafeInteger(n)&&n>=0?n:0; }
export function pageSize(value:unknown){if(value===undefined)return 100;const n=Number(value);if(!Number.isInteger(n)||n<1||n>200)throw new AppError('INVALID_PAGE_SIZE','Page size must be 1–200');return n;}
export function tags(value:unknown):string[]{if(!Array.isArray(value)||value.length>20||value.some(t=>typeof t!=='string'||t.length>60))throw new AppError('INVALID_TAGS','Use at most 20 short text tags');return [...new Set(value.map(t=>String(t).trim()).filter(Boolean))];}
export function paths(value:unknown):string[]{if(!Array.isArray(value)||!value.length||value.length>500||value.some(p=>typeof p!=='string'))throw new AppError('INVALID_PATHS','Select between 1 and 500 file paths');return value as string[];}

/**
 * Serves a list under a weak ETag made from the store's list revision: a client whose
 * `If-None-Match` still matches gets a bodiless 304 and skips the read as well as the transfer.
 */
export function revisionedList<T>(request: FastifyRequest, reply: FastifyReply, revision: number, read: () => T): T | FastifyReply {
  const etag = `W/"${revision}"`;
  reply.header('ETag', etag).header('Cache-Control', 'no-cache').header('Vary', CLIENT_FEATURES_HEADER);
  const match = request.headers['if-none-match'];
  if (match !== undefined && match.split(',').some(candidate => candidate.trim() === etag)) return reply.code(304).send();
  return read();
}
