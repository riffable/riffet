type Attrs = Record<string, string | number>;
type Node = [tag: string, attrs: Attrs];

/** At most three decimals, no trailing zeros, no "-0". */
export function num(value: number): string {
  const text = String(Math.round(value * 1000) / 1000);
  return text === '-0' ? '0' : text;
}

function attr(attrs: Attrs, name: string, fallback?: number): number {
  const raw = attrs[name];
  if (raw === undefined) {
    if (fallback === undefined) throw new Error(`Missing attribute "${name}"`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Attribute "${name}" is not a number: ${raw}`);
  return value;
}

function ellipse(cx: number, cy: number, rx: number, ry: number): string {
  return `M${num(cx - rx)} ${num(cy)}A${num(rx)} ${num(ry)} 0 1 0 ${num(cx + rx)} ${num(cy)}A${num(rx)} ${num(ry)} 0 1 0 ${num(cx - rx)} ${num(cy)}Z`;
}

function rect(attrs: Attrs): string {
  const x = attr(attrs, 'x', 0);
  const y = attr(attrs, 'y', 0);
  const w = attr(attrs, 'width');
  const h = attr(attrs, 'height');
  // SVG: a lone rx or ry applies to both, and each is clamped to half the side.
  const hasRx = attrs.rx !== undefined;
  const hasRy = attrs.ry !== undefined;
  const rx = Math.min(hasRx ? attr(attrs, 'rx') : hasRy ? attr(attrs, 'ry') : 0, w / 2);
  const ry = Math.min(hasRy ? attr(attrs, 'ry') : hasRx ? attr(attrs, 'rx') : 0, h / 2);
  if (rx === 0 || ry === 0) return `M${num(x)} ${num(y)}H${num(x + w)}V${num(y + h)}H${num(x)}Z`;
  const arc = (ex: number, ey: number) => `A${num(rx)} ${num(ry)} 0 0 1 ${num(ex)} ${num(ey)}`;
  return `M${num(x + rx)} ${num(y)}H${num(x + w - rx)}${arc(x + w, y + ry)}V${num(y + h - ry)}${arc(x + w - rx, y + h)}`
    + `H${num(x + rx)}${arc(x, y + h - ry)}V${num(y + ry)}${arc(x + rx, y)}Z`;
}

function points(raw: string | number | undefined, close: boolean): string {
  const values = String(raw ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (values.length < 4 || values.length % 2 !== 0 || values.some((value) => !Number.isFinite(value))) throw new Error(`Bad points: ${raw}`);
  let d = '';
  for (let i = 0; i < values.length; i += 2) d += `${i === 0 ? 'M' : 'L'}${num(values[i]!)} ${num(values[i + 1]!)}`;
  return close ? `${d}Z` : d;
}

/** Which parameters of each absolute command are y coordinates (relative commands and H carry none). */
const Y_PARAMS: Record<string, { size: number; ys: number[] }> = {
  M: { size: 2, ys: [1] }, L: { size: 2, ys: [1] }, T: { size: 2, ys: [1] }, V: { size: 1, ys: [0] },
  C: { size: 6, ys: [1, 3, 5] }, S: { size: 4, ys: [1, 3] }, Q: { size: 4, ys: [1, 3] }, A: { size: 7, ys: [6] },
};

/** Moves path data down by [dy] without wrapping it in a group, so the result stays one flat path. */
export function translateY(d: string, dy: number): string {
  let out = '';
  let i = 0;
  let command = '';
  let index = 0;
  const number = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
  while (i < d.length) {
    const char = d[i]!;
    if (/[\s,]/.test(char)) { i++; continue; }
    if (/[a-zA-Z]/.test(char)) {
      command = char;
      index = 0;
      out += char;
      i++;
      continue;
    }
    const upper = command.toUpperCase();
    const spec = Y_PARAMS[upper];
    const size = spec?.size ?? 1;
    const slot = index % size;
    // An arc's two flags are single digits and may be written without separators ("a1 1 0 011 1").
    const flag = upper === 'A' && (slot === 3 || slot === 4);
    const match = flag ? /^[01]/.exec(d.slice(i)) : number.exec(d.slice(i));
    if (!match) throw new Error(`Bad path data at ${i}: ${d}`);
    const value = Number(match[0]);
    const shifted = command === upper && spec?.ys.includes(slot) ? value + dy : value;
    out += `${out && !/[a-zA-Z]$/.test(out) ? ' ' : ''}${flag ? match[0] : num(shifted)}`;
    i += match[0].length;
    index++;
  }
  return out;
}

export function toPath([tag, attrs]: Node): string {
  switch (tag) {
    // A leading relative move would resolve from the previous element's end once the elements are
    // joined into one path; anchoring it at the origin keeps it where Lucide drew it.
    case 'path': { const d = String(attrs.d); return /^\s*m/.test(d) ? `M0 0${d}` : d; }
    case 'circle': return ellipse(attr(attrs, 'cx', 0), attr(attrs, 'cy', 0), attr(attrs, 'r'), attr(attrs, 'r'));
    case 'ellipse': return ellipse(attr(attrs, 'cx', 0), attr(attrs, 'cy', 0), attr(attrs, 'rx'), attr(attrs, 'ry'));
    case 'rect': return rect(attrs);
    case 'line': return `M${num(attr(attrs, 'x1'))} ${num(attr(attrs, 'y1'))}L${num(attr(attrs, 'x2'))} ${num(attr(attrs, 'y2'))}`;
    case 'polyline': return points(attrs.points, false);
    case 'polygon': return points(attrs.points, true);
    default: throw new Error(`Unsupported SVG element <${tag}>`);
  }
}
