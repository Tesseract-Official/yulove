import { useEffect, useRef, useState } from 'react';
import Cropper from 'react-easy-crop';
import type { Area } from 'react-easy-crop';
import { errorMessage } from '../../api/errors.js';
import { cropAndCompress, prepareImage } from '../../imaging/imaging.js';
import { Notice } from '../common/ui.js';
import { Loading } from '../../ui/states.js';

/** The shapes to cut: an A4 answer page is taller than it is wide. */
const SHAPES = [
  { id: 'portrait', label: 'Portrait page', aspect: 210 / 297 },
  { id: 'landscape', label: 'Landscape', aspect: 297 / 210 },
  { id: 'square', label: 'Square', aspect: 1 },
] as const;
type ShapeId = (typeof SHAPES)[number]['id'];

export interface PhotoCropperProps {
  file: File;
  submitLabel: string;
  /** True while the photo is being sent. */
  busy: boolean;
  /** What is happening while it is sent ("Uploading the photo…"). */
  busyText?: string | undefined;
  onCancel: () => void;
  /** Called with the cropped, compressed JPEG. */
  onDone: (photo: Blob) => void;
}

/**
 * Shows the photo, lets the person turn it, zoom and cut out the page, then makes the small JPEG
 * that is sent for grading.
 */
export function PhotoCropper({
  file,
  submitLabel,
  busy,
  busyText,
  onCancel,
  onDone,
}: PhotoCropperProps) {
  const [working, setWorking] = useState<Blob | undefined>();
  const [src, setSrc] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [shape, setShape] = useState<ShapeId>('portrait');
  const [area, setArea] = useState<Area | undefined>();
  const [making, setMaking] = useState(false);
  const urlRef = useRef<string | undefined>(undefined);

  // Make the working copy of the chosen photo, and show it.
  useEffect(() => {
    let active = true;
    setWorking(undefined);
    setSrc(undefined);
    setProblem(undefined);
    prepareImage(file).then(
      ({ blob }) => {
        if (!active) return;
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setWorking(blob);
        setSrc(url);
      },
      (error: unknown) => active && setProblem(errorMessage(error)),
    );
    return () => {
      active = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = undefined;
    };
  }, [file]);

  const turn = (degrees: number) => setRotation((current) => (current + degrees + 360) % 360);
  const aspect = SHAPES.find((s) => s.id === shape)?.aspect ?? 1;

  const finish = async () => {
    if (!working || !area) return;
    setMaking(true);
    setProblem(undefined);
    try {
      const { blob } = await cropAndCompress({ source: working, area, rotation });
      onDone(blob);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setMaking(false);
    }
  };

  if (problem && !src) {
    return (
      <div className="form">
        <Notice kind="error">{problem}</Notice>
        <button type="button" className="button" onClick={onCancel}>
          Choose another photo
        </button>
      </div>
    );
  }
  if (!src) return <Loading label="Opening the photo…" />;

  const locked = busy || making;
  return (
    <div className="cropper-box">
      <p className="muted">
        Turn the photo until the page is upright, then move and zoom so the page fills the frame.
      </p>
      <div className="cropper" data-testid="cropper">
        <Cropper
          image={src}
          crop={crop}
          zoom={zoom}
          rotation={rotation}
          aspect={aspect}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={(_percent, pixels) => setArea(pixels)}
        />
      </div>

      <div className="tools">
        <button type="button" className="button" onClick={() => turn(-90)} disabled={locked}>
          ⟲ Turn left
        </button>
        <button type="button" className="button" onClick={() => turn(90)} disabled={locked}>
          Turn right ⟳
        </button>
      </div>

      <div className="field">
        <label htmlFor="crop-zoom">Zoom</label>
        <input
          id="crop-zoom"
          type="range"
          min={1}
          max={4}
          step={0.05}
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
          disabled={locked}
        />
      </div>

      <fieldset className="shapes">
        <legend>Shape of the frame</legend>
        {SHAPES.map((option) => (
          <label key={option.id} className="check">
            <input
              type="radio"
              name="crop-shape"
              checked={shape === option.id}
              onChange={() => setShape(option.id)}
              disabled={locked}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>

      {problem ? <Notice kind="error">{problem}</Notice> : null}
      {locked ? (
        <p className="muted" role="status">
          {busy ? (busyText ?? 'Sending…') : 'Preparing the photo…'}
        </p>
      ) : null}

      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          disabled={locked || !area}
          onClick={() => void finish()}
        >
          {submitLabel}
        </button>
        <button type="button" className="button" disabled={locked} onClick={onCancel}>
          Choose a different photo
        </button>
      </div>
    </div>
  );
}
