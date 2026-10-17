// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ANSWER_IMAGE_MAX_BYTES } from '@yulove/shared';
import {
  ImagingError,
  UPLOAD_MAX_EDGE,
  WORKING_MAX_EDGE,
  cropAndCompress,
  fitWithin,
  prepareImage,
  rotatedSize,
  type CanvasLike,
  type Context2D,
  type ImagingEnv,
} from './imaging.js';

/** A canvas that records what is drawn and makes a "JPEG" whose size follows pixels × quality. */
class FakeCanvas implements CanvasLike {
  width = 0;
  height = 0;
  readonly calls: Array<{ name: string; args: unknown[] }> = [];
  readonly qualities: number[] = [];
  private readonly context: Context2D = {
    translate: (...args) => void this.calls.push({ name: 'translate', args }),
    rotate: (...args) => void this.calls.push({ name: 'rotate', args }),
    drawImage: (...args) => void this.calls.push({ name: 'drawImage', args }),
  };
  constructor(private readonly bytesPerPixel = 0.3) {}
  getContext() {
    return this.context;
  }
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality = 1) {
    this.qualities.push(quality);
    const size = Math.round(this.width * this.height * quality * this.bytesPerPixel);
    callback(new Blob([new Uint8Array(size)], { type }));
  }
}

function fakeEnv(photo: { width: number; height: number }, bytesPerPixel?: number) {
  const canvases: FakeCanvas[] = [];
  const close = vi.fn();
  const env: ImagingEnv = {
    createCanvas: () => {
      const canvas = new FakeCanvas(bytesPerPixel);
      canvases.push(canvas);
      return canvas;
    },
    decode: async () => ({ source: 'photo', ...photo, close }),
  };
  return { env, canvases, close };
}

const draw = (canvas: FakeCanvas) => canvas.calls.find((c) => c.name === 'drawImage')?.args;

describe('fitWithin', () => {
  it('scales the long edge down to the limit, keeping the shape', () => {
    expect(fitWithin(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(3000, 4000, 2000)).toEqual({ width: 1500, height: 2000 });
    expect(fitWithin(3024, 4032, 2000)).toEqual({ width: 1500, height: 2000 });
  });

  it('never makes a small image bigger', () => {
    expect(fitWithin(800, 600, 2000)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(2000, 1000, 2000)).toEqual({ width: 2000, height: 1000 });
  });

  it('keeps every side at least 1 px', () => {
    expect(fitWithin(10000, 2, 2000).height).toBe(1);
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

describe('cropAndCompress', () => {
  it('makes a JPEG whose long edge is 2,000 px, under the upload limit', async () => {
    const { env, canvases, close } = fakeEnv({ width: 4000, height: 3000 });

    const photo = await cropAndCompress({
      source: new Blob(['working copy']),
      area: { x: 100, y: 200, width: 3000, height: 2400 },
      rotation: 0,
      env,
    });

    expect(photo.width).toBe(2000);
    expect(photo.height).toBe(1600);
    expect(photo.blob.type).toBe('image/jpeg');
    expect(photo.blob.size).toBeGreaterThan(0);
    expect(photo.blob.size).toBeLessThanOrEqual(ANSWER_IMAGE_MAX_BYTES);
    expect(photo.quality).toBe(0.85);
    // The output canvas has exactly that size, and the chosen area was copied onto it.
    const output = canvases[1] as FakeCanvas;
    expect([output.width, output.height]).toEqual([2000, 1600]);
    expect(draw(output)).toEqual([canvases[0], 100, 200, 3000, 2400, 0, 0, 2000, 1600]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(UPLOAD_MAX_EDGE).toBe(2000);
  });

  it('turns the photo first: a quarter turn swaps the canvas sides and rotates by 90°', async () => {
    const { env, canvases } = fakeEnv({ width: 4000, height: 3000 });

    await cropAndCompress({
      source: new Blob(['x']),
      area: { x: 0, y: 0, width: 3000, height: 4000 },
      rotation: 90,
      env,
    });

    const turned = canvases[0] as FakeCanvas;
    expect([turned.width, turned.height]).toEqual([3000, 4000]);
    const rotate = turned.calls.find((c) => c.name === 'rotate');
    expect(rotate?.args[0]).toBeCloseTo(Math.PI / 2);
    // The result is portrait: 1500 × 2000.
    expect([(canvases[1] as FakeCanvas).width, (canvases[1] as FakeCanvas).height]).toEqual([
      1500, 2000,
    ]);
  });

  it('does not enlarge a small crop', async () => {
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
    // 2000 × 1500 at 0.3 bytes per pixel and quality q is 900,000 × q bytes.
    const { env, canvases } = fakeEnv({ width: 4000, height: 3000 });

    const photo = await cropAndCompress({
      source: new Blob(['x']),
      area: { x: 0, y: 0, width: 4000, height: 3000 },
      rotation: 0,
      maxBytes: 600_000,
      env,
    });

    expect(photo.quality).toBe(0.65);
    expect(photo.blob.size).toBeLessThanOrEqual(600_000);
    expect((canvases[1] as FakeCanvas).qualities).toEqual([0.85, 0.75, 0.65]);
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

  it('keeps the area inside the photo', async () => {
    const { env, canvases } = fakeEnv({ width: 1000, height: 500 });

    await cropAndCompress({
      source: new Blob(['x']),
      area: { x: 900, y: 450, width: 400, height: 400 },
      rotation: 0,
      env,
    });

    expect(draw(canvases[1] as FakeCanvas)).toEqual([
      canvases[0],
      900,
      450,
      100,
      50,
      0,
      0,
      100,
      50,
    ]);
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

describe('prepareImage', () => {
  it('makes a JPEG working copy no bigger than 3,200 px on its long side', async () => {
    const { env, canvases, close } = fakeEnv({ width: 6000, height: 4000 });

    const prepared = await prepareImage(new Blob(['camera photo']), env);

    expect([prepared.width, prepared.height]).toEqual([3200, 2133]);
    expect(prepared.blob.type).toBe('image/jpeg');
    expect(draw(canvases[0] as FakeCanvas)).toEqual(['photo', 0, 0, 3200, 2133]);
    expect(close).toHaveBeenCalled();
    expect(WORKING_MAX_EDGE).toBe(3200);
  });

  it('keeps a smaller photo at its own size', async () => {
    const { env } = fakeEnv({ width: 1600, height: 1200 });

    const prepared = await prepareImage(new Blob(['x']), env);

    expect([prepared.width, prepared.height]).toEqual([1600, 1200]);
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
