import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generates the agent (backend) marks for web, Android and the Swift apps from the vendors' own
 * logo files in `scripts/agent-marks/` (see that directory's README for provenance and the usage
 * rules). Hand-copying path data per platform would drift the moment a logo is refreshed, so the
 * SVGs are parsed here — arcs and source group transforms included — normalised onto one 24-unit
 * grid (each mark fitted by its own bounding box to the same 22-unit optical box, so the set reads
 * as one family), and emitted in each platform's native form. Outputs are committed; `--check`
 * lets CI fail when they are stale.
 *
 * Rendering contract on every platform: Codex keeps its shipped lavender-to-blue gradient with
 * the terminal prompt knocked out (one even-odd path); pi keeps the three colours of its shipped
 * mark; the rest render monochrome and take their colour from the call site (web `--agent-*` /
 * palette agent roles / an explicit colour).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const srcDir = resolve(root, 'scripts/agent-marks');

// MARK: - SVG path parsing (M/L/H/V/C/A/Z, absolute + relative, packed arc flags)

type Op =
  | { k: 'M' | 'L'; x: number; y: number }
  | { k: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { k: 'Z' };

const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/y;

function arcToCubics(x1: number, y1: number, rx0: number, ry0: number, phiDeg: number, large: number, sweep: number, x2: number, y2: number): Op[] {
  if (rx0 === 0 || ry0 === 0) return [{ k: 'L', x: x2, y: y2 }];
  let rx = rx0; let ry = ry0;
  const phi = ((phiDeg % 360) * Math.PI) / 180;
  const cosf = Math.cos(phi); const sinf = Math.sin(phi);
  const dx = (x1 - x2) / 2; const dy = (y1 - y2) / 2;
  const x1p = cosf * dx + sinf * dy; const y1p = -sinf * dx + cosf * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = Math.sqrt(Math.max(0, num / den)) * (large === sweep ? -1 : 1);
  const cxp = (co * rx * y1p) / ry; const cyp = (-co * ry * x1p) / rx;
  const cx = cosf * cxp - sinf * cyp + (x1 + x2) / 2;
  const cy = sinf * cxp + cosf * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)))));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const ux = (x1p - cxp) / rx; const uy = (y1p - cyp) / ry;
  const th1 = ang(1, 0, ux, uy);
  let dth = ang(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry) % (2 * Math.PI);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  if (sweep && dth < 0) dth += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)));
  const point = (t: number): [number, number] => [
    cx + rx * Math.cos(t) * cosf - ry * Math.sin(t) * sinf,
    cy + rx * Math.cos(t) * sinf + ry * Math.sin(t) * cosf,
  ];
  const deriv = (t: number): [number, number] => [
    -rx * Math.sin(t) * cosf - ry * Math.cos(t) * sinf,
    -rx * Math.sin(t) * sinf + ry * Math.cos(t) * cosf,
  ];
  const ops: Op[] = [];
  for (let s = 0; s < segs; s += 1) {
    const t1 = th1 + (dth * s) / segs; const t2 = th1 + (dth * (s + 1)) / segs;
    const k = (4 / 3) * Math.tan((t2 - t1) / 4);
    const [ax, ay] = point(t1); const [bx, by] = point(t2);
    const [d1x, d1y] = deriv(t1); const [d2x, d2y] = deriv(t2);
    ops.push({ k: 'C', x1: ax + k * d1x, y1: ay + k * d1y, x2: bx - k * d2x, y2: by - k * d2y, x: bx, y: by });
  }
  return ops;
}

function parsePath(d: string, group: [number, number]): Op[] {
  const ops: Op[] = [];
  let i = 0; let cmd: string | null = null;
  let cur: [number, number] = [...group]; let start: [number, number] = [...group];
  const skip = () => { while (i < d.length && /[\s,]/.test(d[i]!)) i += 1; };
  const num = () => { skip(); NUM.lastIndex = i; const m = NUM.exec(d); if (!m) throw new Error(`number expected at ${i} in ${d.slice(0, 40)}`); i = NUM.lastIndex; return parseFloat(m[0]); };
  const flag = () => { skip(); const v = d[i] === '1' ? 1 : 0; i += 1; return v; };
  for (;;) {
    skip();
    if (i >= d.length) break;
    if (/[A-Za-z]/.test(d[i]!)) {
      cmd = d[i]!; i += 1;
      if (cmd === 'Z' || cmd === 'z') { ops.push({ k: 'Z' }); cur = [...start]; continue; }
    }
    const c: string = cmd!;
    if (c === 'M' || c === 'm') {
      let x = num(); let y = num();
      if (c === 'm') { x += cur[0]; y += cur[1]; }
      cur = [x, y]; start = [x, y]; ops.push({ k: 'M', x, y });
      cmd = c === 'M' ? 'L' : 'l';
    } else if (c === 'L' || c === 'l') {
      let x = num(); let y = num();
      if (c === 'l') { x += cur[0]; y += cur[1]; }
      cur = [x, y]; ops.push({ k: 'L', x, y });
    } else if (c === 'H' || c === 'h') {
      let x = num();
      if (c === 'h') x += cur[0];
      cur = [x, cur[1]]; ops.push({ k: 'L', x, y: cur[1] });
    } else if (c === 'V' || c === 'v') {
      let y = num();
      if (c === 'v') y += cur[1];
      cur = [cur[0], y]; ops.push({ k: 'L', x: cur[0], y });
    } else if (c === 'C' || c === 'c') {
      let x1 = num(); let y1 = num(); let x2 = num(); let y2 = num(); let x = num(); let y = num();
      if (c === 'c') { x1 += cur[0]; y1 += cur[1]; x2 += cur[0]; y2 += cur[1]; x += cur[0]; y += cur[1]; }
      ops.push({ k: 'C', x1, y1, x2, y2, x, y }); cur = [x, y];
    } else if (c === 'A' || c === 'a') {
      const rx = num(); const ry = num(); const rot = num(); const large = flag(); const sweep = flag();
      let x = num(); let y = num();
      if (c === 'a') { x += cur[0]; y += cur[1]; }
      ops.push(...arcToCubics(cur[0], cur[1], rx, ry, rot, large, sweep, x, y));
      cur = [x, y];
    } else {
      throw new Error(`unsupported path command ${c}`);
    }
  }
  return ops;
}

function sourcePaths(file: string): Op[][] {
  const svg = readFileSync(resolve(srcDir, file), 'utf8');
  const g = /<g transform="translate\(([\d.]+)[ ,]+([\d.]+)\)">/.exec(svg);
  const group: [number, number] = g ? [parseFloat(g[1]!), parseFloat(g[2]!)] : [0, 0];
  return [...svg.matchAll(/<path[^>]*\bd="([^"]+)"/g)].map((m) => parsePath(m[1]!, group));
}

/** Split a compound path into its subpaths (one per M). */
function subpaths(ops: Op[]): Op[][] {
  const out: Op[][] = [];
  for (const op of ops) {
    if (op.k === 'M' || out.length === 0) out.push([]);
    out[out.length - 1]!.push(op);
  }
  return out;
}

// MARK: - Normalisation onto the shared 24-unit grid

function normalize(paths: Op[][], fit = 22, canvas = 24): Op[][] {
  const pts: [number, number][] = [];
  for (const p of paths) for (const op of p) {
    if (op.k === 'M' || op.k === 'L') pts.push([op.x, op.y]);
    else if (op.k === 'C') pts.push([op.x1, op.y1], [op.x2, op.y2], [op.x, op.y]);
  }
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs); const x1 = Math.max(...xs); const y0 = Math.min(...ys); const y1 = Math.max(...ys);
  const s = fit / Math.max(x1 - x0, y1 - y0);
  const ox = (canvas - (x1 - x0) * s) / 2 - x0 * s;
  const oy = (canvas - (y1 - y0) * s) / 2 - y0 * s;
  const X = (v: number) => Math.round((v * s + ox) * 100) / 100;
  const Y = (v: number) => Math.round((v * s + oy) * 100) / 100;
  return paths.map((p) => p.map((op): Op => {
    if (op.k === 'Z') return op;
    if (op.k === 'C') return { k: 'C', x1: X(op.x1), y1: Y(op.y1), x2: X(op.x2), y2: Y(op.y2), x: X(op.x), y: Y(op.y) };
    return { k: op.k, x: X(op.x), y: Y(op.y) };
  }));
}

function toD(ops: Op[]): string {
  return ops.map((op) => {
    if (op.k === 'Z') return 'Z';
    if (op.k === 'C') return `C${op.x1} ${op.y1} ${op.x2} ${op.y2} ${op.x} ${op.y}`;
    return `${op.k}${op.x} ${op.y}`;
  }).join('');
}

// MARK: - The catalogue

interface MarkDef {
  /** Backend id used in contracts (`traex`, not the vendor's spelling). */
  id: string;
  file: string;
  rule: 'nonzero' | 'evenodd';
  gradient?: boolean;
  /** Shipped colours, one per source path, for marks whose geometry is meaningless in one ink. */
  colors?: readonly string[];
}

const MARKS: MarkDef[] = [
  { id: 'cursor', file: 'cursor.svg', rule: 'nonzero' },
  { id: 'codex', file: 'codex.svg', rule: 'evenodd', gradient: true },
  { id: 'claude', file: 'claude.svg', rule: 'nonzero' },
  { id: 'dsh', file: 'dsh.svg', rule: 'evenodd' },
  { id: 'droid', file: 'droid.svg', rule: 'nonzero' },
  { id: 'traex', file: 'trae.svg', rule: 'evenodd' },
  { id: 'pi', file: 'pi.svg', rule: 'nonzero', colors: ['#F09082', '#4D9ABF', '#F1BE58'] },
];

const CODEX_GRADIENT = ['#B1A7FF', '#7A9DFF', '#3941FF'] as const;

interface Prepared { def: MarkDef; paths: Op[][] }

function prepare(def: MarkDef): Prepared {
  const raw = sourcePaths(def.file);
  if (def.gradient) {
    // Codex: [underscore, chevron, cloud(outer+inner)]. The shipped mark is the outer cloud
    // filled with the gradient and the prompt knocked out: outer + prompt as one even-odd path.
    const cloud = subpaths(raw[2]!);
    const combined = [...cloud[0]!, ...raw[1]!, ...raw[0]!];
    return { def, paths: normalize([combined]) };
  }
  return { def, paths: normalize(raw) };
}

const prepared = MARKS.map(prepare);
const byId = (id: string) => prepared.find((p) => p.def.id === id)!;

// MARK: - Web (React component with inline SVG)

function emitWeb(): string {
  const entries = prepared.map(({ def, paths }) => {
    const list = paths.map((ops, idx) => {
      const fill = def.colors?.[idx];
      return `{ d: '${toD(ops)}', evenOdd: ${def.rule === 'evenodd'}${fill ? `, fill: '${fill}'` : ''} }`;
    }).join(', ');
    return `  ${def.id}: [${list}],`;
  }).join('\n');
  return `// Generated by scripts/gen-agent-marks.ts from scripts/agent-marks/*.svg. Do not edit by hand:
// refresh the source logo there and re-run \`pnpm gen:marks\`. The marks belong to their owners
// and only identify a backend; Codex keeps its shipped gradient, pi its shipped colours, and the
// rest take \`currentColor\`.
import { useId, type CSSProperties } from 'react';

export type AgentMarkBackend = 'cursor' | 'codex' | 'claude' | 'dsh' | 'droid' | 'traex' | 'pi';

const PATHS: Record<AgentMarkBackend, readonly { d: string; evenOdd: boolean; fill?: string }[]> = {
${entries}
};

const ALIASES: Record<string, AgentMarkBackend> = { trae: 'traex', deepseek: 'dsh' };

export function AgentMark({ backend, size = 14, className, style }: {
  backend: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const gradientId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const id = ALIASES[backend] ?? (backend as AgentMarkBackend);
  const paths = PATHS[id];
  if (!paths) return null;
  if (id === 'codex') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style} aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="${CODEX_GRADIENT[0]}" />
            <stop offset="0.55" stopColor="${CODEX_GRADIENT[1]}" />
            <stop offset="1" stopColor="${CODEX_GRADIENT[2]}" />
          </linearGradient>
        </defs>
        <path d={paths[0]!.d} fill={\`url(#\${gradientId})\`} fillRule="evenodd" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} style={style} aria-hidden="true" focusable="false">
      {paths.map((path) => (
        <path key={path.d} d={path.d} fill={path.fill} fillRule={path.evenOdd ? 'evenodd' : 'nonzero'} />
      ))}
    </svg>
  );
}
`;
}

// MARK: - Android (Compose ImageVector)

function emitKotlin(): string {
  const vals = prepared.map(({ def, paths }) => {
    const name = `Agent${def.id[0]!.toUpperCase()}${def.id.slice(1)}`;
    const gradientFill = `Brush.verticalGradient(listOf(${CODEX_GRADIENT.map((c) => `Color(0xFF${c.slice(1)})`).join(', ')}))`;
    const pathCalls = paths.map((ops, idx) => {
      const fill = def.colors?.[idx] ? `SolidColor(Color(0xFF${def.colors[idx]!.slice(1)}))` : def.gradient ? gradientFill : 'SolidColor(Color.Black)';
      return `        .addPath(pathData = addPathNodes("${toD(ops)}"), fill = ${fill}${def.rule === 'evenodd' ? ', pathFillType = PathFillType.EvenOdd' : ''})`;
    }).join('\n');
    return `    /** ${def.id} — traced from scripts/agent-marks/${def.file}. */
    val ${name}: ImageVector = ImageVector.Builder("Riffet${name}", 24.dp, 24.dp, 24f, 24f)
${pathCalls}
        .build()`;
  }).join('\n\n');
  const cases = prepared.map(({ def }) => `        "${def.id}" -> ${`Agent${def.id[0]!.toUpperCase()}${def.id.slice(1)}`}`).join('\n');
  return `// Generated by scripts/gen-agent-marks.ts from scripts/agent-marks/*.svg. Do not edit by hand:
// refresh the source logo there and re-run \`pnpm gen:marks\`. The marks belong to their owners
// and only identify a backend; Codex keeps its shipped gradient, pi its shipped colours, and the
// rest are filled black so the call site's tint recolours them like every other RiffetIcons glyph.
package riffet.ui.icons

import androidx.compose.foundation.layout.size
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

object AgentMarks {
${vals}

    fun vector(backendId: String): ImageVector? = when (backendId.lowercase()) {
${cases}
        "trae" -> AgentTraex
        "deepseek" -> AgentDsh
        "chat" -> RiffetIcons.Message
        else -> null
    }
}

/** A backend's mark at [size]. [tint] recolours the monochrome marks; Codex and pi keep their own. */
@Composable
fun AgentMark(backendId: String, size: Dp = 16.dp, tint: Color = LocalContentColor.current) {
    val vector = AgentMarks.vector(backendId) ?: return
    Icon(
        imageVector = vector,
        contentDescription = null,
        modifier = Modifier.size(size),
        tint = if (backendId.lowercase() == "codex" || backendId.lowercase() == "pi") Color.Unspecified else tint,
    )
}
`;
}

// MARK: - Swift (SwiftUI Canvas paths; shared by the macOS and iOS apps)

function swiftPath(ops: Op[], indent: string, finalReturn: string): string {
  const lines = [`${indent}var path = Path()`];
  for (const op of ops) {
    if (op.k === 'Z') lines.push(`${indent}path.closeSubpath()`);
    else if (op.k === 'C') lines.push(`${indent}path.addCurve(to: CGPoint(x: ${op.x}, y: ${op.y}), control1: CGPoint(x: ${op.x1}, y: ${op.y1}), control2: CGPoint(x: ${op.x2}, y: ${op.y2}))`);
    else if (op.k === 'M') lines.push(`${indent}path.move(to: CGPoint(x: ${op.x}, y: ${op.y}))`);
    else lines.push(`${indent}path.addLine(to: CGPoint(x: ${op.x}, y: ${op.y}))`);
  }
  lines.push(`${indent}${finalReturn}`);
  return lines.join('\n');
}

function emitSwift(): string {
  const funcs = prepared.map(({ def, paths }) => {
    if (paths.length === 1) {
      return `    private static var ${def.id}: [Path] {
${swiftPath(paths[0]!, '        ', 'return [path]')}
    }`;
    }
    const builders = paths.map((ops, idx) => `        let p${idx} = {
${swiftPath(ops, '            ', 'return path')}
        }()`).join('\n');
    return `    private static var ${def.id}: [Path] {
${builders}
        return [${paths.map((_, idx) => `p${idx}`).join(', ')}]
    }`;
  }).join('\n\n');
  const cases = prepared.map(({ def }) => `        case "${def.id}": ${def.id}`).join('\n');
  const swiftColor = (hex: string) => `Color(red: ${parseInt(hex.slice(1, 3), 16) / 255}, green: ${parseInt(hex.slice(3, 5), 16) / 255}, blue: ${parseInt(hex.slice(5, 7), 16) / 255})`;
  const colorCases = prepared.filter(({ def }) => def.colors).map(({ def }) =>
    `        case "${def.id}": [${def.colors!.map(swiftColor).join(', ')}]`).join('\n');
  return `// Generated by scripts/gen-agent-marks.ts from scripts/agent-marks/*.svg. Do not edit by hand:
// refresh the source logo there and re-run \`pnpm gen:marks\`. The marks belong to their owners
// and only identify a backend; Codex keeps its shipped gradient, pi its shipped colours, and the
// rest take the caller's colour (or the brand fallback below).
import SwiftUI

enum AgentMarkGlyphs {
    static func paths(for backend: String) -> [Path] {
        switch backend.lowercased() {
${cases}
        case "trae": traex
        case "deepseek": dsh
        default: []
        }
    }

    static func isGradient(for backend: String) -> Bool { backend.lowercased() == "codex" }

    static func colors(for backend: String) -> [Color]? {
        switch backend.lowercased() {
${colorCases}
        default: nil
        }
    }

${funcs}
}

/// A backend's mark, drawn on the shared 24-unit grid at the given size. Pass a color to recolour the
/// monochrome marks (e.g. with the palette's agent role); Codex and pi keep their own colours.
struct AgentMarkView: View {
    let backend: String
    var size: CGFloat = 16
    var color: Color? = nil

    var body: some View {
        Canvas { context, canvasSize in
            let scale = canvasSize.width / 24
            context.transform = CGAffineTransform(scaleX: scale, y: scale)
            let paths = AgentMarkGlyphs.paths(for: backend)
            if AgentMarkGlyphs.isGradient(for: backend), let cloud = paths.first {
                let gradient = GraphicsContext.Shading.linearGradient(
                    Gradient(colors: [${CODEX_GRADIENT.map((c) => `Color(red: ${parseInt(c.slice(1, 3), 16) / 255}, green: ${parseInt(c.slice(3, 5), 16) / 255}, blue: ${parseInt(c.slice(5, 7), 16) / 255})`).join(', ')}]),
                    startPoint: CGPoint(x: 12, y: 1),
                    endPoint: CGPoint(x: 12, y: 23)
                )
                context.fill(cloud, with: gradient, style: FillStyle(eoFill: true))
                return
            }
            let eoFill = ["dsh", "traex", "trae", "deepseek"].contains(backend.lowercased())
            if let colors = AgentMarkGlyphs.colors(for: backend) {
                for (path, color) in zip(paths, colors) {
                    context.fill(path, with: .color(color), style: FillStyle(eoFill: eoFill))
                }
                return
            }
            let ink: GraphicsContext.Shading = .color(color ?? Self.fallbackColor(for: backend))
            for path in paths {
                context.fill(path, with: ink, style: FillStyle(eoFill: eoFill))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// Brand colours for surfaces with no agent palette role to borrow. Themed surfaces should
    /// pass their palette's agent colour explicitly instead.
    static func fallbackColor(for backend: String) -> Color {
        switch backend.lowercased() {
        case "claude": return Color(red: 0.851, green: 0.467, blue: 0.341)
        case "dsh", "deepseek": return Color(red: 0.302, green: 0.420, blue: 0.996)
        case "traex", "trae": return Color(red: 0.0, green: 0.659, blue: 0.384)
        default: return .primary
        }
    }
}
`;
}

// MARK: - Write / check

const outputs: [string, string][] = [
  ['apps/web/src/components/agent-marks.tsx', emitWeb()],
  ['apps/mobile/shared/src/commonMain/kotlin/riffet/ui/icons/AgentMarks.kt', emitKotlin()],
  ['apps/macos/Riffet/Theme/AgentMarks.swift', emitSwift()],
  ['apps/mobile/iosApp/Riffet/Design/AgentMarks.swift', emitSwift()],
];

let stale = false;
for (const [rel, content] of outputs) {
  const path = resolve(root, rel);
  if (checkOnly) {
    let existing = '';
    try { existing = readFileSync(path, 'utf8'); } catch { /* missing counts as stale */ }
    if (existing !== content) { console.error(`stale: ${rel} (run pnpm gen:marks)`); stale = true; }
  } else {
    writeFileSync(path, content);
    console.log(`wrote ${rel}`);
  }
}
if (stale) process.exit(1);
