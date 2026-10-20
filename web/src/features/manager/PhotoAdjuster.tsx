import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import {
  FIT_VIEW,
  HANDLES,
  MAX_ZOOM,
  MIN_ZOOM,
  boxToFrame,
  distance,
  fitScale,
  frameToImage,
  hitHandle,
  midpoint,
  panBy,
  rotateBox,
  rotatedSize,
  resizeBox,
  wholeBox,
  zoomAround,
  type Box,
  type Handle,
  type Point,
  type Size,
  type View,
} from '../../imaging/cropMath.js';
import type { WorkingPhoto } from './useWorkingPhoto.js';

/** What has been done to the photo on the screen: how far it is turned, and the part to send. */
export interface Edit {
  /** 0, 90, 180 or 270 degrees clockwise. */
  rotation: number;
  /** The part to send, in pixels of the turned photo. */
  box: Box;
}

export interface PhotoAdjusterProps {
  photo: WorkingPhoto;
  edit: Edit;
  onEdit: (edit: Edit) => void;
  onRetake: () => void;
  onNext: () => void;
  /** True while the result is being made. */
  busy?: boolean;
  nextLabel?: string;
}

const BUTTON_ZOOM = 1.5;
const WHEEL_ZOOM = 1.15;

type Gesture =
  | { kind: 'handle'; handle: Handle; startBox: Box; startImage: Point }
  | { kind: 'pan' }
  | { kind: 'pinch' };

/** The size of an element, kept up to date as the screen changes. */
function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize((previous) =>
        previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ref]);
  return size;
}

/**
 * The adjust screen: the photo fills the area, with a crop box that has a handle on every corner
 * and edge. Drag a handle to resize the box; drag anywhere else to move the photo; pinch (or use
 * the wheel or the + and - buttons) to zoom; turn the photo a quarter either way. All of it is
 * Pointer Events, so the same code serves touch, pen and mouse, and the maths is in cropMath.ts.
 */
export function PhotoAdjuster({
  photo,
  edit,
  onEdit,
  onRetake,
  onNext,
  busy = false,
  nextLabel = 'Next',
}: PhotoAdjusterProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const frame = useElementSize(stageRef);
  const [view, setView] = useState<View>(FIT_VIEW);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);

  const content = rotatedSize({ width: photo.width, height: photo.height }, edit.rotation);
  // The latest geometry, for the native listeners below.
  const geometry = useRef({ content, frame });
  geometry.current = { content, frame };

  const ready = frame.width > 0 && frame.height > 0;
  const k = ready ? fitScale(content, frame) * view.scale : 1;

  const local = useCallback((event: { clientX: number; clientY: number }): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }, []);

  // The wheel and the iOS pinch-gesture events must be able to cancel the page's own zoom/scroll,
  // which React's passive listeners cannot do.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { content: c, frame: f } = geometry.current;
      if (f.width === 0) return;
      const rect = stage.getBoundingClientRect();
      const focus = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = event.deltaY < 0 ? WHEEL_ZOOM : 1 / WHEEL_ZOOM;
      setView((v) => zoomAround(v, factor, focus, c, f));
    };
    const stop = (event: Event) => event.preventDefault();
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('gesturestart', stop);
    stage.addEventListener('gesturechange', stop);
    return () => {
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('gesturestart', stop);
      stage.removeEventListener('gesturechange', stop);
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!ready) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size > 1) {
      gesture.current = { kind: 'pinch' };
      return;
    }
    const handle = hitHandle(boxToFrame(edit.box, content, frame, view), point);
    gesture.current = handle
      ? {
          kind: 'handle',
          handle,
          startBox: edit.box,
          startImage: frameToImage(point, content, frame, view),
        }
      : { kind: 'pan' };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const before = pointers.current.get(event.pointerId);
    const g = gesture.current;
    if (!before || !g || !ready) return;
    const point = local(event);
    pointers.current.set(event.pointerId, point);

    if (g.kind === 'handle') {
      const now = frameToImage(point, content, frame, view);
      const box = resizeBox(
        g.startBox,
        g.handle,
        now.x - g.startImage.x,
        now.y - g.startImage.y,
        content,
      );
      onEdit({ ...edit, box });
    } else if (g.kind === 'pan') {
      setView((v) => panBy(v, point.x - before.x, point.y - before.y, content, frame));
    } else {
      const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (!other) return;
      const was = distance(before, other);
      if (was === 0) return;
      const factor = distance(point, other) / was;
      const from = midpoint(before, other);
      const to = midpoint(point, other);
      setView((v) =>
        panBy(
          zoomAround(v, factor, to, content, frame),
          to.x - from.x,
          to.y - from.y,
          content,
          frame,
        ),
      );
    }
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    // One finger left after a pinch carries on as a drag of the photo.
    gesture.current = pointers.current.size === 0 ? null : { kind: 'pan' };
  };

  const zoomBy = (factor: number) =>
    setView((v) =>
      zoomAround(v, factor, { x: frame.width / 2, y: frame.height / 2 }, content, frame),
    );

  const turn = (direction: 'cw' | 'ccw') => {
    onEdit({
      rotation: (edit.rotation + (direction === 'cw' ? 90 : 270)) % 360,
      box: rotateBox(edit.box, content, direction),
    });
    setView(FIT_VIEW);
  };

  const photoBox: Box | undefined = ready
    ? boxToFrame(wholeBox(content), content, frame, view)
    : undefined;
  const cropBox: Box | undefined = ready ? boxToFrame(edit.box, content, frame, view) : undefined;

  const handlePosition = (box: Box, handle: Handle): Point => ({
    x: handle.includes('w')
      ? box.x
      : handle.includes('e')
        ? box.x + box.width
        : box.x + box.width / 2,
    y: handle.includes('n')
      ? box.y
      : handle.includes('s')
        ? box.y + box.height
        : box.y + box.height / 2,
  });

  return (
    <div className="adjuster">
      <div
        ref={stageRef}
        className="adjuster-stage"
        data-testid="adjuster-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {photoBox && cropBox ? (
          <>
            <div
              className="adjuster-photo"
              style={{
                left: photoBox.x,
                top: photoBox.y,
                width: photoBox.width,
                height: photoBox.height,
              }}
            >
              <img
                src={photo.url}
                alt="The photo to send"
                draggable={false}
                style={{
                  width: photo.width * k,
                  height: photo.height * k,
                  transform: `translate(-50%, -50%) rotate(${edit.rotation}deg)`,
                }}
              />
            </div>
            <div
              className="adjuster-crop"
              data-testid="crop-box"
              role="group"
              aria-label="The part of the photo that will be sent"
              data-x={Math.round(edit.box.x)}
              data-y={Math.round(edit.box.y)}
              data-width={Math.round(edit.box.width)}
              data-height={Math.round(edit.box.height)}
              style={{
                left: cropBox.x,
                top: cropBox.y,
                width: cropBox.width,
                height: cropBox.height,
              }}
            />
            {HANDLES.map((handle) => {
              const at = handlePosition(cropBox, handle);
              return (
                <span
                  key={handle}
                  className={`adjuster-handle adjuster-handle-${handle}`}
                  style={{ left: at.x, top: at.y }}
                  aria-hidden="true"
                />
              );
            })}
            <span className="adjuster-zoom" aria-live="polite">
              {Math.round(view.scale * 100)}%
            </span>
          </>
        ) : null}
      </div>

      <div className="adjuster-bar">
        <div className="adjuster-tools" role="toolbar" aria-label="Adjust the photo">
          <button
            type="button"
            className="button"
            aria-label="Rotate left"
            disabled={busy}
            onClick={() => turn('ccw')}
          >
            ↺
          </button>
          <button
            type="button"
            className="button"
            aria-label="Rotate right"
            disabled={busy}
            onClick={() => turn('cw')}
          >
            ↻
          </button>
          <button
            type="button"
            className="button"
            aria-label="Zoom out"
            disabled={busy || view.scale <= MIN_ZOOM}
            onClick={() => zoomBy(1 / BUTTON_ZOOM)}
          >
            −
          </button>
          <button
            type="button"
            className="button"
            aria-label="Zoom in"
            disabled={busy || view.scale >= MAX_ZOOM}
            onClick={() => zoomBy(BUTTON_ZOOM)}
          >
            +
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => setView(FIT_VIEW)}
          >
            Fit
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => onEdit({ ...edit, box: wholeBox(content) })}
          >
            Whole photo
          </button>
        </div>
        <div className="adjuster-actions">
          <button type="button" className="button" disabled={busy} onClick={onRetake}>
            Retake
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={busy || !ready}
            onClick={onNext}
          >
            {busy ? 'Preparing…' : nextLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
