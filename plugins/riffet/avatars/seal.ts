// 印章: the first character of the owner's name, cut as a seal. The seed decides 朱文 or 白文, a square or a
// round frame, a slight tilt, how worn the edge is and whether the ink is the theme's or a muted cinnabar.

import { createHash } from 'node:crypto';
import type { AvatarStyleProvider } from '@riffet/plugin-api';

const FONT = 'Songti SC, STSong, Noto Serif CJK SC, Source Han Serif SC, serif';
const CINNABAR = '#9e3b2f';
/** The same hue lifted, for a dark paper where the muted red would sink into it. */
const CINNABAR_ON_DARK = '#cf7565';

/** Deterministic: the same seed always gives the same sequence in [0, 1). */
function random(seed: string): () => number {
  let state = createHash('sha256').update(`seal\0${seed}`).digest().readUInt32BE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const escapeXml = (text: string): string => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);
const firstGrapheme = (name: string): string => new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name.trim())[Symbol.iterator]().next().value?.segment ?? '';
const luminance = (color: string): number => {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const round = (value: number): number => Math.round(value * 100) / 100;

export const sealProvider: AvatarStyleProvider = {
  generate({ seed, size, ink, paper, name }) {
    const character = firstGrapheme(name ?? '');
    if (!character) throw new Error('the seal needs a name');
    const next = random(seed);
    const carved = next() < 0.5; // 白文: paper-colored character on a solid block; otherwise 朱文
    const circle = next() < 0.4;
    const tilt = round((next() - 0.5) * 8);
    const color = next() < 0.5 ? ink : luminance(paper) < 0.4 ? CINNABAR_ON_DARK : CINNABAR;

    const frame = circle
      ? (extra: string) => `<circle cx="50" cy="50" r="${carved ? 37 : 35.5}" ${extra}/>`
      : (extra: string) => `<rect x="${carved ? 13 : 14.5}" y="${carved ? 13 : 14.5}" width="${carved ? 74 : 71}" height="${carved ? 74 : 71}" rx="2.5" ${extra}/>`;
    const fontSize = circle ? (carved ? 46 : 42) : (carved ? 52 : 46);

    // Wear: specks of paper along the border and a few over the character, so the print looks pressed and used.
    const specks: string[] = [];
    const reach = circle ? 36 : 36.5;
    for (let index = 0, count = 10 + Math.floor(next() * 8); index < count; index++) {
      const onEdge = index < count * 0.65;
      let x: number;
      let y: number;
      if (onEdge) {
        const angle = next() * Math.PI * 2;
        const radius = reach + (next() - 0.5) * 3;
        // A square's border sits at the same distance along the axes; scale the direction out to it.
        const scale = circle ? 1 : 1 / Math.max(Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle)));
        x = 50 + Math.cos(angle) * radius * scale;
        y = 50 + Math.sin(angle) * radius * scale;
      } else {
        x = 22 + next() * 56;
        y = 22 + next() * 56;
      }
      const rx = onEdge ? 0.5 + next() * 2.4 : 0.3 + next() * 0.9;
      const ry = onEdge ? 0.4 + next() * 1.1 : 0.3 + next() * 0.9;
      specks.push(`<ellipse cx="${round(x)}" cy="${round(y)}" rx="${round(rx)}" ry="${round(ry)}" transform="rotate(${Math.round(next() * 180)} ${round(x)} ${round(y)})"/>`);
    }

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">`,
      `<rect width="100" height="100" fill="${paper}"/>`,
      `<defs><clipPath id="seal-frame">${frame('')}</clipPath></defs>`,
      `<g transform="rotate(${tilt} 50 50)">`,
      carved ? frame(`fill="${color}"`) : frame(`fill="none" stroke="${color}" stroke-width="3.6"`),
      `<text x="50" y="${round(50 + fontSize * 0.36)}" text-anchor="middle" font-family="${FONT}" font-size="${fontSize}" font-weight="700" fill="${carved ? paper : color}">${escapeXml(character)}</text>`,
      `<g clip-path="url(#seal-frame)" fill="${paper}">${specks.join('')}</g>`,
      '</g>',
      '</svg>',
    ].join('');
  },
};
