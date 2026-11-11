/** Portable monochrome vectors, shared by bundled families and plugin appearance assets. */
export interface IconPath { d: string; fill?: boolean; strokeWidth?: number; lineCap?: 'round' | 'butt' | 'square'; lineJoin?: 'round' | 'miter' | 'bevel'; fillRule?: 'nonzero' | 'evenodd' }
export interface IconGlyph { width: number; height: number; paths: IconPath[] }
export interface IconPackDocument { version: 1; icons: Record<string, IconGlyph> }
export const APPEARANCE_MAX_ICON_PACK_BYTES = 1024 * 1024;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown, min: number, max: number): boolean => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** No URLs, SVG markup, transforms or executable content; bounded geometry only. Unknown glyph keys allow newer clients. */
export function iconPackProblem(value: unknown): string | undefined {
  if (!record(value) || value.version !== 1 || !record(value.icons)) return 'expected a version 1 icon pack';
  const icons = Object.entries(value.icons);
  if (!icons.length || icons.length > 256) return 'expected 1 to 256 icons';
  for (const [name, glyph] of icons) {
    if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(name) || !record(glyph)) return 'invalid icon name or glyph';
    if (!finite(glyph.width, 1, 1024) || !finite(glyph.height, 1, 1024)) return `${name}: invalid viewport`;
    if (!Array.isArray(glyph.paths) || !glyph.paths.length || glyph.paths.length > 32) return `${name}: expected 1 to 32 paths`;
    for (const path of glyph.paths) {
      if (!record(path) || typeof path.d !== 'string' || !path.d.length || path.d.length > 16384 || !/^[Mm]/.test(path.d) || /[^MmLlHhVvCcSsQqTtAaZz0-9eE.,+\s-]/.test(path.d)) return `${name}: invalid path data`;
      if ((path.d.match(/[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/g) ?? []).some(n => !finite(Number(n), -10000, 10000))) return `${name}: invalid coordinate`;
      if (path.fill !== undefined && typeof path.fill !== 'boolean') return `${name}: invalid fill`;
      if (path.strokeWidth !== undefined && !finite(path.strokeWidth, 0, 64)) return `${name}: invalid stroke`;
      if (path.lineCap !== undefined && !['round', 'butt', 'square'].includes(path.lineCap as string)) return `${name}: invalid cap`;
      if (path.lineJoin !== undefined && !['round', 'miter', 'bevel'].includes(path.lineJoin as string)) return `${name}: invalid join`;
      if (path.fillRule !== undefined && !['nonzero', 'evenodd'].includes(path.fillRule as string)) return `${name}: invalid fill rule`;
    }
  }
  return undefined;
}
