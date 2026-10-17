import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ChangeEvent, type FormEvent } from 'react';
import type { ImportStudentsResponse } from '@yulove/shared';
import { useApi } from '../../api/ApiContext.js';
import { errorMessage } from '../../api/errors.js';
import { BatchSelect } from '../common/pickers.js';
import { Chip, Field, Notice, PageHeader } from '../common/ui.js';
import { plural } from '../common/labels.js';
import { readFileText } from './files.js';

/** The API refuses a CSV bigger than this. */
const MAX_CSV_BYTES = 1_000_000;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Why a chosen file cannot be used, in plain words; undefined when it is fine. */
export function csvProblem(file: { name: string; size: number }): string | undefined {
  if (!/\.csv$/i.test(file.name)) return 'Please choose a CSV file (its name ends in .csv).';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_CSV_BYTES) {
    return 'That file is too big (over 1 MB). Split it into smaller files and add them one by one.';
  }
  return undefined;
}

function Results({ result }: { result: ImportStudentsResponse }) {
  const { created, updated, rejected, counts } = result;
  return (
    <div className="results" aria-live="polite">
      <h2>Result</h2>
      <p>
        <strong>{plural(counts.created, 'student')} added</strong>,{' '}
        <strong>{plural(counts.updated, 'student')} updated</strong> and{' '}
        <strong>{plural(counts.rejected, 'row')} skipped</strong> (of {counts.rows} in the file).
      </p>

      {rejected.length > 0 ? (
        <>
          <h3>Skipped rows</h3>
          <p className="muted">Fix these rows in your file and upload it again.</p>
          <ul className="rows" aria-label="Skipped rows">
            {rejected.map((row) => (
              <li key={`${row.line}-${row.email ?? row.rollNo ?? ''}`} className="row">
                <span className="row-title">
                  Line {row.line}
                  {row.email || row.rollNo
                    ? ` · ${[row.rollNo, row.email].filter(Boolean).join(' · ')}`
                    : ''}
                </span>
                <span>{sentence(row.reason)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Notice kind="success">Every row was imported.</Notice>
      )}

      {created.length > 0 ? (
        <details>
          <summary>Students added ({created.length})</summary>
          <ul className="rows">
            {created.map((row) => (
              <li key={row.email} className="row">
                <span className="row-title">
                  {row.rollNo} · {row.name}
                </span>
                <span className="muted break">{row.email}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {updated.length > 0 ? (
        <details>
          <summary>Students updated ({updated.length})</summary>
          <ul className="rows">
            {updated.map((row) => (
              <li key={row.email} className="row">
                <span className="row-title">
                  {row.rollNo} · {row.name}
                </span>
                <span className="muted break">{row.email}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** Batch manager: add or update students from a CSV file. */
export function ImportPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [batchId, setBatchId] = useState('');
  const [file, setFile] = useState<File | undefined>();
  const [fileProblem, setFileProblem] = useState<string | undefined>();
  const [result, setResult] = useState<ImportStudentsResponse | undefined>();
  const chooseBatch = useCallback((id: string) => setBatchId(id), []);

  const run = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a CSV file first.');
      return api.importStudents(batchId, await readFileText(file));
    },
    meta: { errorToast: false },
    onSuccess: async (response) => {
      setResult(response);
      // The student lists on the upload and board screens are now out of date.
      await queryClient.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    run.reset();
    setResult(undefined);
    setFile(undefined);
    if (!chosen) return setFileProblem(undefined);
    const problem = csvProblem(chosen);
    setFileProblem(problem);
    if (!problem) setFile(chosen);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (batchId && file) run.mutate();
  };

  return (
    <section className="page">
      <PageHeader
        title="Add students"
        intro="Upload a CSV file to add new students or update existing ones."
        backTo="/manager"
      />

      <form className="form" onSubmit={submit}>
        <BatchSelect value={batchId} onChange={chooseBatch} />

        <div className="help">
          <p>
            <strong>The file needs a first row with these column names:</strong>
          </p>
          <p>
            <code>name, college email, roll number, batch</code>
          </p>
          <p className="muted">
            The “batch” column holds the batch ID (for example <code>2026-A</code>). Rows for a
            batch you are not assigned to are skipped.
          </p>
        </div>

        <Field label="CSV file">
          {(id) => <input id={id} type="file" accept=".csv,text/csv" onChange={choose} />}
        </Field>
        {fileProblem ? <Notice kind="error">{fileProblem}</Notice> : null}
        {file ? (
          <p className="muted">
            Ready to upload: <strong>{file.name}</strong>{' '}
            <Chip>{Math.ceil(file.size / 1024)} KB</Chip>
          </p>
        ) : null}

        {run.isError ? <Notice kind="error">{errorMessage(run.error)}</Notice> : null}

        <button
          type="submit"
          className="button button-primary"
          disabled={!batchId || !file || run.isPending}
        >
          {run.isPending ? 'Uploading…' : 'Upload students'}
        </button>
      </form>

      {result ? <Results result={result} /> : null}
    </section>
  );
}
