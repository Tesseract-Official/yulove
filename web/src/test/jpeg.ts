/** Builds small, well-formed JPEG byte strings for tests (header segments plus fake picture data). */

const segment = (marker: number, body: number[]): number[] => [
  0xff,
  marker,
  (body.length + 2) >> 8,
  (body.length + 2) & 0xff,
  ...body,
];

function exifSegment(orientation: number, gps: boolean): number[] {
  const entry = (tag: number, type: number, value: number) => [
    tag >> 8,
    tag & 0xff,
    0,
    type,
    0,
    0,
    0,
    1,
    ...(type === 3 ? [value >> 8, value & 0xff, 0, 0] : [0, 0, value >> 8, value & 0xff]),
  ];
  const entries = [entry(0x0112, 3, orientation), ...(gps ? [entry(0x8825, 4, 0x1234)] : [])];
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, entries.length, ...entries.flat(), 0, 0, 0, 0];
  return segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
}

export interface JpegOptions {
  /** EXIF orientation 1-8; no EXIF at all when left out. */
  orientation?: number;
  /** Add a GPS pointer to the EXIF. */
  gps?: boolean;
  width?: number;
  height?: number;
  /** Extra picture bytes, to make a bigger file. */
  padding?: number;
}

export function makeJpeg({
  orientation,
  gps = false,
  width = 4000,
  height = 3000,
  padding = 0,
}: JpegOptions = {}): Uint8Array<ArrayBuffer> {
  const jfif = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const frame = segment(0xc0, [
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
  const scan = [
    ...segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]),
    0x12,
    0x34,
    ...new Array<number>(padding).fill(0x56),
  ];
  return Uint8Array.from([
    0xff,
    0xd8,
    ...jfif,
    ...(orientation === undefined ? [] : exifSegment(orientation, gps)),
    ...frame,
    ...scan,
    0xff,
    0xd9,
  ]);
}
