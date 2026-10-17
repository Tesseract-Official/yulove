import type { ChangeEvent } from 'react';

/**
 * The two ways to give a photo: take one with the camera, or choose a file. The picked file is
 * handed on; the input is cleared so choosing the same photo again still counts.
 */
export function PhotoInputs({ onPick }: { onPick: (file: File) => void }) {
  const chosen = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (picked) onPick(picked);
  };

  return (
    <div className="capture">
      <label className="button button-primary file-button">
        Take a photo
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={chosen}
        />
      </label>
      <label className="button file-button">
        Choose a file
        <input type="file" accept="image/*" className="sr-only" onChange={chosen} />
      </label>
    </div>
  );
}
