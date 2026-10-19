import { answerFailureText, type AnswerDetailResponse } from '@yulove/shared';
import { FAIL_REASON_TEXT, LANGUAGE_TEXT, VERDICT_TEXT } from './labels.js';
import { Chip, Notice, StatusChip } from './ui.js';
import { ZoomableImage } from './ZoomableImage.js';

/**
 * One answer in full: its status and score, the photo, what was read from it, and how each test
 * went. With `wide` the photo, the transcription and the verdicts sit side by side on a laptop.
 */
export function AnswerDetail({
  answer: a,
  wide = false,
}: {
  answer: AnswerDetailResponse;
  wide?: boolean;
}) {
  const minutes = a.imageExpiresInSeconds ? Math.round(a.imageExpiresInSeconds / 60) : undefined;
  const question = a.questionNumber;

  const photo = (
    <section className="answer-part">
      <h2>The photo</h2>
      {a.imageUrl ? (
        <>
          <ZoomableImage src={a.imageUrl} alt={`Answer photo for question ${question}`} />
          {minutes ? (
            <p className="muted">
              This photo link works for about {minutes} minutes. Reload the page to get a new one.
            </p>
          ) : null}
        </>
      ) : (
        <p className="muted">No photo is stored for this answer.</p>
      )}
    </section>
  );

  const read = (
    <section className="answer-part">
      <h2>What was read from the photo</h2>
      <dl className="facts">
        {a.language ? (
          <>
            <dt>Language</dt>
            <dd>{LANGUAGE_TEXT[a.language]}</dd>
          </>
        ) : null}
        {a.estimatedComplexity ? (
          <>
            <dt>Estimated speed</dt>
            <dd>
              {a.estimatedComplexity}
              {a.meetsComplexity === false ? ' (slower than the required speed)' : ''}
            </dd>
          </>
        ) : null}
        {a.testsTotal !== undefined ? (
          <>
            <dt>Tests passed</dt>
            <dd>
              {a.testsPassed ?? 0} of {a.testsTotal}
            </dd>
          </>
        ) : null}
      </dl>

      <div className={wide ? 'side-by-side' : undefined}>
        {a.rawTranscription !== undefined ? (
          <div>
            <h3>As written</h3>
            <pre className="code" tabIndex={0}>
              {a.rawTranscription}
            </pre>
          </div>
        ) : null}
        {a.correctedCode !== undefined ? (
          <div>
            <h3>After fixing typing mistakes</h3>
            <pre className="code" tabIndex={0}>
              {a.correctedCode}
            </pre>
          </div>
        ) : null}
      </div>
      {a.fixes.length > 0 ? (
        <>
          <h3>Fixes that were made</h3>
          <ul className="list">
            {a.fixes.map((fix, index) => (
              <li key={`${index}-${fix}`}>{fix}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );

  const verdicts =
    a.verdicts.length > 0 ? (
      <section className="answer-part">
        <h2>Test results</h2>
        <ul className="rows" aria-label="Test results">
          {a.verdicts.map((v) => (
            <li key={v.index} className="row">
              <span className="row-title">
                Test {v.index + 1} ({v.kind === 'large' ? 'large' : 'small'}){' '}
                <Chip tone={v.verdict === 'AC' ? 'good' : 'bad'}>{VERDICT_TEXT[v.verdict]}</Chip>
              </span>
              {v.input !== undefined ? (
                <details>
                  <summary>Show what was tried</summary>
                  <p className="muted">Input</p>
                  <pre className="code">{v.input}</pre>
                  <p className="muted">Expected</p>
                  <pre className="code">{v.expected}</pre>
                  <p className="muted">The program printed</p>
                  <pre className="code">{v.actual}</pre>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  return (
    <div>
      <div className="answer-summary">
        <StatusChip status={a.status} />
        {a.absent ? <Chip tone="bad">Absent</Chip> : null}
        <span className="score">
          {a.score} / {a.marks} marks
        </span>
      </div>

      {a.override ? (
        <Notice kind="info">
          Score adjusted by {a.override.byRole === 'TEACHER' ? 'teacher' : 'admin'} to{' '}
          {a.override.score} (by {a.override.by}, {new Date(a.override.at).toLocaleString()}):{' '}
          {a.override.reason}
        </Notice>
      ) : null}

      {a.status === 'FAILED_TO_GRADE' ? (
        <Notice kind="error">
          {a.failReason ? FAIL_REASON_TEXT[a.failReason] : 'This answer could not be graded.'}
          {a.failDetail ? ` ${answerFailureText(a.failDetail)}` : ''}
        </Notice>
      ) : null}

      {wide ? (
        <div className="answer-wide">
          {photo}
          <div>
            {read}
            {verdicts}
          </div>
        </div>
      ) : (
        <>
          {photo}
          {read}
          {verdicts}
        </>
      )}
    </div>
  );
}
