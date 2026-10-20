export interface PreviewPhoto {
  url: string;
  width: number;
  height: number;
  size: number;
}

const kilobytes = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;

/**
 * The photo exactly as it will be sent (cropped, turned and compressed), with Send. The photo is
 * not shown from the original but from the finished file, so what is seen here is what goes up.
 */
export function PhotoPreview({
  photo,
  title,
  sendLabel = 'Send',
  warning,
  onBack,
  onSend,
}: {
  photo: PreviewPhoto;
  title: string;
  sendLabel?: string;
  warning?: string | undefined;
  onBack: () => void;
  onSend: () => void;
}) {
  return (
    <div className="preview">
      <div className="preview-frame">
        <img src={photo.url} alt={`Preview of the photo for ${title}`} />
      </div>
      <p className="muted preview-info" aria-live="polite">
        {photo.width} × {photo.height} px · {kilobytes(photo.size)}
      </p>
      {warning ? <p className="muted">{warning}</p> : null}
      <div className="adjuster-actions">
        <button type="button" className="button" onClick={onBack}>
          Back to adjust
        </button>
        <button type="button" className="button button-primary" onClick={onSend}>
          {sendLabel}
        </button>
      </div>
    </div>
  );
}
