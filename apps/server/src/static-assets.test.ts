import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, test, vi } from 'vitest';
import { WORKBENCH_APPEARANCE_BUDGET } from '../../../packages/contracts/src/budgets.js';
import { registerWebAssets, WorkbenchDocumentProofs } from './static-assets.js';
import { Store } from './store.js';

const navigation = { host: 'localhost:4317', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const proofMeta = /<meta name="riffet-workbench-proof" content="([^"]+)">/;

test('keeps one-use workbench proofs in top-level shell navigations, outside shared caches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'riffet-web-assets-'));
  const app = Fastify();
  const store = new Store(':memory:');
  const proofs = new WorkbenchDocumentProofs(store);
  try {
    const html = '<!doctype html><head><title>Riffet</title></head><body></body>';
    await writeFile(join(root, 'index.html'), html);
    await writeFile(join(root, 'preview.html'), html);
    registerWebAssets(app, root, proofs);

    const fetched = await app.inject({ url: '/index.html' });
    expect(fetched.body).toBe(html);
    expect(fetched.headers.etag).toBeDefined();
    const framed = await app.inject({ url: '/c/existing-session', headers: { ...navigation, 'sec-fetch-dest': 'iframe' } });
    const preview = await app.inject({ url: '/preview.html', headers: navigation });
    const insecure = await app.inject({ url: '/', headers: { ...navigation, host: 'dev.example:4317' } });
    for (const other of [framed, preview, insecure]) expect(other.body).toBe(html);

    const request = { url: '/c/existing-session', headers: { ...navigation, 'if-none-match': fetched.headers.etag! } };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(first.headers.etag).toBeUndefined();
    const firstProof = proofMeta.exec(first.body)?.[1];
    const secondProof = proofMeta.exec(second.body)?.[1];
    expect(firstProof).not.toBe(secondProof);
    expect(proofs.consume(firstProof)).toBe(true);
    expect(proofs.consume(firstProof)).toBe(false);
    expect(proofs.consume(secondProof)).toBe(true);
    const throughTlsProxy = await app.inject({ url: '/', headers: { ...navigation, host: 'dev.example:443', 'x-forwarded-proto': 'https' } });
    expect(proofs.consume(proofMeta.exec(throughTlsProxy.body)?.[1])).toBe(true);
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('development renderer can receive a proof only through the loopback navigation endpoint', async () => {
  const app = Fastify();
  const store = new Store(':memory:');
  const proofs = new WorkbenchDocumentProofs(store);
  try {
    registerWebAssets(app, undefined, proofs);
    const url = '/__riffet/workbench-document-proof';
    expect((await app.inject({ url })).statusCode).toBe(404);
    expect((await app.inject({ url, headers: navigation, remoteAddress: '192.0.2.30' })).statusCode).toBe(404);
    const response = await app.inject({ url, headers: navigation });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(proofs.consume(response.headers['x-riffet-workbench-document-proof'])).toBe(true);
  } finally {
    await app.close();
    store.close();
  }
});

test('keeps an unexpired document proof through a restart and allows a single redemption across stores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'riffet-workbench-proofs-'));
  const path = join(root, 'workbench.db');
  const stores: Store[] = [];
  const open = () => {
    const store = new Store(path);
    stores.push(store);
    return new WorkbenchDocumentProofs(store);
  };
  try {
    const proof = open().issue();
    stores.pop()!.close();
    const restarted = open();
    const other = open();
    expect(restarted.consume(proof)).toBe(true);
    expect(other.consume(proof)).toBe(false);
  } finally {
    for (const store of stores) store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('expires old workbench proofs and retains at most the configured number of recent proofs', () => {
  const store = new Store(':memory:');
  const proofs = new WorkbenchDocumentProofs(store);
  const clock = vi.spyOn(Date, 'now');
  try {
    const expired = proofs.issue();
    clock.mockReturnValue(Date.now() + WORKBENCH_APPEARANCE_BUDGET.documentProofMs);
    expect(proofs.consume(expired)).toBe(false);
    const oldest = proofs.issue();
    const retained = Array.from({ length: WORKBENCH_APPEARANCE_BUDGET.documentProofs }, () => proofs.issue());
    expect(proofs.consume(oldest)).toBe(false);
    expect(retained.every(proof => proofs.consume(proof))).toBe(true);
  } finally {
    clock.mockRestore();
    store.close();
  }
});
