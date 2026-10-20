// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ANSWER_IMAGE_MAX_BYTES } from '@yulove/shared';
import { makeJpeg } from '../test/jpeg.js';
import { hasMetadata } from './exif.js';
import {
  FIRST_QUALITY,
  ImagingError,
  UPLOAD_MAX_EDGE,
  WORKING_MAX_EDGE,
  cropAndCompress,
  fitWithin,
  prepareImage,
  rotatedSize,
  suggestCrop,
  withoutMetadata,
  type CanvasLike,
  type Context2D,
  type ImageDataLike,
  type ImagingEnv,
} from './imaging.js';

interface Call {
  name: string;
  args: unknown[];
}

/**
 * A canvas that records what is drawn and makes a "JPEG" whose size follows pixels x quality. It
 * also remembers the size it was encoded at, because the code under test sets it back to 0.
 */
class FakeCanvas implements CanvasLike {
  width = 0;
  height = 0;
  readonly calls: Call[] = [];
  readonly qualities: number[] = [];
  encodedAt: [number, number] | undefined;
  pixels: ImageDataLike | undefined;
  private readonly context: Context2D = {
    translate: (...args) => void this.calls.push({ name: 'translate', args }),
    rotate: (...args) => void this.calls.push({ name: 'rotate', args }),
    scale: (...args) => void this.calls.push({ name: 'scale', args }),
    setTransform: (...args) => void this.calls.push({ name: 'setTransform', args }),
    drawImage: (...args) => void this.calls.push({ name: 'drawImage', args }),
  };
  constructor(
    private readonly bytesPerPixel = 0.3,
    private readonly encode?: (size: number) => Uint8Array,
    pixels?: ImageDataLike,
  ) {
    this.pixels = pixels;
    if (pixels) this.context.getImageData = () => pixels;
  }
  getContext() {
    return this.context;
  }
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality = 1) {
    this.qualities.push(quality);
    this.encodedAt = [this.width, this.height];
    const size = Math.round(this.width * this.height * quality * this.bytesPerPixel);
    const bytes = this.encode ? this.encode(size) : new Uint8Array(size);
    callback(new Blob([bytes as BlobPart], { type }));
  }
}

function fakeEnv(
  photo: { width: number; height: number },
  options: {
    bytesPerPixel?: number;
    encode?: (size: number) => Uint8Array;
    pixels?: ImageDataLike;
  } = {},
) {
  const canvases: FakeCanvas[] = [];
  const close = vi.fn();
  const env: ImagingEnv = {
    createCanvas: () => {
      const canvas = new FakeCanvas(options.bytesPerPixel, options.encode, options.pixels);
      canvases.push(canvas);
      return canvas;
    },
    decode: async () => ({ source: 'photo', ...photo, close }),
  };
  return { env, canvases, close };
}

const draw = (canvas: FakeCanvas) => canvas.calls.find((c) => c.name === 'drawImage')?.args;
const names = (canvas: FakeCanvas) => canvas.calls.map((c) => c.name);

describe('fitWithin', () => {
  it('scales the long edge down to the limit, keeping the shape', () => {
    expect(fitWithin(4000, 3000, 2400)).toEqual({ width: 2400, height: 1800 });
    expect(fitWithin(3000, 4000, 2400)).toEqual({ width: 1800, height: 2400 });
    expect(fitWithin(3024, 4032, 2400)).toEqual({ width: 1800, height: 2400 });
  });

  it('never makes a small image bigger', () => {
    expect(fitWithin(800, 600, 2400)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(2400, 1000, 2400)).toEqual({ width: 2400, height: 1000 });
    expect(fitWithin(2401, 1000, 2400)).toEqual({ width: 2400, height: 1000 });
    expect(fitWithin(4800, 1001, 2400)).toEqual({ width: 2400, height: 501 });
  });

  it('keeps every side at least 1 px', () => {
    expect(fitWithin(10000, 2, 2400).height).toBe(1);
  });
});

describe('rotatedSize', () => {
  it('swaps the sides for a quarter turn and keeps them for a half turn', () => {
    expect(rotatedSize(400, 300, 0)).toEqual({ width: 400, height: 300 });
    expect(rotatedSize(400, 300, 90)).toEqual({ width: 300, height: 400 });
    expect(rotatedSize(400, 300, 180)).toEqual({ width: 400, height: 300 });
    expect(rotatedSize(400, 300, 270)).toEqual({ width: 300, height: 400 });
  });
});

describe('cropAndCompress: the size cap', () => {
  it('makes a JPEG whose long edge is at most 2,400 px, under the upload limit', async () => {
    const { env, canvases, close } = fakeEnv({ width: 4000, height: 3000 });

    const photo = await cropAndCompress({
      source: new Blob(['working copy']),
      area: { x: 100, y: 200, width: 3000, height: 2400 },
      rotation: 0,
      env,
    });

    expect(photo.width).toBe(2400);
    expect(photo.height).toBe(1920);
    expect(photo.blob.type).toBe('image/jpeg');
    expect(photo.blob.size).toBeGreaterThan(0);
    expect(photo.blob.size).toBeLessThanOrEqual(ANSWER_IMAGE_MAX_BYTES);
    expect(photo.quality).toBe(0.85);
    expect(FIRST_QUALITY).toBe(0.85);
    expect(UPLOAD_MAX_EDGE).toBe(2400);
    expect(canvases).toHaveLength(1); // drawn once, straight into the output canvas
    expect(canvases[0]?.encodedAt).toEqual([2400, 1920]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      { width: 6000, height: 1000 },
      { width: 2400, height: 400 },
    ],
    [
      { width: 1000, height: 6000 },
      { width: 400, height: 2400 },
    ],
    [
      { width: 3000, height: 3000 },
      { width: 2400, height: 2400 },
    ],
    [
      { width: 2400, height: 2400 },
      { width: 2400, height: 2400 },
    ],
  ])('caps %o to %o on its long edge', async (area, expected) => {
    const { env } = fakeEnv({ width: 6000, height: 6000 });
    const photo = await cropAndCompress({
      source: new Blob(['x']),
      area: { x: 0, y: 0, ...area },
      rotation: 0,
      env,
    });
    expect({ width: photo.width, height: photo.height }).toEqual(expected);
    expect(Math.max(photo.width, photo.height)).toBeLessThanOrEqual(UPLOAD_MAX_EDGE);
  });

  it('never enlarges a small crop', async () => {
    const { env } = fakeEnv({ width: 4000, height: 3000 });

    const photo = await cropAndCompress({
      source: new Blob(['x']),
      area: { x: 10, y: 10, width: 800, height: 600 },
      rotation: 0,
      env,
    });

    expect([photo.width, photo.height]).toEqual([800, 600]);
  });

  it('lowers the quality step by step until the file is small enough', async () => {
    // 2400 x 1800 at 0.3 bytes per pixel and quality q is 1,296,000 x q bytes.
    const { env, canvases } = fakeEnv({ width: 4000, height: 3000 });

    const photo = await cropAndCompress({
      source: new Blob(['x']),
      area: { x: 0, y: 0, width: 4000, height: 3000 },
      rotation: 0,
      maxBytes: 900_000,
      env,
    });

    expect(photo.quality).toBe(0.65);
    expect(photo.blob.size).toBeLessThanOrEqual(900_000);
    expect(canvases[0]?.qualities).toEqual([0.85, 0.75, 0.65]);
  });

  it('says so when even the lowest quality is too large', async () => {
    const { env } = fakeEnv({ width: 4000, height: 3000 });

    await expect(
      cropAndCompress({
        source: new Blob(['x']),
        area: { x: 0, y: 0, width: 4000, height: 3000 },
        rotation: 0,
        maxBytes: 10,
        env,
      }),
    ).rejects.toThrow(/too large to send/);
  });
});

describe('cropAndCompress: where the crop lands', () => {
  /** Applies the recorded canvas calls to a source point, the way a canvas would. */
  function through(canvas: FakeCanvas, point: { x: number; y: number }) {
    // Calls are applied to the context in order, so a point goes through them last to first.
    let { x, y } = point;
    for (const call of [...canvas.calls].reverse()) {
      const [a, b] = call.args as number[];
      if (call.name === 'translate') {
        x += a!;
        y += b!;
      } else if (call.name === 'scale') {
        x *= a!;
        y *= b!;
      } else if (call.name === 'rotate') {
        const cos = Math.cos(a!);
        const sin = Math.sin(a!);
        [x, y] = [x * cos - y * sin, x * sin + y * cos];
      }
    }
    return { x, y };
  }

  it('moves the chosen area to the corner of the output and scales it down', async () => {
    const { env, canvases } = fakeEnv({ width: 4000, height: 3000 });
    await cropAndCompress({
      source: new Blob(['x']),
      area: { x: 100, y: 200, width: 3000, height: 2400 },
      rotation: 0,
      env,
    });
    const canvas = canvases[0] as FakeCanvas;
    expect(names(canvas)).toEqual([
      'scale',
      'translate',
      'translate',
      'rotate',
      'translate',
      'drawImage',
    ]);
    expect(canvas.calls[0]?.args).toEqual([0.8, 0.8]);
    expect(draw(canvas)).toEqual(['photo', 0, 0]);
    // The area's top-left corner lands on the output's top-left, and its far corner on the far one.
    const topLeft = through(canvas, { x: 100, y: 200 });
    const bottomRight = through(canvas, { x: 3100, y: 2600 });
    expect(topLeft.x).toBeCloseTo(0, 6);
    expect(topLeft.y).toBeCloseTo(0, 6);
    expect(bottomRight.x).toBeCloseTo(2400, 6);
    expect(bottomRight.y).toBeCloseTo(1920, 6);
  });

  it('turns a quarter first: the photo 4000 x 3000 becomes 3000 x 4000 and the corners follow', async () => {
    const { env, canvases } = fakeEnv({ width: 4000, height: 3000 });
    await cropAndCompress({
      source: new Blob(['x']),
      area: { x: 0, y: 0, width: 3000, height: 4000 },
      rotation: 90,
      env,
    });
    const canvas = canvases[0] as FakeCanvas;
    expect(canvas.calls.find((c) => c.name === 'rotate')?.args[0]).toBeCloseTo(Math.PI / 2);
    expect(canvas.encodedAt).toEqual([1800, 2400]); // portrait
    // Turned clockwise, the photo's top-left corner ends up at the top-right of the output.
    const topLeft = through(canvas, { x: 0, y: 0 });
    expect(topLeft.x).toBeCloseTo(1800, 6);
    expect(topLeft.y).toBeCloseTo(0, 6);
    const bottomRight = through(canvas, { x: 4000, y: 3000 });
    expect(bottomRight.x).toBeCloseTo(0, 6);
    expect(bottomRight.y).toBeCloseTo(2400, 6);
  });

  it('keeps the area inside the photo', async () => {
    const { env, canvases } = fakeEnv({ width: 1000, height: 500 });

    await cropAndCompress({
      source: new Blob(['x']),
      area: { x: 900, y: 450, width: 400, height: 400 },
      rotation: 0,
      env,
    });

    const canvas = canvases[0] as FakeCanvas;
    expect(canvas.encodedAt).toEqual([100, 50]);
    expect(canvas.calls.filter((c) => c.name === 'translate')[0]?.args).toEqual([-900, -450]);
  });

  it('gives the canvas back when it is done, even when it fails', async () => {
    const { env, canvases } = fakeEnv({ width: 4000, height: 3000 });
    await cropAndCompress({
      source: new Blob(['x']),
      area: { x: 0, y: 0, width: 4000, height: 3000 },
      rotation: 0,
      env,
    });
    expect([canvases[0]?.width, canvases[0]?.height]).toEqual([0, 0]);

    const failing = fakeEnv({ width: 4000, height: 3000 });
    await expect(
      cropAndCompress({
        source: new Blob(['x']),
        area: { x: 0, y: 0, width: 4000, height: 3000 },
        rotation: 0,
        maxBytes: 1,
        env: failing.env,
      }),
    ).rejects.toBeInstanceOf(ImagingError);
    expect([failing.canvases[0]?.width, failing.canvases[0]?.height]).toEqual([0, 0]);
    expect(failing.close).toHaveBeenCalled();
  });

  it('asks for a crop when the area is empty, and explains a photo that cannot be opened', async () => {
    const { env } = fakeEnv({ width: 100, height: 100 });
    await expect(
      cropAndCompress({
        source: new Blob(['x']),
        area: { x: 0, y: 0, width: 0, height: 0 },
        rotation: 0,
        env,
      }),
    ).rejects.toBeInstanceOf(ImagingError);

    const broken: ImagingEnv = {
      createCanvas: () => new FakeCanvas(),
      decode: async () => {
        throw new Error('bad image');
      },
    };
    await expect(
      cropAndCompress({
        source: new Blob(['x']),
        area: { x: 0, y: 0, width: 10, height: 10 },
        rotation: 0,
        env: broken,
      }),
    ).rejects.toThrow(/Try taking it again/);
  });
});

describe('metadata never leaves with the photo', () => {
  const withGps = makeJpeg({ orientation: 6, gps: true });

  it('strips EXIF and the GPS location from what the canvas wrote, if it wrote any', async () => {
    const { env } = fakeEnv(
      { width: 4000, height: 3000 },
      { encode: (size) => new Uint8Array([...withGps, ...new Uint8Array(size)]) },
    );

    const photo = await cropAndCompress({
      source: new Blob(['x']),
      area: { x: 0, y: 0, width: 4000, height: 3000 },
      rotation: 0,
      env,
    });

    const bytes = new Uint8Array(await photo.blob.arrayBuffer());
    expect(hasMetadata(bytes)).toBe(false);
    expect(String.fromCharCode(...bytes.subarray(0, 400))).not.toContain('Exif');
    expect(photo.blob.type).toBe('image/jpeg');
  });

  it('hands back a photo with no metadata as the very same blob', async () => {
    const clean = new Blob([makeJpeg()], { type: 'image/jpeg' });
    expect(await withoutMetadata(clean)).toBe(clean);
    const dirty = await withoutMetadata(new Blob([withGps], { type: 'image/jpeg' }));
    expect(hasMetadata(new Uint8Array(await dirty.arrayBuffer()))).toBe(false);
  });
});

describe('prepareImage', () => {
  it('makes a JPEG working copy no bigger than 3,200 px on its long side', async () => {
    const { env, canvases, close } = fakeEnv({ width: 6000, height: 4000 });

    const prepared = await prepareImage(new Blob(['camera photo']), env);

    expect([prepared.width, prepared.height]).toEqual([3200, 2133]);
    expect(prepared.blob.type).toBe('image/jpeg');
    // The canvas is made at the small size and the photo drawn straight into it.
    expect(canvases[0]?.encodedAt).toEqual([3200, 2133]);
    expect(draw(canvases[0] as FakeCanvas)).toEqual(['photo', 0, 0, 3200, 2133]);
    expect(close).toHaveBeenCalled();
    expect(WORKING_MAX_EDGE).toBe(3200);
  });

  it('keeps a smaller photo at its own size', async () => {
    const { env } = fakeEnv({ width: 1600, height: 1200 });

    const prepared = await prepareImage(new Blob(['x']), env);

    expect([prepared.width, prepared.height]).toEqual([1600, 1200]);
  });

  it('gives the canvas back afterwards', async () => {
    const { env, canvases } = fakeEnv({ width: 3000, height: 2000 });
    await prepareImage(new Blob(['x']), env);
    expect([canvases[0]?.width, canvases[0]?.height]).toEqual([0, 0]);
  });

  it('explains a file that is not a photo', async () => {
    const env: ImagingEnv = {
      createCanvas: () => new FakeCanvas(),
      decode: async () => {
        throw new Error('not an image');
      },
    };

    await expect(prepareImage(new Blob(['x']), env)).rejects.toThrow(/Choose a JPEG or PNG/);
  });
});

describe('prepareImage: sideways phone photos', () => {
  const sideways = new Blob([makeJpeg({ orientation: 6, width: 4032, height: 3024 })], {
    type: 'image/jpeg',
  });

  it('leaves a photo alone when the browser has already turned it upright', async () => {
    // Stored 4032 x 3024 with "turn a quarter": the browser reports the upright 3024 x 4032.
    const { env, canvases } = fakeEnv({ width: 3024, height: 4032 });

    const prepared = await prepareImage(sideways, env);

    expect([prepared.width, prepared.height]).toEqual([2400, 3200]);
    expect(names(canvases[0] as FakeCanvas)).toEqual(['drawImage']);
  });

  it('turns it itself when the browser left it on its side', async () => {
    // The browser reports the stored 4032 x 3024: still sideways.
    const { env, canvases } = fakeEnv({ width: 4032, height: 3024 });

    const prepared = await prepareImage(sideways, env);

    expect([prepared.width, prepared.height]).toEqual([2400, 3200]);
    const canvas = canvases[0] as FakeCanvas;
    expect(names(canvas)).toEqual(['setTransform', 'drawImage']);
    const k = 2400 / 3024;
    const [a, b, c, d, e, f] = canvas.calls[0]?.args as number[];
    // Orientation 6 (turn a quarter clockwise): x' = -y + height, y' = x, all scaled to the copy.
    expect(a).toBe(0);
    expect(b).toBeCloseTo(k, 9);
    expect(c).toBeCloseTo(-k, 9);
    expect(d).toBe(0);
    expect(f).toBe(0);
    expect(e).toBeCloseTo(3024 * k, 6);
  });

  it('does not turn a photo that needs no turning, or a PNG', async () => {
    const upright = new Blob([makeJpeg({ orientation: 1, width: 4032, height: 3024 })]);
    const a = fakeEnv({ width: 4032, height: 3024 });
    await prepareImage(upright, a.env);
    expect(names(a.canvases[0] as FakeCanvas)).toEqual(['drawImage']);

    const png = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])]);
    const b = fakeEnv({ width: 4032, height: 3024 });
    await prepareImage(png, b.env);
    expect(names(b.canvases[0] as FakeCanvas)).toEqual(['drawImage']);
  });
});

describe('suggestCrop', () => {
  /** A 100 x 100 sample with a light page in the middle of a dark table. */
  const pixels: ImageDataLike = (() => {
    const data = new Uint8ClampedArray(100 * 100 * 4);
    for (let y = 0; y < 100; y += 1) {
      for (let x = 0; x < 100; x += 1) {
        const page = x >= 20 && x < 80 && y >= 10 && y < 90;
        data.set(page ? [230, 230, 230, 255] : [40, 40, 40, 255], (y * 100 + x) * 4);
      }
    }
    return { data, width: 100, height: 100 };
  })();

  it('gives the page edges in pixels of the working copy', async () => {
    const { env, canvases } = fakeEnv({ width: 3000, height: 3000 }, { pixels });
    const box = await suggestCrop(new Blob(['x']), { width: 3000, height: 3000 }, env);

    expect(box).not.toBeNull();
    expect(box!.x).toBeCloseTo(0.19 * 3000, -2);
    expect(box!.width).toBeCloseTo(0.62 * 3000, -2);
    expect([canvases[0]?.width, canvases[0]?.height]).toEqual([0, 0]); // released
  });

  it('says null when the browser cannot read pixels, or the photo cannot be opened', async () => {
    const plain = fakeEnv({ width: 3000, height: 2000 });
    expect(await suggestCrop(new Blob(['x']), { width: 3000, height: 2000 }, plain.env)).toBeNull();

    const broken: ImagingEnv = {
      createCanvas: () => new FakeCanvas(),
      decode: async () => {
        throw new Error('nope');
      },
    };
    expect(await suggestCrop(new Blob(['x']), { width: 10, height: 10 }, broken)).toBeNull();
  });
});
