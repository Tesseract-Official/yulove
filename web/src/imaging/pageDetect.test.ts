// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { detectPageBox, type Pixels } from './pageDetect.js';

/** An image of w x h where `paint(x, y)` gives the grey level (0-255) of each pixel. */
function image(w: number, h: number, paint: (x: number, y: number) => number): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = paint(x, y);
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

/** A page (rows 20-89, columns 15-84 of 100 x 100) on a dark table, with lines of writing. */
const onTable = image(100, 100, (x, y) => {
  const onPage = x >= 15 && x <= 84 && y >= 20 && y <= 89;
  if (!onPage) return 45;
  // Dark writing every 8th row, with room left at the top, bottom and sides of the page.
  return y % 8 < 2 && y > 26 && y < 82 && x > 22 && x < 78 ? 60 : 225;
});

describe('detectPageBox', () => {
  it('finds a light page on a dark table, with a little room around it', () => {
    const box = detectPageBox(onTable)!;
    expect(box).not.toBeNull();
    expect(box.x).toBeCloseTo(0.14, 1);
    expect(box.y).toBeCloseTo(0.19, 1);
    expect(box.x + box.width).toBeCloseTo(0.86, 1);
    expect(box.y + box.height).toBeCloseTo(0.91, 1);
    // The page is inside the box, and the box is inside the photo.
    expect(box.x).toBeLessThanOrEqual(0.15);
    expect(box.y).toBeLessThanOrEqual(0.2);
    expect(box.x + box.width).toBeGreaterThanOrEqual(0.85);
    expect(box.y + box.height).toBeGreaterThanOrEqual(0.9);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1);
  });

  it('finds a page that is not in the middle and a photo that is not square', () => {
    const wide = image(160, 90, (x, y) => (x >= 90 && x < 150 && y >= 10 && y < 80 ? 230 : 30));
    const box = detectPageBox(wide)!;
    expect(box.x).toBeCloseTo(90 / 160, 1);
    expect(box.width).toBeCloseTo(60 / 160, 1);
  });

  it('says nothing for a photo that is all one tone', () => {
    expect(detectPageBox(image(100, 100, () => 128))).toBeNull();
    expect(detectPageBox(image(100, 100, () => 240))).toBeNull();
  });

  it('says nothing when the page already fills the photo', () => {
    expect(detectPageBox(image(100, 100, (x, y) => (x < 2 || y < 2 ? 20 : 230)))).toBeNull();
  });

  it('says nothing for a small light patch, which is not a page', () => {
    expect(detectPageBox(image(100, 100, (x, y) => (x < 20 && y < 20 ? 240 : 30)))).toBeNull();
  });

  it('says nothing for noise', () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    expect(detectPageBox(image(100, 100, () => Math.floor(random() * 256)))).toBeNull();
  });

  it('says nothing for a darker page on a lighter surface rather than guess wrong', () => {
    const darkPage = image(100, 100, (x, y) => (x >= 20 && x < 80 && y >= 20 && y < 80 ? 40 : 220));
    const box = detectPageBox(darkPage);
    // It may find the light surface, but that is nearly the whole photo, so it gives up.
    expect(box).toBeNull();
  });

  it('copes with tiny or malformed input', () => {
    expect(detectPageBox({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toBeNull();
    expect(detectPageBox({ data: new Uint8ClampedArray(16), width: 100, height: 100 })).toBeNull();
    expect(detectPageBox(image(4, 4, () => 200))).toBeNull();
  });
});
