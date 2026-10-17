import { ANSWER_IMAGE_MAX_BYTES, ANSWER_IMAGE_TYPE } from '@yulove/shared';

/** The longest side of a photo sent for grading (docs/DESIGN.md: "long edge about 2,000 px"). */
export const UPLOAD_MAX_EDGE = 2000;
/** The longest side of the working copy the crop screen uses: big enough to crop, small enough for a phone. */
export const WORKING_MAX_EDGE = 3200;

const FIRST_QUALITY = 0.85;
const WORKING_QUALITY = 0.92;
const QUALITY_STEP = 0.1;
const MIN_QUALITY = 0.4;

export interface Size {
  width: number;
  height: number;
}

/** A crop area in pixels of the (rotated) working image, as react-easy-crop reports it. */
export interface CropArea extends Size {
  x: number;
  y: number;
}

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
  drawImage(source: unknown, ...args: number[]): void;
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
  /** Decodes a photo, with its camera rotation (EXIF) already applied. */
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

/**
 * Makes the working copy the crop screen shows: the photo with its camera rotation applied, scaled
 * down to at most 3,200 px on its long side, as a JPEG. A 12 MP phone photo becomes about 8 MP, so
 * the crop and rotate steps stay light on a phone.
 */
export async function prepareImage(
  file: Blob,
  env: ImagingEnv = browserImaging,
): Promise<{ blob: Blob } & Size> {
  let decoded: DecodedImage;
  try {
    decoded = await env.decode(file);
  } catch {
    throw new ImagingError('That file could not be opened as a photo. Choose a JPEG or PNG image.');
  }
  try {
    const size = fitWithin(decoded.width, decoded.height, WORKING_MAX_EDGE);
    const canvas = env.createCanvas();
    canvas.width = size.width;
    canvas.height = size.height;
    context(canvas).drawImage(decoded.source, 0, 0, size.width, size.height);
    return { blob: await toJpeg(canvas, WORKING_QUALITY), ...size };
  } finally {
    decoded.close();
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
  /** A multiple of 90, clockwise, the same value the crop screen used. */
  rotation: number;
  maxEdge?: number;
  maxBytes?: number;
  env?: ImagingEnv;
}

/**
 * Cuts the chosen area out of the (rotated) photo and compresses it to a JPEG whose long side is at
 * most 2,000 px (never enlarged). The quality starts at 0.85 and steps down until the file is under
 * the upload limit.
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

  try {
    // The whole photo, turned, on a canvas the size of the turned photo.
    const turned = rotatedSize(decoded.width, decoded.height, rotation);
    const full = env.createCanvas();
    full.width = turned.width;
    full.height = turned.height;
    const fullCtx = context(full);
    fullCtx.translate(turned.width / 2, turned.height / 2);
    fullCtx.rotate((rotation * Math.PI) / 180);
    fullCtx.translate(-decoded.width / 2, -decoded.height / 2);
    fullCtx.drawImage(decoded.source, 0, 0);

    // The chosen area, kept inside the photo, scaled to the upload size.
    const x = Math.max(0, Math.min(Math.round(area.x), turned.width - 1));
    const y = Math.max(0, Math.min(Math.round(area.y), turned.height - 1));
    const width = Math.max(1, Math.min(Math.round(area.width), turned.width - x));
    const height = Math.max(1, Math.min(Math.round(area.height), turned.height - y));
    const out = fitWithin(width, height, maxEdge);

    const canvas = env.createCanvas();
    canvas.width = out.width;
    canvas.height = out.height;
    context(canvas).drawImage(full, x, y, width, height, 0, 0, out.width, out.height);

    for (let quality = FIRST_QUALITY; quality >= MIN_QUALITY - 1e-9; quality -= QUALITY_STEP) {
      const blob = await toJpeg(canvas, Math.round(quality * 100) / 100);
      if (blob.size <= maxBytes) {
        return { blob, quality: Math.round(quality * 100) / 100, ...out };
      }
    }
    throw new ImagingError(
      'The photo is too large to send. Move closer to the page and retake it.',
    );
  } finally {
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
