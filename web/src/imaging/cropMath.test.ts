// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  FIT_VIEW,
  FRAME_PADDING,
  MAX_ZOOM,
  boxToFrame,
  clampBox,
  clampView,
  fitScale,
  frameToImage,
  hitHandle,
  imageToFrame,
  panBy,
  resizeBox,
  rotateBox,
  rotatedSize,
  smallestBox,
  wholeBox,
  zoomAround,
  type Box,
  type Handle,
} from './cropMath.js';

const photo = { width: 3000, height: 2000 };
const frame = { width: 400, height: 700 };

describe('rotatedSize / wholeBox', () => {
  it('swaps the sides for quarter turns only', () => {
    expect(rotatedSize(photo, 0)).toEqual(photo);
    expect(rotatedSize(photo, 90)).toEqual({ width: 2000, height: 3000 });
    expect(rotatedSize(photo, 180)).toEqual(photo);
    expect(rotatedSize(photo, 270)).toEqual({ width: 2000, height: 3000 });
    expect(wholeBox(photo)).toEqual({ x: 0, y: 0, width: 3000, height: 2000 });
  });
});

describe('resizeBox', () => {
  const start: Box = { x: 1000, y: 500, width: 1000, height: 800 };
  const min = smallestBox(photo);

  it.each<[Handle, number, number, Box]>([
    ['nw', 100, 50, { x: 1100, y: 550, width: 900, height: 750 }],
    ['ne', 100, 50, { x: 1000, y: 550, width: 1100, height: 750 }],
    ['se', 100, 50, { x: 1000, y: 500, width: 1100, height: 850 }],
    ['sw', 100, 50, { x: 1100, y: 500, width: 900, height: 850 }],
    ['n', 100, 50, { x: 1000, y: 550, width: 1000, height: 750 }],
    ['e', 100, 50, { x: 1000, y: 500, width: 1100, height: 800 }],
    ['s', 100, 50, { x: 1000, y: 500, width: 1000, height: 850 }],
    ['w', 100, 50, { x: 1100, y: 500, width: 900, height: 800 }],
  ])(
    'moves the %s handle by (%i, %i) and only the sides it touches',
    (handle, dx, dy, expected) => {
      expect(resizeBox(start, handle, dx, dy, photo)).toEqual(expected);
    },
  );

  it('stops at the edges of the photo', () => {
    expect(resizeBox(start, 'nw', -5000, -5000, photo)).toEqual({
      x: 0,
      y: 0,
      width: 2000,
      height: 1300,
    });
    expect(resizeBox(start, 'se', 5000, 5000, photo)).toEqual({
      x: 1000,
      y: 500,
      width: 2000,
      height: 1500,
    });
  });

  it('never gets smaller than the minimum and never flips over', () => {
    const squeezed = resizeBox(start, 'e', -5000, 0, photo);
    expect(squeezed).toEqual({ x: 1000, y: 500, width: min, height: 800 });
    const crushed = resizeBox(start, 'nw', 5000, 5000, photo);
    expect(crushed).toEqual({ x: 2000 - min, y: 1300 - min, width: min, height: min });
    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) {
      const box = resizeBox(start, handle, -9999, 9999, photo);
      expect(box.width).toBeGreaterThanOrEqual(min);
      expect(box.height).toBeGreaterThanOrEqual(min);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(photo.width);
      expect(box.y + box.height).toBeLessThanOrEqual(photo.height);
    }
  });

  it('does not change the start box it was given', () => {
    const copy = { ...start };
    resizeBox(start, 'se', 10, 10, photo);
    expect(start).toEqual(copy);
  });
});

describe('clampBox', () => {
  it('pulls a box that sticks out back inside the photo', () => {
    expect(clampBox({ x: -50, y: 1900, width: 500, height: 500 }, photo)).toEqual({
      x: 0,
      y: 1500,
      width: 500,
      height: 500,
    });
    expect(clampBox({ x: 0, y: 0, width: 99999, height: 1 }, photo)).toEqual({
      x: 0,
      y: 0,
      width: 3000,
      height: smallestBox(photo),
    });
  });
});

describe('rotateBox', () => {
  const box: Box = { x: 300, y: 100, width: 1200, height: 700 };

  it('keeps covering the same part of the picture after a quarter turn', () => {
    expect(rotateBox(box, photo, 'cw')).toEqual({ x: 1200, y: 300, width: 700, height: 1200 });
    expect(rotateBox(box, photo, 'ccw')).toEqual({ x: 100, y: 1500, width: 700, height: 1200 });
  });

  it('puts the corners where turning the photo puts them', () => {
    // Clockwise: the point (x, y) of a W x H photo goes to (H - y, x).
    const cw = rotateBox(box, photo, 'cw');
    const topLeftAfter = { x: photo.height - box.y, y: box.x };
    expect(cw.x + cw.width).toBe(topLeftAfter.x);
    expect(cw.y).toBe(topLeftAfter.y);
  });

  it('is undone by turning back, and four turns are no turn', () => {
    const back = rotateBox(rotateBox(box, photo, 'cw'), rotatedSize(photo, 90), 'ccw');
    expect(back).toEqual(box);
    let turned = box;
    let size = photo;
    for (let i = 0; i < 4; i += 1) {
      turned = rotateBox(turned, size, 'cw');
      size = rotatedSize(size, 90);
    }
    expect(turned).toEqual(box);
    let left = box;
    size = photo;
    for (let i = 0; i < 4; i += 1) {
      left = rotateBox(left, size, 'ccw');
      size = rotatedSize(size, 90);
    }
    expect(left).toEqual(box);
  });

  it('keeps a whole-photo box as the whole turned photo', () => {
    expect(rotateBox(wholeBox(photo), photo, 'cw')).toEqual(wholeBox(rotatedSize(photo, 90)));
    expect(rotateBox(wholeBox(photo), photo, 'ccw')).toEqual(wholeBox(rotatedSize(photo, 90)));
  });
});

describe('fitting, zooming and panning', () => {
  it('fits the whole photo inside the frame with a margin', () => {
    const k = fitScale(photo, frame);
    expect(k).toBeCloseTo((400 - 2 * FRAME_PADDING) / 3000, 6);
    expect(photo.width * k).toBeLessThanOrEqual(frame.width - 2 * FRAME_PADDING + 1e-9);
    expect(photo.height * k).toBeLessThanOrEqual(frame.height - 2 * FRAME_PADDING + 1e-9);
    // A small photo is enlarged to fit, never cropped.
    expect(fitScale({ width: 100, height: 100 }, frame)).toBeGreaterThan(1);
  });

  it('turns image points into frame points and back', () => {
    const view = { scale: 2.5, x: 40, y: -30 };
    for (const point of [
      { x: 0, y: 0 },
      { x: 1500, y: 1000 },
      { x: 2999, y: 17 },
    ]) {
      const there = imageToFrame(point, photo, frame, view);
      const back = frameToImage(there, photo, frame, view);
      expect(back.x).toBeCloseTo(point.x, 6);
      expect(back.y).toBeCloseTo(point.y, 6);
    }
    // At fit the middle of the photo is the middle of the frame.
    expect(imageToFrame({ x: 1500, y: 1000 }, photo, frame, FIT_VIEW)).toEqual({ x: 200, y: 350 });
  });

  it('draws a crop box in frame pixels', () => {
    const k = fitScale(photo, frame);
    const box = boxToFrame(wholeBox(photo), photo, frame, FIT_VIEW);
    expect(box.width).toBeCloseTo(photo.width * k, 6);
    expect(box.x).toBeCloseTo((frame.width - photo.width * k) / 2, 6);
  });

  it('keeps the point under the fingers where it was while zooming', () => {
    // A point on the photo (the photo is letterboxed at fit, so it is not at the very top).
    const focus = { x: 300, y: 300 };
    const before = frameToImage(focus, photo, frame, FIT_VIEW);
    const zoomed = zoomAround(FIT_VIEW, 6, focus, photo, frame);
    expect(zoomed.scale).toBe(6);
    const after = frameToImage(focus, photo, frame, zoomed);
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
  });

  it('never zooms out past fit or in past the maximum', () => {
    expect(zoomAround(FIT_VIEW, 0.2, { x: 10, y: 10 }, photo, frame)).toEqual(FIT_VIEW);
    expect(zoomAround(FIT_VIEW, 100, { x: 200, y: 350 }, photo, frame).scale).toBe(MAX_ZOOM);
  });

  it('keeps a photo that fits still, and stops a zoomed one leaving the frame', () => {
    expect(clampView({ scale: 1, x: 500, y: 500 }, photo, frame)).toEqual(FIT_VIEW);

    const zoomed = clampView({ scale: 4, x: 99999, y: -99999 }, photo, frame);
    const k = fitScale(photo, frame) * 4;
    expect(zoomed.x).toBeCloseTo((photo.width * k - frame.width) / 2 + FRAME_PADDING, 6);
    expect(zoomed.y).toBeCloseTo(-((photo.height * k - frame.height) / 2 + FRAME_PADDING), 6);
  });

  it('pans by the drag and no further than allowed', () => {
    const zoomed = zoomAround(FIT_VIEW, 8, { x: 200, y: 350 }, photo, frame);
    const moved = panBy(zoomed, 30, -20, photo, frame);
    expect(moved.x).toBeCloseTo(zoomed.x + 30, 6);
    expect(moved.y).toBeCloseTo(zoomed.y - 20, 6);
    expect(panBy(zoomed, 1e6, 1e6, photo, frame).x).toBeLessThan(1e6);
  });

  it('gives a plain zero, not minus zero, for a centred photo', () => {
    const view = clampView({ scale: 1, x: -0, y: -0 }, { width: 100, height: 700 }, frame);
    expect(Object.is(view.x, 0)).toBe(true);
  });
});

describe('hitHandle', () => {
  const box: Box = { x: 100, y: 200, width: 200, height: 300 };

  it('grabs a corner near it, and an edge anywhere along it', () => {
    expect(hitHandle(box, { x: 104, y: 205 })).toBe('nw');
    expect(hitHandle(box, { x: 296, y: 205 })).toBe('ne');
    expect(hitHandle(box, { x: 296, y: 495 })).toBe('se');
    expect(hitHandle(box, { x: 104, y: 495 })).toBe('sw');
    expect(hitHandle(box, { x: 200, y: 203 })).toBe('n');
    expect(hitHandle(box, { x: 302, y: 350 })).toBe('e');
    expect(hitHandle(box, { x: 200, y: 497 })).toBe('s');
    expect(hitHandle(box, { x: 98, y: 300 })).toBe('w');
  });

  it('lets the photo be panned when the finger is away from the box edges', () => {
    expect(hitHandle(box, { x: 200, y: 350 })).toBeNull(); // the middle of the box
    expect(hitHandle(box, { x: 20, y: 20 })).toBeNull(); // outside the box
  });

  it('still lets a very small box be grabbed by its corners', () => {
    const tiny: Box = { x: 100, y: 100, width: 20, height: 20 };
    expect(hitHandle(tiny, { x: 98, y: 98 })).toBe('nw');
    expect(hitHandle(tiny, { x: 122, y: 122 })).toBe('se');
  });
});
