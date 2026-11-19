// Plain geometry with no imports, so a worker (黑马跑酷's renderer) can take it without the app.

/**
 * The brand mark on a 24-unit grid: the mane, drawn first with a 0.6 round-join stroke, then the
 * horse's head with a 1 stroke, the eye a hole in it. Copied from `scripts/gen-brand.ts`, which
 * draws every shipped icon file from the same geometry. The mark's optical centre is (12.6, 11.8),
 * not the grid's, so a 24-unit box that shows it centred starts at `BRAND_VIEWBOX`.
 */
export const BRAND_MANE = 'M8.77 6.2Q6.51 6.56 5.15 8.55L7.76 8.17Q5.43 9.17 4.26 11.65L6.94 10.68Q4.72 12.24 3.82 15.1L6.42 13.42Z';
export const BRAND_BODY = 'M6 21C5.6 14.4 6.6 9 8.8 5.8L9.4 2.6L11.2 5.4C14.4 6.6 17.4 8.4 20 10.8c1.3 1.2 0.7 3.4 -1 3.4c-1.4 0 -3 -0.3 -4.4 -0.6c-1.4 -0.3 -2.3 0.3 -2.4 1.6c-0.1 2 0.2 4 0.8 5.8Z';
/** Appended to `BRAND_BODY` and filled even-odd, the eye is a hole. */
export const BRAND_EYE = 'M11.5 8.2a1 1 0 1 0 2 0a1 1 0 1 0 -2 0Z';
export const BRAND_VIEWBOX = '0.6 -0.2 24 24';
/** The mane's three teeth as separate shapes, each reaching under the head so it can swing: path, then pivot. */
export const BRAND_TEETH = [
  ['M8.77 6.2Q6.51 6.56 5.15 8.55L7.76 8.17L9.3 9.2L9.7 6.4Z', 8.9, 7.6],
  ['M7.76 8.17Q5.43 9.17 4.26 11.65L6.94 10.68L8.7 11.8L9.1 8.4Z', 8.2, 10.2],
  ['M6.94 10.68Q4.72 12.24 3.82 15.1L6.42 13.42L8.2 14.6L8.6 11Z', 7.6, 13],
] as const;
/** The mark's scale in a 32-unit tile (favicon, picker): the horse is 64% of the tile tall. */
export const BRAND_TILE_TRANSFORM = 'translate(2.64 3.49) scale(1.06)';
