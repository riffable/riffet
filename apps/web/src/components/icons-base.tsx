import type { LucideIcon, LucideProps } from 'lucide-react';
import { ArrowRight, Check, QrCode, ChevronDown, CircleAlert, CircleCheck, Info, LoaderCircle, RefreshCw, RotateCcw, TriangleAlert, X } from 'lucide-react';

/**
 * The icon wrappers, and the few glyphs the page needs before the workbench chunk arrives: the
 * sign-in screen, the UI primitives it uses (fields, menus, toasts, dialogs) and the page error boundary.
 * Everything else lives in `icons.tsx`, which re-exports these, so it loads with the workbench.
 * A glyph from there used by one of these early modules pulls that whole file back into the entry.
 */
export type IconProps = LucideProps;

/**
 * The drawn stroke, in screen pixels at every size: `.lucide *` in index.css sets
 * `vector-effect: non-scaling-stroke`, so a 14px glyph and a 20px one carry the same line as the
 * text beside them instead of a line that thins as the glyph shrinks.
 */
const STROKE_WIDTH = 1.25;

/**
 * Wraps a lucide glyph. Deliberately sets no `size`/inline width or height: call sites size
 * icons with Tailwind (`size-*` / `[&_svg]:size-*`). Only strokeWidth has a default, and it
 * stays overridable per call site.
 */
export function icon(Lucide: LucideIcon) {
  return function Icon({ strokeWidth = STROKE_WIDTH, ...props }: IconProps) {
    return <Lucide strokeWidth={strokeWidth} {...props} />;
  };
}

/** The same outline, filled in: something is on (saved, starred, fast) or it is a transport control (play, stop). */
export function filled(Lucide: LucideIcon) {
  return function Icon({ strokeWidth = STROKE_WIDTH, ...props }: IconProps) {
    return <Lucide strokeWidth={strokeWidth} fill="currentColor" {...props} />;
  };
}

export const IconArrowRight = icon(ArrowRight);
export const IconCheck = icon(Check);
export const IconChevronDown = icon(ChevronDown);
export const IconCircleAlert = icon(CircleAlert);
export const IconCircleCheck = icon(CircleCheck);
export const IconInfo = icon(Info);
export const IconLoaderCircle = icon(LoaderCircle);
export const IconRefreshCw = icon(RefreshCw);
export const IconRotateCcw = icon(RotateCcw);
export const IconTriangleAlert = icon(TriangleAlert);
export const IconX = icon(X);
/** Pairing by QR code; here because the sign-in screen offers it. */
export const IconQrCode = icon(QrCode);
