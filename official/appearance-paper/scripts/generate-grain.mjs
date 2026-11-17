#!/usr/bin/env node
// Writes assets/paper-grain.png: a 256x256 greyscale+alpha paper grain that tiles seamlessly.
// Deterministic (a fixed seed, Node built-ins only), so running it again produces the same bytes.
//
//   node appearance-paper/scripts/generate-grain.mjs
//
// Each pixel is a dark or a light speck whose alpha follows the noise, so the grain reads on a
// light page and on a dark one. A faint low-frequency mottling is wrapped around the edges, which
// is what keeps the tile seamless.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, crc32, deflateSync } from 'node:zlib';

const SIZE = 256;
const CELL = 16;
const output = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/paper-grain.png');

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const next = random(0x70a9e2);

// Coarse lattice, interpolated with wrap-around, for the slow variation of a sheet.
const cells = SIZE / CELL;
const lattice = Array.from({ length: cells * cells }, () => next() * 2 - 1);
const smooth = (t) => t * t * (3 - 2 * t);
function mottling(x, y) {
  const gx = x / CELL, gy = y / CELL;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const tx = smooth(gx - x0), ty = smooth(gy - y0);
  const at = (i, j) => lattice[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)];
  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

const raw = Buffer.alloc((SIZE * 2 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 2 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    // The sum of four uniforms is close enough to a bell for grain.
    const grain = (next() + next() + next() + next() - 2) / 2;
    const signal = grain + mottling(x, y) * 0.2;
    const alpha = Math.min(255, Math.round(Math.abs(signal) ** 1.2 * 110));
    const at = y * (SIZE * 2 + 1) + 1 + x * 2;
    raw[at] = signal < 0 ? 24 : 232;
    raw[at + 1] = alpha;
  }
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const frame = Buffer.alloc(body.length + 8);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(crc32(body), frame.length - 4);
  return frame;
}
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header.set([8, 4, 0, 0, 0], 8);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: constants.Z_BEST_COMPRESSION })),
  chunk('IEND', Buffer.alloc(0)),
]);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, png);
console.log(`${output}: ${png.length} bytes`);
