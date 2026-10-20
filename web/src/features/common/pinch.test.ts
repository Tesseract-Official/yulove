import { describe, expect, it } from 'vitest';
import {
  FIT,
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  clampView,
  distance,
  midpoint,
  zoomAround,
} from './pinch.js';

const frame = { width: 400, height: 600 };

describe('pinch maths', () => {
  it('keeps the zoom between fit and the maximum', () => {
    expect(clampScale(0.2)).toBe(MIN_SCALE);
    expect(clampScale(3)).toBe(3);
    expect(clampScale(99)).toBe(MAX_SCALE);
  });

  it('measures the distance and the midpoint between two fingers', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 0, y: 10 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 15 });
  });

  it('does not let a fitted photo move, and stops a zoomed one leaving the frame', () => {
    expect(clampView({ scale: 1, x: 50, y: -50 }, frame)).toEqual(FIT);
    // At 2x each side gains half the frame: 200 across, 300 down.
    expect(clampView({ scale: 2, x: 999, y: -999 }, frame)).toEqual({ scale: 2, x: 200, y: -300 });
    expect(clampView({ scale: 2, x: 20, y: -30 }, frame)).toEqual({ scale: 2, x: 20, y: -30 });
  });

  it('zooms in by the pinch ratio and out again to exactly fit', () => {
    const zoomed = zoomAround(FIT, 2, { x: 0, y: 0 }, frame);
    expect(zoomed).toEqual({ scale: 2, x: 0, y: 0 });
    expect(zoomAround(zoomed, 0.5, { x: 0, y: 0 }, frame)).toEqual(FIT);
    expect(zoomAround(zoomed, 0.1, { x: 0, y: 0 }, frame)).toEqual(FIT);
    expect(zoomAround(zoomed, 100, { x: 0, y: 0 }, frame).scale).toBe(MAX_SCALE);
  });

  it('keeps the point under the fingers where it was while zooming', () => {
    // Zoom 2x about a point 100 px right of the middle: the photo shifts left by 100 so that
    // point stays put on screen.
    const view = zoomAround(FIT, 2, { x: 100, y: 0 }, frame);
    expect(view.scale).toBe(2);
    expect(view.x).toBe(-100);
    expect(view.y).toBe(0);
  });
});
