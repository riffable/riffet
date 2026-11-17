import { describe, expect, it } from 'vitest';
import { EMPTY_SHA256, sign } from './s3.js';

// Published examples from "Signature Calculations for the Authorization Header" (Amazon S3 API Reference).
const base = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z') };

describe('SigV4 signer', () => {
  it('signs a GET with a Range header', () => {
    const header = sign({ ...base, method: 'GET', path: '/test.txt', payloadHash: EMPTY_SHA256,
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': '20130524T000000Z' } });
    expect(header).toContain('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('signs a bucket list with a sorted query', () => {
    const header = sign({ ...base, method: 'GET', path: '/', query: { 'max-keys': '2', prefix: 'J' }, payloadHash: EMPTY_SHA256,
      headers: { host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': '20130524T000000Z' } });
    expect(header).toContain('Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });
});
