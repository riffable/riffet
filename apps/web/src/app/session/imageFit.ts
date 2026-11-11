export interface Size { w: number; h: number }

/** Space kept around the image at its fitted size, so its edge never touches the frame. */
export const IMAGE_GUTTER = 16;

/**
 * The scale an image opens at: the whole picture inside the frame, and never beyond its own pixels.
 *
 * This is the rule the macOS viewer uses (`min(1, frame / image)`), and it is deliberately the only
 * one: a portrait phone screenshot is taller than the frame and used to open fitted to its *width*
 * instead, which read as "the preview zoomed in" — its bottom half was off-screen until the reader
 * zoomed out. A full-page screenshot opens small for the same reason and is read by zooming in
 * (double-click, the toolbar, ⌘/Ctrl + wheel or a pinch); the readers that want the long image
 * readable at arm's length do that once and it stays put for the session.
 */
export function fitScale(image: Size, frame: Size): number {
  if (image.w <= 0 || image.h <= 0) return 1;
  // A frame with no measured area yet (a panel that has not been laid out) has no meaningful fit:
  // show the image at its own size and let the next measurement settle it.
  if (frame.w <= IMAGE_GUTTER * 2 || frame.h <= IMAGE_GUTTER * 2) return 1;
  const across = (frame.w - IMAGE_GUTTER * 2) / image.w;
  const down = (frame.h - IMAGE_GUTTER * 2) / image.h;
  return Math.min(1, across, down);
}
