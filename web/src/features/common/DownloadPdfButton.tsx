import { useMutation } from '@tanstack/react-query';
import { useApi } from '../../api/ApiContext.js';
import { errorMessage } from '../../api/errors.js';
import { startDownload } from './download.js';
import { Notice } from './ui.js';

/**
 * Downloads an exam's paper. Anyone assigned to the exam's batch may; the API says why when there
 * is no PDF yet.
 */
export function DownloadPdfButton({
  examId,
  disabled = false,
  primary = false,
}: {
  examId: string;
  disabled?: boolean;
  primary?: boolean;
}) {
  const api = useApi();
  const download = useMutation({
    mutationFn: () => api.getExamPdfLink(examId),
    meta: { errorToast: false },
    onSuccess: (link) => startDownload(link.url, link.filename),
  });

  return (
    <>
      <button
        type="button"
        className={primary ? 'button button-primary' : 'button'}
        disabled={disabled || download.isPending}
        onClick={() => download.mutate()}
      >
        {download.isPending ? 'Getting the link…' : 'Download PDF'}
      </button>
      {download.isError ? <Notice kind="error">{errorMessage(download.error)}</Notice> : null}
    </>
  );
}
