/**
 * The little bit of JPEG parsing the photo flow needs: which way up the camera says the picture is
 * (EXIF orientation), how big it really is, and a way to make sure no metadata (for example the
 * GPS location) travels with a photo. Pure functions on bytes, so they are easy to test.
 */

/** EXIF orientation: 1 is upright; 3 is upside down; 6 and 8 are turned a quarter. */
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface JpegInfo {
  /** 1 when the photo has no orientation tag (or is not a JPEG). */
  orientation: Orientation;
  /** The stored pixel size, before any orientation is applied; absent when not found. */
  width?: number;
  height?: number;
}

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;

/** Markers that stand alone, with no length after them. */
const isStandalone = (marker: number) =>
  marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8) || marker === EOI;

/** Start-of-frame markers, which hold the picture size (not DHT 0xC4, JPG 0xC8 or DAC 0xCC). */
const isFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

const isJpeg = (bytes: Uint8Array) => bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === SOI;

function orientationFromExif(bytes: Uint8Array, start: number, end: number): Orientation {
  // "Exif\0\0", then a TIFF header: byte order, 42, offset of the first directory.
  const tiff = start + 6;
  if (tiff + 8 > end) return 1;
  const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  if (!big && !little) return 1;

  const u16 = (at: number) =>
    at + 2 > end
      ? -1
      : big
        ? (bytes[at]! << 8) | bytes[at + 1]!
        : bytes[at]! | (bytes[at + 1]! << 8);
  const u32 = (at: number) =>
    at + 4 > end
      ? -1
      : big
        ? ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>>
          0
        : (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>>
          0;

  if (u16(tiff + 2) !== 42) return 1;
  const directory = u32(tiff + 4);
  if (directory < 0) return 1;
  const entries = u16(tiff + directory);
  if (entries < 0) return 1;
  for (let i = 0; i < entries; i += 1) {
    const entry = tiff + directory + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? (value as Orientation) : 1;
    }
  }
  return 1;
}

/**
 * Reads the orientation and stored size of a JPEG from its first bytes. Never throws: anything it
 * cannot read gives orientation 1 and no size.
 */
export function readJpegInfo(bytes: Uint8Array): JpegInfo {
  const info: JpegInfo = { orientation: 1 };
  if (!isJpeg(bytes)) return info;

  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) break;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1; // padding
      continue;
    }
    if (isStandalone(marker)) {
      at += 2;
      continue;
    }
    if (marker === SOS) break;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (length < 2) break;
    const end = Math.min(bytes.length, at + 2 + length);

    if (marker === 0xe1 && info.orientation === 1) {
      const isExif =
        bytes[at + 4] === 0x45 && // E
        bytes[at + 5] === 0x78 && // x
        bytes[at + 6] === 0x69 && // i
        bytes[at + 7] === 0x66 && // f
        bytes[at + 8] === 0 &&
        bytes[at + 9] === 0;
      if (isExif) info.orientation = orientationFromExif(bytes, at + 4, end);
    } else if (isFrame(marker) && at + 9 <= bytes.length) {
      // Precision (1 byte), then height and width (2 bytes each).
      info.height = (bytes[at + 5]! << 8) | bytes[at + 6]!;
      info.width = (bytes[at + 7]! << 8) | bytes[at + 8]!;
      break;
    }
    at += 2 + length;
  }
  return info;
}

export const readExifOrientation = (bytes: Uint8Array): Orientation =>
  readJpegInfo(bytes).orientation;

/** Orientations that turn the picture a quarter, so width and height swap. */
export const swapsSides = (orientation: Orientation): boolean => orientation >= 5;

export interface OrientationTransform {
  /** The size of the upright picture. */
  width: number;
  height: number;
  /** Arguments for `ctx.setTransform` to draw the stored picture upright. */
  matrix: [number, number, number, number, number, number];
}

/** How to draw a w x h stored picture so that it ends up the right way up. */
export function orientationTransform(
  orientation: Orientation,
  w: number,
  h: number,
): OrientationTransform {
  switch (orientation) {
    case 2:
      return { width: w, height: h, matrix: [-1, 0, 0, 1, w, 0] };
    case 3:
      return { width: w, height: h, matrix: [-1, 0, 0, -1, w, h] };
    case 4:
      return { width: w, height: h, matrix: [1, 0, 0, -1, 0, h] };
    case 5:
      return { width: h, height: w, matrix: [0, 1, 1, 0, 0, 0] };
    case 6:
      return { width: h, height: w, matrix: [0, 1, -1, 0, h, 0] };
    case 7:
      return { width: h, height: w, matrix: [0, -1, -1, 0, h, w] };
    case 8:
      return { width: h, height: w, matrix: [0, -1, 1, 0, 0, w] };
    default:
      return { width: w, height: h, matrix: [1, 0, 0, 1, 0, 0] };
  }
}

/**
 * Whether the browser, which was asked to give the picture upright, in fact left a quarter-turned
 * photo on its side: the decoded size is still the stored size although the camera says to turn it.
 * (Only quarter turns can be told apart this way.)
 */
export function needsManualTurn(
  info: JpegInfo,
  decoded: { width: number; height: number },
): boolean {
  if (!swapsSides(info.orientation) || info.width === undefined || info.height === undefined) {
    return false;
  }
  if (info.width === info.height) return false;
  return decoded.width === info.width && decoded.height === info.height;
}

/** Whether the JPEG carries any metadata segment (EXIF with GPS, XMP, IPTC, comments, ...). */
export function hasMetadata(bytes: Uint8Array): boolean {
  return stripJpegMetadata(bytes).length !== bytes.length;
}

/**
 * Removes every application segment except the JFIF header (APP0) and every comment from a JPEG:
 * that is where the camera's EXIF (including the GPS location), XMP and IPTC live. The picture is
 * untouched. Anything that is not a well-formed JPEG is returned as it was.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (!isJpeg(bytes)) return bytes;

  const kept: Array<[number, number]> = [[0, 2]];
  let at = 2;
  while (at + 2 <= bytes.length) {
    if (bytes[at] !== 0xff) return bytes; // not a segment: leave the file alone
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === SOS) {
      kept.push([at, bytes.length]); // the picture data runs to the end
      at = bytes.length;
      break;
    }
    if (isStandalone(marker)) {
      kept.push([at, at + 2]);
      at += 2;
      continue;
    }
    if (at + 4 > bytes.length) return bytes;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (length < 2 || at + 2 + length > bytes.length) return bytes;
    const dropped = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!dropped) kept.push([at, at + 2 + length]);
    at += 2 + length;
  }
  if (at !== bytes.length) return bytes;

  const size = kept.reduce((sum, [from, to]) => sum + (to - from), 0);
  if (size === bytes.length) return bytes;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const [from, to] of kept) {
    out.set(bytes.subarray(from, to), offset);
    offset += to - from;
  }
  return out;
}
