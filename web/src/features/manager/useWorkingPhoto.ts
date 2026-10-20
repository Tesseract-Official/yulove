import { useEffect, useState } from 'react';
import { errorMessage } from '../../api/errors.js';
import { type Box, wholeBox } from '../../imaging/cropMath.js';
import { prepareImage, suggestCrop } from '../../imaging/imaging.js';

/** A photo ready to be adjusted: upright, at most 3,200 px, and shown from a temporary address. */
export interface WorkingPhoto {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  /** Where the page seems to be in the photo, or the whole photo when that could not be told. */
  suggestedBox: Box;
  /** True when the box was found, rather than being the whole photo. */
  detected: boolean;
}

export type WorkingState =
  | { status: 'loading' }
  | { status: 'ready'; photo: WorkingPhoto }
  | { status: 'error'; message: string };

/**
 * Prepares the picked photo for the adjust screen: turns it upright, shrinks it for the phone,
 * and looks for the page edges. Starts over for a different file, and frees the temporary address
 * when the photo is replaced or the screen goes away.
 */
export function useWorkingPhoto(file: File | undefined): WorkingState {
  // The result is remembered with the file it belongs to, so a new file reads as "loading" at once
  // instead of showing the previous photo for a moment.
  const [slot, setSlot] = useState<{ file: File; state: WorkingState } | undefined>();

  useEffect(() => {
    if (!file) return undefined;
    let active = true;
    let url: string | undefined;

    (async () => {
      const prepared = await prepareImage(file);
      const size = { width: prepared.width, height: prepared.height };
      const found = await suggestCrop(prepared.blob, size);
      if (!active) return;
      url = URL.createObjectURL(prepared.blob);
      setSlot({
        file,
        state: {
          status: 'ready',
          photo: {
            blob: prepared.blob,
            url,
            ...size,
            suggestedBox: found ?? wholeBox(size),
            detected: found !== null,
          },
        },
      });
    })().catch((error: unknown) => {
      if (active) setSlot({ file, state: { status: 'error', message: errorMessage(error) } });
    });

    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);

  return file && slot?.file === file ? slot.state : { status: 'loading' };
}
