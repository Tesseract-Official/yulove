/** The pure maths behind the full-screen photo viewer, kept apart so it can be tested. */

export const MIN_SCALE = 1;
export const MAX_SCALE = 6;
/** What a double tap zooms to. */
export const DOUBLE_TAP_SCALE = 2.5;

export interface Point {
  x: number;
  y: number;
}

export interface View {
  scale: number;
  /** Offset of the photo's centre from the middle of the frame, in pixels. */
  x: number;
  y: number;
}

export const FIT: View = { scale: MIN_SCALE, x: 0, y: 0 };

export const clampScale = (scale: number): number =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Keeps the photo from being dragged off the frame: it may move by half of what the zoom adds to
 * each side, and not at all when it fits.
 */
export function clampView(view: View, frame: { width: number; height: number }): View {
  const scale = clampScale(view.scale);
  const limitX = (frame.width * (scale - 1)) / 2;
  const limitY = (frame.height * (scale - 1)) / 2;
  // `+ 0` turns a negative zero into a plain one, so a fitted photo is exactly FIT.
  return {
    scale,
    x: Math.min(limitX, Math.max(-limitX, view.x)) + 0,
    y: Math.min(limitY, Math.max(-limitY, view.y)) + 0,
  };
}

/**
 * Changes the zoom by `factor` while keeping the point under `focus` (measured from the middle of
 * the frame) where it is, which is what makes a pinch feel anchored to the fingers.
 */
export function zoomAround(
  view: View,
  factor: number,
  focus: Point,
  frame: { width: number; height: number },
): View {
  const scale = clampScale(view.scale * factor);
  const applied = scale / view.scale;
  return clampView(
    {
      scale,
      x: focus.x - (focus.x - view.x) * applied,
      y: focus.y - (focus.y - view.y) * applied,
    },
    frame,
  );
}
