import type { Box } from './cropMath.js';

/** A bitmap as `getImageData` gives it: RGBA bytes, row by row. */
export interface Pixels {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

/** The long side the photo is shrunk to before looking for the page. */
export const DETECT_EDGE = 200;

/** A row or column counts as "page" when it is at least this much as light as the lightest one. */
const PAGE_LINE_SHARE = 0.5;
/** ...and the lightest one must be at least this much light, or there is no page to find. */
const MIN_LINE_SHARE = 0.2;
/** The page must be at least this much of the photo, and (if more) it is just the whole photo. */
const MIN_AREA = 0.25;
const MAX_AREA = 0.97;
/** Inside the found box, this much must be light, or it is not a page. */
const MIN_PAGE_SHARE = 0.6;
/** A little extra around the page, so its edge is never cut off. */
const MARGIN = 0.01;

/** The best brightness threshold between dark and light (Otsu's method). */
function otsu(histogram: number[], total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i]!;
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let best = 127;
  for (let t = 0; t < 256; t += 1) {
    backgroundWeight += histogram[t]!;
    if (backgroundWeight === 0) continue;
    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundSum += t * histogram[t]!;
    const meanBackground = backgroundSum / backgroundWeight;
    const meanForeground = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }
  return best;
}

/**
 * Looks for a page lying on a darker surface and returns where it is, as fractions of the photo
 * (x, y, width, height from 0 to 1), or null when it cannot tell. It is deliberately simple: it
 * finds the lighter region with a brightness threshold and takes the box around the rows and
 * columns that are mostly light. It does not straighten a tilted page. When in doubt it says null
 * and the caller starts from the whole photo.
 */
export function detectPageBox({ data, width, height }: Pixels): Box | null {
  if (width < 8 || height < 8 || data.length < width * height * 4) return null;

  // Brightness of every pixel, lightly smoothed so a speck of noise does not matter.
  const raw = new Float32Array(width * height);
  for (let i = 0; i < raw.length; i += 1) {
    raw[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
  }
  const light = new Uint8Array(width * height);
  const smooth = new Float32Array(width * height);
  const histogram = new Array<number>(256).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || yy >= height || xx < 0 || xx >= width) continue;
          sum += raw[yy * width + xx]!;
          count += 1;
        }
      }
      const value = sum / count;
      smooth[y * width + x] = value;
      histogram[Math.min(255, Math.round(value))]! += 1;
    }
  }

  const threshold = otsu(histogram, width * height);
  let lightCount = 0;
  for (let i = 0; i < light.length; i += 1) {
    if (smooth[i]! > threshold) {
      light[i] = 1;
      lightCount += 1;
    }
  }
  const share = lightCount / light.length;
  if (share < 0.1 || share > 0.95) return null;

  // Rows that are light compared with the lightest row, then (within them) the columns that are.
  const rowShare = new Float32Array(height);
  let strongestRow = 0;
  for (let y = 0; y < height; y += 1) {
    let n = 0;
    for (let x = 0; x < width; x += 1) n += light[y * width + x]!;
    rowShare[y] = n / width;
    strongestRow = Math.max(strongestRow, rowShare[y]!);
  }
  if (strongestRow < MIN_LINE_SHARE) return null;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    if (rowShare[y]! >= strongestRow * PAGE_LINE_SHARE) {
      if (top < 0) top = y;
      bottom = y;
    }
  }

  const columnShare = new Float32Array(width);
  let strongestColumn = 0;
  for (let x = 0; x < width; x += 1) {
    let n = 0;
    for (let y = top; y <= bottom; y += 1) n += light[y * width + x]!;
    columnShare[x] = n / (bottom - top + 1);
    strongestColumn = Math.max(strongestColumn, columnShare[x]!);
  }
  if (strongestColumn < MIN_LINE_SHARE) return null;
  let left = -1;
  let right = -1;
  for (let x = 0; x < width; x += 1) {
    if (columnShare[x]! >= strongestColumn * PAGE_LINE_SHARE) {
      if (left < 0) left = x;
      right = x;
    }
  }

  const boxW = right - left + 1;
  const boxH = bottom - top + 1;
  const area = (boxW * boxH) / (width * height);
  if (area < MIN_AREA || area > MAX_AREA) return null;

  let inside = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) inside += light[y * width + x]!;
  }
  if (inside / (boxW * boxH) < MIN_PAGE_SHARE) return null;

  const x0 = Math.max(0, left / width - MARGIN);
  const y0 = Math.max(0, top / height - MARGIN);
  const x1 = Math.min(1, (right + 1) / width + MARGIN);
  const y1 = Math.min(1, (bottom + 1) / height + MARGIN);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
