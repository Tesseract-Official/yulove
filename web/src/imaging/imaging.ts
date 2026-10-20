import { ANSWER_IMAGE_MAX_BYTES, ANSWER_IMAGE_TYPE } from '@yulove/shared';
import type { Box } from './cropMath.js';
import {
  hasMetadata,
  needsManualTurn,
  orientationTransform,
  readJpegInfo,
  stripJpegMetadata,
  type JpegInfo,
} from './exif.js';
import { DETECT_EDGE, detectPageBox } from './pageDetect.js';

/** The longest side of a photo sent for grading (docs/DESIGN.md: "long edge up to 2,400 px"). */
export const UPLOAD_MAX_EDGE = 2400;
/**
 * The longest side of the working copy the crop screen uses: big enough to crop and zoom into, and
 * small enough (about 8 MP) for a phone's canvas limits.
 */
export const WORKING_MAX_EDGE = 3200;

/** Where the quality starts for a photo that is sent. */
export const FIRST_QUALITY = 0.85;
const WORKING_QUALITY = 0.92;
const QUALITY_STEP = 0.1;
const MIN_QUALITY = 0.4;
/** How much of the start of a photo is read to find its camera orientation and size. */
const HEAD_BYTES = 256 * 1024;

export interface Size {
  width: number;
  height: number;
}

/** A crop area in pixels of the (turned) working image. */
export type CropArea = Box;

/** The size of an image after it is scaled down to fit `maxEdge` on its long side. Never scales up. */
export function fitWithin(width: number, height: number, maxEdge: number): Size {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The size of an image turned by a multiple of 90 degrees. */
export function rotatedSize(width: number, height: number, rotation: number): Size {
  const quarterTurns = Math.round(rotation / 90);
  return quarterTurns % 2 === 0 ? { width, height } : { width: height, height: width };
}

// What the code needs from a canvas and an image, so tests can stand in for the browser.
export interface Context2D {
  translate(x: number, y: number): void;
  rotate(radians: number): void;
  scale(x: number, y: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  drawImage(source: unknown, ...args: number[]): void;
  getImageData?(x: number, y: number, width: number, height: number): ImageDataLike;
}

export interface ImageDataLike {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): Context2D | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

export interface DecodedImage {
  source: unknown;
  width: number;
  height: number;
  /** Frees the decoded pixels. */
  close(): void;
}

export interface ImagingEnv {
  createCanvas(): CanvasLike;
  /** Decodes a photo, asking the browser to apply its camera rotation (EXIF). */
  decode(blob: Blob): Promise<DecodedImage>;
}

/** The photo could not be prepared; the message says what to do. */
export class ImagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImagingError';
  }
}

function context(canvas: CanvasLike): Context2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImagingError('This browser cannot prepare photos. Try another browser.');
  return ctx;
}

/**
 * Gives a canvas's memory back. iOS Safari keeps the pixels of a canvas that is simply dropped
 * until it feels like collecting it, and a few forgotten photo-sized canvases are enough to make
 * the next one fail.
 */
function release(canvas: CanvasLike): void {
  canvas.width = 0;
  canvas.height = 0;
}

function toJpeg(canvas: CanvasLike, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new ImagingError('The photo could not be prepared. Try taking it again.')),
      ANSWER_IMAGE_TYPE,
      quality,
    );
  });
}

/** Camera orientation and stored size, from the first bytes of the file; upright if unreadable. */
async function readInfo(file: Blob): Promise<JpegInfo> {
  try {
    if (typeof file.slice !== 'function') return { orientation: 1 };
    const head = file.slice(0, HEAD_BYTES);
    if (typeof head.arrayBuffer !== 'function') return { orientation: 1 };
    return readJpegInfo(new Uint8Array(await head.arrayBuffer()));
  } catch {
    return { orientation: 1 };
  }
}

/**
 * Takes any EXIF or other metadata (the GPS location above all) out of a JPEG. The canvas already
 * writes none, so this normally changes nothing; it is a safety net in case a browser keeps some.
 */
export async function withoutMetadata(blob: Blob): Promise<Blob> {
  try {
    if (typeof blob.slice !== 'function' || typeof blob.arrayBuffer !== 'function') return blob;
    const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
    if (!hasMetadata(head)) return blob;
    const clean = stripJpegMetadata(new Uint8Array(await blob.arrayBuffer()));
    // Copied into a fresh buffer so the Blob never aliases a view of something else.
    return new Blob([clean.slice().buffer], { type: ANSWER_IMAGE_TYPE });
  } catch {
    return blob;
  }
}

/**
 * Makes the working copy the screen shows: the photo upright (the camera's EXIF rotation applied,
 * by the browser or, if it did not, by us), scaled down to at most 3,200 px on its long side, as a
 * JPEG. The canvas is created at the reduced size and the photo is drawn straight into it, so a
 * 12 MP camera photo is never copied at full size, and the canvas is released afterwards.
 */
export async function prepareImage(
  file: Blob,
  env: ImagingEnv = browserImaging,
): Promise<{ blob: Blob } & Size> {
  const info = await readInfo(file);
  let decoded: DecodedImage;
  try {
    decoded = await env.decode(file);
  } catch {
    throw new ImagingError('That file could not be opened as a photo. Choose a JPEG or PNG image.');
  }
  let canvas: CanvasLike | undefined;
  try {
    // A browser that left a quarter-turned photo on its side gets it turned here.
    const turn = needsManualTurn(info, decoded)
      ? orientationTransform(info.orientation, decoded.width, decoded.height)
      : undefined;
    const upright = turn ?? decoded;
    const size = fitWithin(upright.width, upright.height, WORKING_MAX_EDGE);

    canvas = env.createCanvas();
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = context(canvas);
    if (turn) {
      const k = size.width / turn.width;
      const [a, b, c, d, e, f] = turn.matrix;
      ctx.setTransform(a * k, b * k, c * k, d * k, e * k, f * k);
      ctx.drawImage(decoded.source, 0, 0);
    } else {
      ctx.drawImage(decoded.source, 0, 0, size.width, size.height);
    }
    return { blob: await toJpeg(canvas, WORKING_QUALITY), ...size };
  } finally {
    if (canvas) release(canvas);
    decoded.close();
  }
}

/**
 * Looks for the page in the working copy and gives its edges as a crop box in pixels of the
 * working copy, or null when it cannot tell (the caller then starts from the whole photo).
 */
export async function suggestCrop(
  working: Blob,
  size: Size,
  env: ImagingEnv = browserImaging,
): Promise<Box | null> {
  let decoded: DecodedImage | undefined;
  let canvas: CanvasLike | undefined;
  try {
    decoded = await env.decode(working);
    const small = fitWithin(size.width, size.height, DETECT_EDGE);
    canvas = env.createCanvas();
    canvas.width = small.width;
    canvas.height = small.height;
    const ctx = context(canvas);
    if (!ctx.getImageData) return null;
    ctx.drawImage(decoded.source, 0, 0, small.width, small.height);
    const found = detectPageBox(ctx.getImageData(0, 0, small.width, small.height));
    if (!found) return null;
    return {
      x: found.x * size.width,
      y: found.y * size.height,
      width: found.width * size.width,
      height: found.height * size.height,
    };
  } catch {
    return null;
  } finally {
    if (canvas) release(canvas);
    decoded?.close();
  }
}

export interface CompressedPhoto extends Size {
  blob: Blob;
  quality: number;
}

export interface CropAndCompressOptions {
  /** The working copy from prepareImage. */
  source: Blob;
  area: CropArea;
  /** A multiple of 90, clockwise: how far the photo has been turned on the screen. */
  rotation: number;
  maxEdge?: number;
  maxBytes?: number;
  env?: ImagingEnv;
}

/**
 * Cuts the chosen area out of the (turned) photo and compresses it to a JPEG whose long side is at
 * most 2,400 px (never enlarged). The quality starts at 0.85 and steps down until the file is under
 * the upload limit. The photo is drawn once, straight into a canvas of the final size, and the
 * result carries no metadata.
 */
export async function cropAndCompress({
  source,
  area,
  rotation,
  maxEdge = UPLOAD_MAX_EDGE,
  maxBytes = ANSWER_IMAGE_MAX_BYTES,
  env = browserImaging,
}: CropAndCompressOptions): Promise<CompressedPhoto> {
  if (area.width < 1 || area.height < 1) {
    throw new ImagingError('Choose the part of the page to send, then try again.');
  }
  let decoded: DecodedImage;
  try {
    decoded = await env.decode(source);
  } catch {
    throw new ImagingError('The photo could not be prepared. Try taking it again.');
  }

  let canvas: CanvasLike | undefined;
  try {
    const turned = rotatedSize(decoded.width, decoded.height, rotation);

    // The chosen area, kept inside the photo, scaled to the upload size.
    const x = Math.max(0, Math.min(Math.round(area.x), turned.width - 1));
    const y = Math.max(0, Math.min(Math.round(area.y), turned.height - 1));
    const width = Math.max(1, Math.min(Math.round(area.width), turned.width - x));
    const height = Math.max(1, Math.min(Math.round(area.height), turned.height - y));
    const out = fitWithin(width, height, maxEdge);

    canvas = env.createCanvas();
    canvas.width = out.width;
    canvas.height = out.height;
    const ctx = context(canvas);
    // Scale down to the output size, move the chosen area to the corner, then turn the photo
    // about the middle of the turned photo and draw it.
    ctx.scale(out.width / width, out.height / height);
    ctx.translate(-x, -y);
    ctx.translate(turned.width / 2, turned.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(-decoded.width / 2, -decoded.height / 2);
    ctx.drawImage(decoded.source, 0, 0);

    for (let quality = FIRST_QUALITY; quality >= MIN_QUALITY - 1e-9; quality -= QUALITY_STEP) {
      const rounded = Math.round(quality * 100) / 100;
      const blob = await withoutMetadata(await toJpeg(canvas, rounded));
      if (blob.size <= maxBytes) return { blob, quality: rounded, ...out };
    }
    throw new ImagingError(
      'The photo is too large to send. Move closer to the page and retake it.',
    );
  } finally {
    if (canvas) release(canvas);
    decoded.close();
  }
}

/** The real thing: a canvas element, and createImageBitmap (or an <img>) to decode photos. */
export const browserImaging: ImagingEnv = {
  createCanvas: () => document.createElement('canvas') as unknown as CanvasLike,

  async decode(blob) {
    // 'from-image' turns the photo upright the way the camera meant it.
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          close: () => bitmap.close(),
        };
      } catch {
        // Older browsers: fall through to an <img>, which applies the orientation itself.
      }
    }
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => undefined,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  },
};
