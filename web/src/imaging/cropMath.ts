/**
 * The geometry of the photo screen, as pure functions: a free-form crop box over a turned photo,
 * with zoom and pan. Two coordinate systems are used throughout:
 *
 * - image coordinates: pixels of the (already turned) working photo, origin top-left;
 * - frame coordinates: CSS pixels of the screen area that shows the photo, origin top-left.
 *
 * A `View` says where the photo sits in the frame: `scale` is a multiple of the "fit" size (1 shows
 * the whole photo), and `x`/`y` move the photo's centre away from the frame's centre.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point, Size {}

export interface View {
  scale: number;
  x: number;
  y: number;
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** Space kept around the photo at "fit", so the corner handles are not under the screen edge. */
export const FRAME_PADDING = 24;
/** How close a finger must be to a handle to grab it (a comfortable touch target). */
export const GRAB_RADIUS = 28;
/** The smallest crop, as a fraction of the shorter side of the photo. */
export const MIN_BOX_FRACTION = 0.05;

export const FIT_VIEW: View = { scale: 1, x: 0, y: 0 };

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

/** The size of a photo after it is turned by a multiple of 90 degrees. */
export function rotatedSize(size: Size, rotation: number): Size {
  return Math.round(rotation / 90) % 2 === 0
    ? { ...size }
    : { width: size.height, height: size.width };
}

/** The whole photo as a crop box. */
export const wholeBox = (size: Size): Box => ({
  x: 0,
  y: 0,
  width: size.width,
  height: size.height,
});

export const smallestBox = (size: Size): number =>
  Math.max(1, Math.round(Math.min(size.width, size.height) * MIN_BOX_FRACTION));

/** Keeps a box inside the photo and at least `min` on each side. */
export function clampBox(box: Box, bounds: Size, min = smallestBox(bounds)): Box {
  const width = clamp(box.width, Math.min(min, bounds.width), bounds.width);
  const height = clamp(box.height, Math.min(min, bounds.height), bounds.height);
  return {
    x: clamp(box.x, 0, bounds.width - width),
    y: clamp(box.y, 0, bounds.height - height),
    width,
    height,
  };
}

/**
 * Drags one handle of the box by (dx, dy) image pixels, from the box as it was when the drag
 * started. The box never leaves the photo, never gets smaller than `min`, and never flips.
 */
export function resizeBox(
  start: Box,
  handle: Handle,
  dx: number,
  dy: number,
  bounds: Size,
  min = smallestBox(bounds),
): Box {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  const minW = Math.min(min, bounds.width);
  const minH = Math.min(min, bounds.height);

  if (handle.includes('w')) left = clamp(left + dx, 0, right - minW);
  if (handle.includes('e')) right = clamp(right + dx, left + minW, bounds.width);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - minH);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + minH, bounds.height);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The box after the photo is turned a quarter, so that it still covers the same part of the
 * picture. `size` is the photo's size before the turn.
 */
export function rotateBox(box: Box, size: Size, direction: 'cw' | 'ccw'): Box {
  return direction === 'cw'
    ? { x: size.height - box.y - box.height, y: box.x, width: box.height, height: box.width }
    : { x: box.y, y: size.width - box.x - box.width, width: box.height, height: box.width };
}

/** The scale that makes the whole photo fit in the frame (with a margin), before any zoom. */
export function fitScale(content: Size, frame: Size, padding = FRAME_PADDING): number {
  const w = Math.max(1, frame.width - padding * 2);
  const h = Math.max(1, frame.height - padding * 2);
  return Math.min(w / content.width, h / content.height);
}

/** Frame pixels per image pixel for a view. */
export const pixelsPerImagePixel = (content: Size, frame: Size, view: View): number =>
  fitScale(content, frame) * view.scale;

/** Where an image point is in the frame. */
export function imageToFrame(point: Point, content: Size, frame: Size, view: View): Point {
  const k = pixelsPerImagePixel(content, frame, view);
  return {
    x: frame.width / 2 + view.x + (point.x - content.width / 2) * k,
    y: frame.height / 2 + view.y + (point.y - content.height / 2) * k,
  };
}

/** Which image point is under a point of the frame. */
export function frameToImage(point: Point, content: Size, frame: Size, view: View): Point {
  const k = pixelsPerImagePixel(content, frame, view);
  return {
    x: content.width / 2 + (point.x - frame.width / 2 - view.x) / k,
    y: content.height / 2 + (point.y - frame.height / 2 - view.y) / k,
  };
}

/** A crop box in frame pixels. */
export function boxToFrame(box: Box, content: Size, frame: Size, view: View): Box {
  const topLeft = imageToFrame(box, content, frame, view);
  const k = pixelsPerImagePixel(content, frame, view);
  return { x: topLeft.x, y: topLeft.y, width: box.width * k, height: box.height * k };
}

/**
 * Stops the photo being dragged away: a photo smaller than the frame stays centred, a larger one
 * can move until its edge (plus the margin) reaches the frame's edge.
 */
export function clampView(view: View, content: Size, frame: Size): View {
  const scale = clamp(view.scale, MIN_ZOOM, MAX_ZOOM);
  const k = fitScale(content, frame) * scale;
  const limitX = Math.max(0, (content.width * k - frame.width) / 2 + FRAME_PADDING);
  const limitY = Math.max(0, (content.height * k - frame.height) / 2 + FRAME_PADDING);
  // `+ 0` turns a negative zero into a plain zero.
  return {
    scale,
    x: clamp(view.x, -limitX, limitX) + 0,
    y: clamp(view.y, -limitY, limitY) + 0,
  };
}

/**
 * Zooms by `factor` while the image point under `focus` (a frame point) stays under the finger.
 */
export function zoomAround(
  view: View,
  factor: number,
  focus: Point,
  content: Size,
  frame: Size,
): View {
  const scale = clamp(view.scale * factor, MIN_ZOOM, MAX_ZOOM);
  const applied = scale / view.scale;
  const fx = focus.x - frame.width / 2;
  const fy = focus.y - frame.height / 2;
  return clampView(
    { scale, x: fx - (fx - view.x) * applied, y: fy - (fy - view.y) * applied },
    content,
    frame,
  );
}

/** Moves the photo by a drag, kept inside the allowed range. */
export const panBy = (view: View, dx: number, dy: number, content: Size, frame: Size): View =>
  clampView({ ...view, x: view.x + dx, y: view.y + dy }, content, frame);

const distanceToSegment = (p: Point, a: Point, b: Point): number => {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSquared = abx * abx + aby * aby;
  const t =
    lengthSquared === 0 ? 0 : clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSquared, 0, 1);
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
};

/**
 * Which handle of the (frame-pixel) box a finger at `point` has grabbed, if any. Corners win over
 * edges, so a small box can still be grabbed by a corner; edges can be grabbed anywhere along
 * their length.
 */
export function hitHandle(box: Box, point: Point, radius = GRAB_RADIUS): Handle | null {
  const l = box.x;
  const t = box.y;
  const r = box.x + box.width;
  const b = box.y + box.height;
  const corners: Array<[Handle, Point]> = [
    ['nw', { x: l, y: t }],
    ['ne', { x: r, y: t }],
    ['se', { x: r, y: b }],
    ['sw', { x: l, y: b }],
  ];
  const edges: Array<[Handle, Point, Point]> = [
    ['n', { x: l, y: t }, { x: r, y: t }],
    ['e', { x: r, y: t }, { x: r, y: b }],
    ['s', { x: l, y: b }, { x: r, y: b }],
    ['w', { x: l, y: t }, { x: l, y: b }],
  ];

  let best: Handle | null = null;
  let bestDistance = radius;
  for (const [handle, corner] of corners) {
    const d = Math.hypot(point.x - corner.x, point.y - corner.y);
    // A corner is preferred when it is about as close as an edge.
    if (d - radius * 0.25 < bestDistance) {
      best = handle;
      bestDistance = Math.max(0, d - radius * 0.25);
    }
  }
  if (best) return best;
  for (const [handle, from, to] of edges) {
    const d = distanceToSegment(point, from, to);
    if (d < bestDistance) {
      best = handle;
      bestDistance = d;
    }
  }
  return best;
}

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
