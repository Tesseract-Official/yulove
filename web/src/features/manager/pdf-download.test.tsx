import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeOidc, fakeUser, meFor, renderApp } from '../../test/helpers.js';
import { ASHA, boardOf, examSummary } from '../../test/fixtures.js';
import { apiError, mockApi, type Route } from '../../test/mockApi.js';

vi.mock('../common/download.js', () => ({ startDownload: vi.fn() }));
const { startDownload } = await import('../common/download.js');

function open(extra: Record<string, Route> = {}) {
  const api = mockApi({
    'GET /me': meFor('BATCH_MANAGER', { batchIds: ['A'] }),
    'GET /batches': { batches: [{ batchId: 'A', name: 'Batch A' }] },
    'GET /exams': { exams: [examSummary()] },
    'GET /exams/:id/answers': boardOf([ASHA]),
    ...extra,
  });
  renderApp({ oidc: new FakeOidc(fakeUser()), route: '/manager/board?batch=A&exam=exam-1' });
  return api;
}

beforeEach(() => vi.mocked(startDownload).mockClear());
afterEach(() => vi.unstubAllGlobals());

describe('the batch manager’s exam view', () => {
  it('has a Download PDF button that downloads the paper through the API’s link', async () => {
    const api = open({
      'GET /exams/:id/pdf': {
        url: 'https://bucket/paper.pdf?sig=1',
        expiresInSeconds: 900,
        filename: 'week-3-test-2026-10-24.pdf',
      },
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Download PDF' }));

    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(1));
    expect(startDownload).toHaveBeenCalledWith(
      'https://bucket/paper.pdf?sig=1',
      'week-3-test-2026-10-24.pdf',
    );
    expect(api.callsTo('GET /exams/:id/pdf')[0]?.params['id']).toBe('exam-1');
    // A batch manager can download the paper, but never makes it.
    expect(screen.queryByRole('button', { name: /Generate PDF/ })).not.toBeInTheDocument();
    expect(api.callsTo('POST /exams/:id/pdf')).toHaveLength(0);
  });

  it('shows the API’s message when there is no PDF yet', async () => {
    open({
      'GET /exams/:id/pdf': apiError(
        409,
        'CONFLICT',
        'This exam has no PDF yet. Generate it first.',
      ),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Download PDF' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This exam has no PDF yet');
    expect(startDownload).not.toHaveBeenCalled();
  });

  it('shows the plain refusal when the manager is not assigned to the batch', async () => {
    open({
      'GET /exams/:id/pdf': apiError(403, 'FORBIDDEN', 'You do not have access to this batch'),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Download PDF' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("You don't have access to this");
  });
});
