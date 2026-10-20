// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  hasMetadata,
  needsManualTurn,
  orientationTransform,
  readExifOrientation,
  readJpegInfo,
  stripJpegMetadata,
  swapsSides,
  type Orientation,
} from './exif.js';

const bytes = (...parts: Array<number | number[] | Uint8Array>) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'number' ? [p] : [...p])));

const segment = (marker: number, body: number[]) => [
  0xff,
  marker,
  (body.length + 2) >> 8,
  (body.length + 2) & 0xff,
  ...body,
];

/** An EXIF segment with just the orientation tag (and optionally a GPS pointer tag). */
function exif(orientation: number, order: 'II' | 'MM' = 'MM', gps = false): number[] {
  const be = order === 'MM';
  const u16 = (n: number) => (be ? [n >> 8, n & 0xff] : [n & 0xff, n >> 8]);
  const u32 = (n: number) =>
    be
      ? [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
      : [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
  const entry = (tag: number, type: number, value: number) => [
    ...u16(tag),
    ...u16(type),
    ...u32(1),
    ...(type === 3 ? [...u16(value), 0, 0] : u32(value)),
  ];
  const entries = [entry(0x0112, 3, orientation), ...(gps ? [entry(0x8825, 4, 0x1234)] : [])];
  const tiff = [
    ...(be ? [0x4d, 0x4d] : [0x49, 0x49]),
    ...u16(42),
    ...u32(8),
    ...u16(entries.length),
    ...entries.flat(),
    ...u32(0),
  ];
  return [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
}

const jfif = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
/** Precision 8, height 3000, width 4000, three components. */
const frame = (h = 3000, w = 4000) =>
  segment(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const scan = [
  ...segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]),
  0x12,
  0x34,
  0xff,
  0x00,
  0x56,
];
const jpeg = (...middle: number[][]) => bytes(0xff, 0xd8, ...middle, ...scan, 0xff, 0xd9);

describe('readExifOrientation', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)('reads orientation %i in either byte order', (o) => {
    expect(readExifOrientation(jpeg(jfif, segment(0xe1, exif(o, 'MM')), frame()))).toBe(o);
    expect(readExifOrientation(jpeg(segment(0xe1, exif(o, 'II')), frame()))).toBe(o);
  });

  it('says 1 (upright) for a photo with no EXIF, a non-JPEG, an empty file and nonsense', () => {
    expect(readExifOrientation(jpeg(jfif, frame()))).toBe(1);
    expect(readExifOrientation(bytes(0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4))).toBe(1);
    expect(readExifOrientation(new Uint8Array())).toBe(1);
    expect(readExifOrientation(jpeg(segment(0xe1, exif(9))))).toBe(1);
    expect(readExifOrientation(jpeg(segment(0xe1, exif(0))))).toBe(1);
  });

  it('does not crash on a truncated EXIF segment', () => {
    const whole = jpeg(segment(0xe1, exif(6)));
    for (let cut = 0; cut < 40; cut += 1) {
      expect(() => readExifOrientation(whole.subarray(0, cut))).not.toThrow();
    }
    expect(readExifOrientation(whole.subarray(0, 30))).toBe(1);
  });
});

describe('readJpegInfo', () => {
  it('gives the stored size next to the orientation, even after a big EXIF segment', () => {
    const big = segment(0xe1, [...exif(6), ...new Array(5000).fill(0)]);
    expect(readJpegInfo(jpeg(big, frame(3024, 4032)))).toEqual({
      orientation: 6,
      width: 4032,
      height: 3024,
    });
  });

  it('has no size when there is no frame header before the picture data', () => {
    expect(readJpegInfo(jpeg(segment(0xe1, exif(3))))).toEqual({ orientation: 3 });
  });
});

describe('orientationTransform', () => {
  const apply = (m: number[], x: number, y: number) => [
    m[0]! * x + m[2]! * y + m[4]!,
    m[1]! * x + m[3]! * y + m[5]!,
  ];
  // A stored picture 4 wide and 2 tall. Its top-left corner is (0,0), bottom-right is (4,2).
  const W = 4;
  const H = 2;
  // Where the stored top-left and bottom-right corners must land in the upright picture.
  const expected: Record<
    Orientation,
    { size: [number, number]; topLeft: number[]; bottomRight: number[] }
  > = {
    1: { size: [4, 2], topLeft: [0, 0], bottomRight: [4, 2] },
    2: { size: [4, 2], topLeft: [4, 0], bottomRight: [0, 2] },
    3: { size: [4, 2], topLeft: [4, 2], bottomRight: [0, 0] },
    4: { size: [4, 2], topLeft: [0, 2], bottomRight: [4, 0] },
    5: { size: [2, 4], topLeft: [0, 0], bottomRight: [2, 4] },
    6: { size: [2, 4], topLeft: [2, 0], bottomRight: [0, 4] },
    7: { size: [2, 4], topLeft: [2, 4], bottomRight: [0, 0] },
    8: { size: [2, 4], topLeft: [0, 4], bottomRight: [2, 0] },
  };

  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)('draws orientation %i upright', (o) => {
    const t = orientationTransform(o, W, H);
    expect([t.width, t.height]).toEqual(expected[o].size);
    expect(apply(t.matrix, 0, 0)).toEqual(expected[o].topLeft);
    expect(apply(t.matrix, W, H)).toEqual(expected[o].bottomRight);
    // Everything stays inside the upright picture.
    for (const [x, y] of [
      [0, 0],
      [W, 0],
      [0, H],
      [W, H],
    ] as const) {
      const [px, py] = apply(t.matrix, x, y) as [number, number];
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(t.width);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThanOrEqual(t.height);
    }
  });

  it('swaps sides exactly for the quarter-turn orientations', () => {
    expect([1, 2, 3, 4].map((o) => swapsSides(o as Orientation))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect([5, 6, 7, 8].map((o) => swapsSides(o as Orientation))).toEqual([true, true, true, true]);
  });
});

describe('needsManualTurn', () => {
  const info = { orientation: 6 as Orientation, width: 4032, height: 3024 };

  it('is true when a quarter-turned photo came out of the browser still on its side', () => {
    expect(needsManualTurn(info, { width: 4032, height: 3024 })).toBe(true);
  });

  it('is false when the browser already turned it, or when nothing needs turning', () => {
    expect(needsManualTurn(info, { width: 3024, height: 4032 })).toBe(false);
    expect(needsManualTurn({ ...info, orientation: 1 }, { width: 4032, height: 3024 })).toBe(false);
    expect(needsManualTurn({ orientation: 6 }, { width: 4032, height: 3024 })).toBe(false);
    expect(
      needsManualTurn({ ...info, width: 3000, height: 3000 }, { width: 3000, height: 3000 }),
    ).toBe(false);
  });
});

describe('stripJpegMetadata', () => {
  const withGps = jpeg(
    jfif,
    segment(0xe1, exif(6, 'MM', true)),
    segment(0xe1, [0x68, 0x74, 0x74, 0x70]),
    segment(0xfe, [0x68, 0x69]),
    frame(),
  );

  it('removes EXIF (with its GPS pointer), XMP and comments but keeps the picture', () => {
    expect(hasMetadata(withGps)).toBe(true);
    const clean = stripJpegMetadata(withGps);

    expect(hasMetadata(clean)).toBe(false);
    expect(readJpegInfo(clean)).toEqual({ orientation: 1, width: 4000, height: 3000 });
    expect(clean.length).toBeLessThan(withGps.length);
    // Starts like a JPEG with its JFIF header, and ends with the same picture data.
    expect([...clean.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect([...clean.subarray(clean.length - scan.length - 2)]).toEqual([...scan, 0xff, 0xd9]);
    // Neither the Exif header nor the GPS tag number is left anywhere.
    const text = String.fromCharCode(...clean);
    expect(text).not.toContain('Exif');
    expect(text).not.toContain('http');
  });

  it('leaves a photo with no metadata byte for byte as it was', () => {
    const plain = jpeg(jfif, frame());
    expect(hasMetadata(plain)).toBe(false);
    expect(stripJpegMetadata(plain)).toBe(plain);
  });

  it('leaves anything that is not a well-formed JPEG alone', () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0);
    expect(stripJpegMetadata(png)).toBe(png);
    const cut = withGps.subarray(0, 30);
    expect(stripJpegMetadata(cut)).toBe(cut);
  });

  it('keeps the picture data whole, including a stuffed 0xFF 0x00 byte in it', () => {
    const clean = stripJpegMetadata(withGps);
    expect([...clean.subarray(clean.length - 6)]).toEqual([0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]);
  });
});
