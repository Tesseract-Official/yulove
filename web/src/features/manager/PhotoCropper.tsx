import { useEffect, useState } from 'react';
import { errorMessage } from '../../api/errors.js';
import { cropAndCompress, type CompressedPhoto } from '../../imaging/imaging.js';
import { Loading } from '../../ui/states.js';
import { Notice } from '../common/ui.js';
import { PhotoAdjuster, type Edit } from './PhotoAdjuster.js';
import { PhotoPreview } from './PhotoPreview.js';
import { useWorkingPhoto } from './useWorkingPhoto.js';

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
 * The adjust-and-preview steps for a single photo that is sent right away (the appeal page's
 * "upload a better photo"). It is the same screen the batch manager uses, without the queue.
 */
export function PhotoCropper({
  file,
  submitLabel,
  busy,
  busyText,
  onCancel,
  onDone,
}: PhotoCropperProps) {
  const working = useWorkingPhoto(file);
  const [edit, setEdit] = useState<Edit | undefined>();
  const [result, setResult] = useState<(CompressedPhoto & { url: string }) | undefined>();
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  useEffect(() => {
    if (working.status === 'ready') setEdit({ rotation: 0, box: working.photo.suggestedBox });
  }, [working]);

  useEffect(() => {
    const url = result?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [result]);

  const next = async () => {
    if (working.status !== 'ready' || !edit) return;
    setMaking(true);
    setProblem(undefined);
    try {
      const out = await cropAndCompress({
        source: working.photo.blob,
        area: edit.box,
        rotation: edit.rotation,
      });
      setResult({ ...out, url: URL.createObjectURL(out.blob) });
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setMaking(false);
    }
  };

  if (working.status === 'error') {
    return (
      <div className="form">
        <Notice kind="error">{working.message}</Notice>
        <button type="button" className="button" onClick={onCancel}>
          Choose another photo
        </button>
      </div>
    );
  }
  if (working.status === 'loading' || !edit) return <Loading label="Opening the photo…" />;

  if (result) {
    return (
      <div className="cropper-box">
        <PhotoPreview
          photo={{
            url: result.url,
            width: result.width,
            height: result.height,
            size: result.blob.size,
          }}
          title="this answer"
          sendLabel={busy ? 'Sending…' : submitLabel}
          onBack={() => setResult(undefined)}
          onSend={() => {
            if (!busy) onDone(result.blob);
          }}
        />
        {busy ? (
          <p className="muted" role="status">
            {busyText ?? 'Sending…'}
          </p>
        ) : null}
        {problem ? <Notice kind="error">{problem}</Notice> : null}
      </div>
    );
  }

  return (
    <div className="cropper-box">
      <div className="cropper-adjust">
        <PhotoAdjuster
          photo={working.photo}
          edit={edit}
          onEdit={setEdit}
          onRetake={onCancel}
          onNext={() => void next()}
          busy={making}
          nextLabel="Next"
        />
      </div>
      {problem ? <Notice kind="error">{problem}</Notice> : null}
    </div>
  );
}
