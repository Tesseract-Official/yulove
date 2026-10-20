import { Link, useLocation } from 'react-router-dom';
import { Chip } from '../common/ui.js';
import { type QueueItem, useUploadQueue } from './uploadQueue.js';

const kilobytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
const where = (item: QueueItem) => `Q${item.question} for ${item.studentLabel}`;

function Row({ item }: { item: QueueItem }) {
  const queue = useUploadQueue();
  const percent = Math.round(item.progress * 100);

  return (
    <li className={`upload-row upload-row-${item.status}`}>
      <span className="upload-row-title">
        {where(item)} <span className="muted">· {kilobytes(item.size)}</span>
      </span>
      {item.status === 'failed' ? (
        <>
          <span className="upload-row-error">{item.error}</span>
          <span className="upload-row-actions">
            <button
              type="button"
              className="chip chip-bad retry-chip"
              aria-label={`Retry sending ${where(item)}`}
              onClick={() => queue.retry(item.id)}
            >
              ↻ Retry
            </button>
            <button
              type="button"
              className="button button-quiet"
              aria-label={`Discard ${where(item)}`}
              onClick={() => queue.discard(item.id)}
            >
              Discard
            </button>
          </span>
        </>
      ) : (
        <span className="upload-row-progress">
          <progress
            max={100}
            value={item.status === 'queued' ? 0 : percent}
            aria-label={`Sending ${where(item)}`}
          />
          <span className="muted">{item.status === 'queued' ? 'Waiting' : `${percent}%`}</span>
        </span>
      )}
    </li>
  );
}

/**
 * Photos that are waiting, going up or have failed. Sent photos drop out. Nothing here goes away
 * by itself: a failed photo stays, with its reason, until it is sent or discarded on purpose.
 */
export function UploadStatusList() {
  const queue = useUploadQueue();
  const pending = queue.items.filter((item) => item.status !== 'done');
  if (pending.length === 0) return null;

  return (
    <section className="upload-status" aria-label="Photos being sent">
      <div className="upload-status-head">
        <h3>
          {queue.failed > 0
            ? `${queue.failed} ${queue.failed === 1 ? 'photo has' : 'photos have'} not been sent`
            : `Sending ${pending.length} ${pending.length === 1 ? 'photo' : 'photos'}…`}
        </h3>
        {queue.failed > 1 ? (
          <button type="button" className="button" onClick={queue.retryAll}>
            Retry all
          </button>
        ) : null}
      </div>
      <ul className="upload-rows">
        {pending.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

/**
 * On every page except Upload answers: a reminder that photos have not been sent, so a manager who
 * wandered off does not leave a failed photo behind.
 */
export function UnsentBanner() {
  const queue = useUploadQueue();
  const { pathname } = useLocation();
  if (queue.unsent === 0 || pathname.startsWith('/manager/upload')) return null;

  const failed = queue.failed > 0;
  return (
    <div
      className={`unsent-banner${failed ? ' unsent-banner-failed' : ''}`}
      role={failed ? 'alert' : 'status'}
    >
      <span>
        {failed
          ? `${queue.failed} ${queue.failed === 1 ? 'photo has' : 'photos have'} not been sent.`
          : `Sending ${queue.unsent} ${queue.unsent === 1 ? 'photo' : 'photos'}… Keep this page open.`}
      </span>
      <Link to="/manager/upload" className="button">
        Open Upload answers
      </Link>
      {failed ? <Chip tone="bad">Needs attention</Chip> : null}
    </div>
  );
}
