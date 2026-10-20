import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from 'react';
import {
  DOUBLE_TAP_SCALE,
  FIT,
  MAX_SCALE,
  MIN_SCALE,
  clampView,
  distance,
  midpoint,
  zoomAround,
  type Point,
  type View,
} from './pinch.js';

const DOUBLE_TAP_MS = 300;
const BUTTON_STEP = 1.5;

/**
 * A photo filling the screen. Two fingers pinch to zoom, one finger (or the mouse) drags a zoomed
 * photo, a double tap or double click toggles zoom, and the buttons and Esc work without a touch
 * screen. Built on pointer events so no library is needed.
 */
export function FullscreenPhoto({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>(FIT);
  const frameRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const lastTap = useRef(0);
  const moved = useRef(false);

  const frame = useCallback(() => {
    const box = frameRef.current?.getBoundingClientRect();
    return { width: box?.width ?? 0, height: box?.height ?? 0 };
  }, []);
  /** A client point as an offset from the middle of the frame. */
  const fromCentre = useCallback((p: Point): Point => {
    const box = frameRef.current?.getBoundingClientRect();
    return box ? { x: p.x - (box.left + box.width / 2), y: p.y - (box.top + box.height / 2) } : p;
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const zoomBy = (factor: number) => setView((v) => zoomAround(v, factor, { x: 0, y: 0 }, frame()));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    moved.current = false;
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const before = pointers.current.get(event.pointerId);
    if (!before) return;
    const now = { x: event.clientX, y: event.clientY };
    const others = [...pointers.current.entries()].filter(([id]) => id !== event.pointerId);
    pointers.current.set(event.pointerId, now);

    if (others.length >= 1) {
      // Pinch: the zoom follows the change in distance, and the midpoint drags the photo along.
      const [, other] = others[0] as [number, Point];
      const prevDistance = distance(before, other);
      const nextDistance = distance(now, other);
      if (prevDistance === 0) return;
      const prevMid = midpoint(before, other);
      const nextMid = midpoint(now, other);
      moved.current = true;
      setView((v) => {
        const zoomed = zoomAround(v, nextDistance / prevDistance, fromCentre(nextMid), frame());
        return clampView(
          {
            ...zoomed,
            x: zoomed.x + (nextMid.x - prevMid.x),
            y: zoomed.y + (nextMid.y - prevMid.y),
          },
          frame(),
        );
      });
      return;
    }
    const dx = now.x - before.x;
    const dy = now.y - before.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved.current = true;
    setView((v) =>
      v.scale > MIN_SCALE ? clampView({ ...v, x: v.x + dx, y: v.y + dy }, frame()) : v,
    );
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const wasPinching = pointers.current.size > 1;
    pointers.current.delete(event.pointerId);
    if (wasPinching || moved.current) return;
    // A tap that did not move: two in quick succession toggle the zoom.
    const at = Date.now();
    if (at - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      const point = fromCentre({ x: event.clientX, y: event.clientY });
      setView((v) => (v.scale > MIN_SCALE ? FIT : zoomAround(v, DOUBLE_TAP_SCALE, point, frame())));
    } else {
      lastTap.current = at;
    }
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
    const point = fromCentre({ x: event.clientX, y: event.clientY });
    setView((v) => zoomAround(v, factor, point, frame()));
  };

  return (
    <div className="photo-overlay" role="dialog" aria-modal="true" aria-label={alt}>
      <div className="photo-overlay-bar">
        <button
          type="button"
          className="button"
          onClick={() => zoomBy(1 / BUTTON_STEP)}
          disabled={view.scale <= MIN_SCALE}
        >
          Zoom out
        </button>
        <button
          type="button"
          className="button"
          onClick={() => zoomBy(BUTTON_STEP)}
          disabled={view.scale >= MAX_SCALE}
        >
          Zoom in
        </button>
        <span className="muted" aria-live="polite">
          {Math.round(view.scale * 100)}%
        </span>
        <button type="button" className="button button-primary" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
      <div
        ref={frameRef}
        className="photo-overlay-frame"
        data-testid="photo-frame"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <img
          className="photo-overlay-image"
          src={src}
          alt={alt}
          draggable={false}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      </div>
    </div>
  );
}
