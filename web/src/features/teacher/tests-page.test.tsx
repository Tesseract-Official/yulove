import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuestionTestsResponse } from '@yulove/shared';
import { FakeOidc, fakeUser, meFor, renderApp } from '../../test/helpers.js';
import { questionResponse, testPreviews, testsResponse } from '../../test/fixtures.js';
import { apiError, mockApi, type Route } from '../../test/mockApi.js';

function open(
  tests: QuestionTestsResponse | Route,
  question = questionResponse(),
  extra: Record<string, Route> = {},
) {
  const api = mockApi({
    'GET /me': meFor('TEACHER', { batchIds: ['A'] }),
    'GET /questions/:id': question,
    'GET /questions/:id/tests': tests as Route,
    ...extra,
  });
  renderApp({ oidc: new FakeOidc(fakeUser()), route: '/teacher/questions/q1/tests' });
  return api;
}

const approveButton = () => screen.getByRole('button', { name: /^Approve/ });

afterEach(() => vi.unstubAllGlobals());

describe('the state of the tests, in plain words', () => {
  it.each([
    [null, 'Not generated yet'],
    ['GENERATING', 'Generating'],
    ['NEEDS_REVIEW', 'Ready for review'],
    ['APPROVED', 'Approved'],
    ['GENERATION_FAILED', 'Failed'],
  ] as const)('shows %s as "%s"', async (status, words) => {
    open(testsResponse(status));

    const line = (await screen.findByText(/Status:/)).closest('div') as HTMLElement;
    expect(within(line).getByText(words)).toBeInTheDocument();
  });

  it('explains that the first generation can take a few minutes', async () => {
    open(testsResponse('GENERATING'));

    expect(
      await screen.findByText(/The first generation can take a few minutes/),
    ).toBeInTheDocument();
  });

  it('gives the reason when generation failed, and offers to try again', async () => {
    open(testsResponse('GENERATION_FAILED', { testFailure: 'The reference solution crashed.' }));

    expect(await screen.findByText(/The reference solution crashed\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate tests again' })).toBeInTheDocument();
  });

  it('says when it was last checked, and that it does not update by itself', async () => {
    open(testsResponse(null));

    expect(await screen.findByText(/Checked /)).toBeInTheDocument();
    expect(screen.getByText(/does not update by itself/)).toBeInTheDocument();
  });
});

describe('Refresh', () => {
  it('asks again for the question and its tests, and shows the new state', async () => {
    let status: QuestionTestsResponse['testStatus'] = 'GENERATING';
    const api = open(() => testsResponse(status));
    await screen.findByText('Generating');
    expect(api.callsTo('GET /questions/:id/tests')).toHaveLength(1);

    status = 'NEEDS_REVIEW';
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('Ready for review')).toBeInTheDocument();
    expect(api.callsTo('GET /questions/:id/tests')).toHaveLength(2);
    expect(api.callsTo('GET /questions/:id')).toHaveLength(2);
  });
});

describe('generating', () => {
  it('starts generation and says to come back later', async () => {
    let started = false;
    const api = open(() => testsResponse(started ? 'GENERATING' : null), questionResponse(), {
      'POST /questions/:id/generate-tests': () => {
        started = true;
        return { questionId: 'q1', version: 1, testStatus: 'GENERATING', attempt: 1 };
      },
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Generate tests' }));

    expect(await screen.findByText('Generating')).toBeInTheDocument();
    expect(api.callsTo('POST /questions/:id/generate-tests')).toHaveLength(1);
    expect(screen.getByText(/can take a few minutes/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate tests' })).not.toBeInTheDocument();
  });

  it('shows the API’s message when it cannot start', async () => {
    open(testsResponse(null), questionResponse(), {
      'POST /questions/:id/generate-tests': apiError(
        409,
        'CONFLICT',
        'This version is used by an exam with submitted answers.',
      ),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Generate tests' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'used by an exam with submitted answers',
    );
  });

  it('offers a quiet “Start again” while it seems stuck', async () => {
    const api = open(testsResponse('GENERATING'), questionResponse(), {
      'POST /questions/:id/generate-tests': {
        questionId: 'q1',
        version: 1,
        testStatus: 'GENERATING',
        attempt: 2,
      },
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Start again' }));

    await waitFor(() => expect(api.callsTo('POST /questions/:id/generate-tests')).toHaveLength(1));
  });
});

describe('approving', () => {
  it.each([null, 'GENERATING', 'APPROVED', 'GENERATION_FAILED'] as const)(
    'is not possible while the tests are %s',
    async (status) => {
      const api = open(testsResponse(status));
      await screen.findByText(/Status:/);

      expect(approveButton()).toBeDisabled();
      await userEvent.click(approveButton());
      expect(api.callsTo('POST /questions/:id/approve')).toHaveLength(0);
    },
  );

  it('says why Approve is not available', async () => {
    open(testsResponse('GENERATING'));

    expect(
      await screen.findByText('Available when the tests are ready for review.'),
    ).toBeInTheDocument();
  });

  it('is possible when the tests are ready for review, and approves them', async () => {
    let status: QuestionTestsResponse['testStatus'] = 'NEEDS_REVIEW';
    const api = open(() => testsResponse(status), questionResponse(), {
      'POST /questions/:id/approve': () => {
        status = 'APPROVED';
        return { questionId: 'q1', version: 1, testStatus: 'APPROVED' };
      },
    });
    await screen.findByText('Ready for review');
    expect(approveButton()).toBeEnabled();

    await userEvent.click(approveButton());

    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(api.callsTo('POST /questions/:id/approve')).toHaveLength(1);
    await waitFor(() => expect(approveButton()).toBeDisabled());
  });

  it('shows the API’s message if approval is refused', async () => {
    open(testsResponse('NEEDS_REVIEW'), questionResponse(), {
      'POST /questions/:id/approve': apiError(
        409,
        'CONFLICT',
        'Only a question in NEEDS_REVIEW can be approved',
      ),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only a question in NEEDS_REVIEW can be approved',
    );
  });
});

describe('reviewing the tests', () => {
  it('shows the function students must write', async () => {
    open(testsResponse('NEEDS_REVIEW'));

    expect(await screen.findByText('twoSum(nums: int[], target: int) → int[]')).toBeInTheDocument();
    expect(screen.getByText(/Students are told to use this name/)).toBeInTheDocument();
  });

  it('shows all 10 tests, with the large ones marked', async () => {
    open(testsResponse('NEEDS_REVIEW'));

    const list = (await screen.findByText('Test 1')).closest('ul') as HTMLElement;
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(within(list).getAllByText('Small test')).toHaveLength(7);
    expect(within(list).getAllByText('Large test')).toHaveLength(3);
    const eighth = screen.getByText('Test 8').closest('li') as HTMLElement;
    expect(within(eighth).getByText('Large test')).toBeInTheDocument();
  });

  it('shows short values as they are, and folds long ones away', async () => {
    const long = JSON.stringify({ nums: Array.from({ length: 400 }, (_, i) => i), target: 5 });
    open(
      testsResponse('NEEDS_REVIEW', {
        tests: testPreviews((i) =>
          i === 7 ? { input: long, expected: '[0,1]' } : i === 0 ? { input: 'line 1\nline 2' } : {},
        ),
      }),
    );

    const eighth = (await screen.findByText('Test 8')).closest('li') as HTMLElement;
    const summary = within(eighth).getByText(/Input \(\d+(,\d{3})* characters\)/);
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(within(eighth).getByText('[0,1]')).toBeVisible(); // the short expected output is not folded
    expect(within(eighth).getByText('Expected output').closest('details')).toBeNull();
    // A value with more than one line is folded too.
    const first = screen.getByText('Test 1').closest('li') as HTMLElement;
    expect(within(first).getByText(/Input \(13 characters\)/)).toBeInTheDocument();
    // A short single line is shown straight away.
    const second = screen.getByText('Test 2').closest('li') as HTMLElement;
    expect(within(second).getByText('Input').closest('details')).toBeNull();
  });

  it('says when the server shortened a very long value', async () => {
    open(
      testsResponse('NEEDS_REVIEW', {
        tests: testPreviews((i) => (i === 9 ? { truncated: true } : {})),
      }),
    );

    const last = (await screen.findByText('Test 10')).closest('li') as HTMLElement;
    expect(within(last).getByText('Shortened')).toBeInTheDocument();
    expect(
      within(last).getByText(/Only the first 1,000 characters are shown here/),
    ).toBeInTheDocument();
  });

  it('reminds the teacher where the expected outputs come from', async () => {
    open(testsResponse('NEEDS_REVIEW'));

    expect(await screen.findByText(/come from running the reference solution/)).toBeInTheDocument();
  });

  it('says so when the test file is not there yet', async () => {
    open(testsResponse('NEEDS_REVIEW', { tests: undefined }));

    expect(await screen.findByText(/The tests are not available yet/)).toBeInTheDocument();
  });

  it('keeps showing the tests of an approved question', async () => {
    open(testsResponse('APPROVED'));

    expect(await screen.findByText('Test 10')).toBeInTheDocument();
  });
});

describe('regenerating', () => {
  it('regenerates tests that are ready for review straight away', async () => {
    const api = open(testsResponse('NEEDS_REVIEW'), questionResponse(), {
      'POST /questions/:id/generate-tests': {
        questionId: 'q1',
        version: 1,
        testStatus: 'GENERATING',
        attempt: 2,
      },
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Regenerate' }));

    await waitFor(() => expect(api.callsTo('POST /questions/:id/generate-tests')).toHaveLength(1));
  });

  it('asks first when the tests are approved, and does nothing if the teacher cancels', async () => {
    const api = open(testsResponse('APPROVED'), questionResponse(), {
      'POST /questions/:id/generate-tests': {
        questionId: 'q1',
        version: 1,
        testStatus: 'GENERATING',
        attempt: 2,
      },
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Regenerate' }));
    const question = screen.getByRole('alertdialog', { name: 'Regenerate approved tests?' });
    expect(question).toHaveTextContent('Regenerating throws them away');
    await userEvent.click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(api.callsTo('POST /questions/:id/generate-tests')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, regenerate' }));
    await waitFor(() => expect(api.callsTo('POST /questions/:id/generate-tests')).toHaveLength(1));
  });
});

describe('a question that is in use', () => {
  it('cannot be generated or regenerated: the teacher is told to make a new version', async () => {
    open(testsResponse('NEEDS_REVIEW'), questionResponse({}, { inUse: true, usedInExams: 1 }));

    expect(
      await screen.findByText(/already has answers, so its tests cannot be changed/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit the question' })).toHaveAttribute(
      'href',
      '/teacher/questions/q1',
    );
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate tests/ })).not.toBeInTheDocument();
  });

  it('does not offer to generate when there are no tests', async () => {
    open(testsResponse(null), questionResponse({}, { inUse: true }));

    await screen.findByText(/cannot be changed/);
    expect(screen.queryByRole('button', { name: 'Generate tests' })).not.toBeInTheDocument();
  });
});

describe('loading problems', () => {
  it('explains when the tests cannot be loaded, and can try again', async () => {
    open(apiError(403, 'FORBIDDEN', 'This question belongs to another teacher'));

    expect(await screen.findByText('Could not load the tests')).toBeInTheDocument();
    expect(screen.getByText(/You don't have access to this/)).toBeInTheDocument();
  });
});
