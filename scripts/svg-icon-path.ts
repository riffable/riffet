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
