import { useState } from 'react';

const STEPS = [1, 1.5, 2, 3, 4];

/**
 * A photo that can be enlarged. The buttons step the zoom; when it is bigger than the frame the
 * frame scrolls, so any part of the page can be read.
 */
export function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const [level, setLevel] = useState(0);
  const zoom = STEPS[level] ?? 1;

  return (
    <div className="zoomable">
      <div className="zoom-tools" role="group" aria-label="Zoom the photo">
        <button
          type="button"
          className="button"
          disabled={level === 0}
          onClick={() => setLevel((l) => Math.max(0, l - 1))}
        >
          Zoom out
        </button>
        <button
          type="button"
          className="button"
          disabled={level === STEPS.length - 1}
          onClick={() => setLevel((l) => Math.min(STEPS.length - 1, l + 1))}
        >
          Zoom in
        </button>
        <button type="button" className="button" disabled={level === 0} onClick={() => setLevel(0)}>
          Fit to screen
        </button>
        <span className="muted" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
      </div>
      <div className="zoom-frame" tabIndex={0}>
        <img className="answer-photo" src={src} alt={alt} style={{ width: `${zoom * 100}%` }} />
      </div>
    </div>
  );
}
