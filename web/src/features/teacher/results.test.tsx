import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExamResultsResponse } from '@yulove/shared';
import { FakeOidc, fakeUser, meFor, renderApp } from '../../test/helpers.js';
import { EXAM_ID, examSummary, resultCell, resultRow, resultsOf } from '../../test/fixtures.js';
import { apiError, mockApi, type Route } from '../../test/mockApi.js';

const ASHA = resultRow('s1@college.edu', 'Asha Rao', 'R1', [resultCell(1), resultCell(2)], {
  totalScore: 12.5,
});
const BEN_FAILED = resultRow(
  's2@college.edu',
  'Ben Rai',
  'R2',
  [resultCell(1), resultCell(2, 'FAILED_TO_GRADE', { failReason: 'UNREADABLE' })],
  { totalScore: 7.5 },
);
const CHITRA_ABSENT = resultRow(
  's3@college.edu',
  'Chitra Nair',
  'R3',
  [resultCell(1, 'NOT_SUBMITTED'), resultCell(2, 'NOT_SUBMITTED')],
  { absent: true, totalScore: 0 },
);
const DEV_PARTIAL = resultRow(
  's4@college.edu',
  'Dev Shah',
  'R4',
  [resultCell(1, 'NOT_SUBMITTED'), resultCell(2, 'RUNNING')],
  { totalScore: 0 },
);
const EVA_ADJUSTED = resultRow(
  's5@college.edu',
  'Eva Roy',
  'R5',
  [resultCell(1, 'GRADED', { overridden: true, score: 10 }), resultCell(2)],
  { totalScore: 15 },
);

function open(
  results: ExamResultsResponse | Route,
  route = `/teacher/results?batch=A&exam=${EXAM_ID}`,
  extra: Record<string, Route> = {},
) {
  const api = mockApi({
    'GET /me': meFor('TEACHER', { batchIds: ['A'] }),
    'GET /batches': { batches: [{ batchId: 'A', name: 'Batch A' }] },
    'GET /exams': {
      exams: [
        examSummary({ status: 'READY' }),
        examSummary({ examId: 'draft', title: 'A draft', status: 'DRAFT' }),
      ],
    },
    'GET /exams/:id/results': results as Route,
    ...extra,
  });
  renderApp({ oidc: new FakeOidc(fakeUser()), route });
  return api;
}

const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

afterEach(() => vi.unstubAllGlobals());

describe('the results table', () => {
  it('shows each student’s name, roll number, score on every question and total', async () => {
    open(resultsOf([ASHA]));

    const table = await screen.findByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Roll no.', 'Name', 'Q1 (10)', 'Q2 (5)', 'Total (15)']);
    const asha = row('Asha Rao');
    expect(within(asha).getByText('R1')).toBeInTheDocument();
    expect(within(asha).getByText('7.5 / 10')).toBeInTheDocument();
    expect(within(asha).getByText('5 / 5')).toBeInTheDocument();
    expect(within(asha).getByText('12.5')).toBeInTheDocument();
  });

  it('shows an absent student clearly, with a total of 0', async () => {
    open(resultsOf([CHITRA_ABSENT]));

    await screen.findByText('Chitra Nair');
    const chitra = row('Chitra Nair');
    expect(within(chitra).getByText('Absent')).toBeInTheDocument();
    expect(within(chitra).getByText('0')).toBeInTheDocument();
    expect(within(chitra).queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows a question that could not be graded as such, with the reason, not as a plain 0', async () => {
    open(resultsOf([BEN_FAILED]));

    await screen.findByText('Ben Rai');
    const ben = row('Ben Rai');
    expect(within(ben).getByText('Could not be graded')).toBeInTheDocument();
    expect(
      within(ben).getByText('The photo could not be read. Upload a clearer photo.'),
    ).toBeInTheDocument();
    expect(within(ben).queryByText('0 / 5')).not.toBeInTheDocument();
    expect(within(ben).getByText('(incomplete)')).toBeInTheDocument();
  });

  it('shows missing photos, answers still being graded, and adjusted marks', async () => {
    open(resultsOf([DEV_PARTIAL, EVA_ADJUSTED]));

    await screen.findByText('Dev Shah');
    const dev = row('Dev Shah');
    expect(within(dev).getByText('No photo')).toBeInTheDocument();
    expect(within(dev).getByText('Running the code')).toBeInTheDocument();
    const eva = row('Eva Roy');
    expect(within(eva).getByText('10 / 10')).toBeInTheDocument();
    expect(within(eva).getByText('Adjusted')).toBeInTheDocument();
  });

  it('links each answer to its detail page', async () => {
    open(resultsOf([ASHA, BEN_FAILED]));

    const link = await screen.findByRole('link', {
      name: 'Question 1 for Asha Rao: 7.5 out of 10. Open the answer',
    });
    expect(link).toHaveAttribute('href', `/teacher/answer/${EXAM_ID}/s1%40college.edu/1?batch=A`);
    expect(
      screen.getByRole('link', {
        name: 'Question 2 for Ben Rai: could not be graded. Open the answer',
      }),
    ).toHaveAttribute('href', `/teacher/answer/${EXAM_ID}/s2%40college.edu/2?batch=A`);
  });

  it('summarises the exam, and warns about answers that could not be graded', async () => {
    open(resultsOf([ASHA, BEN_FAILED, CHITRA_ABSENT]));

    expect(
      await screen.findByText(
        /3 students · 1 absent · 15 marks in total · Results are not published yet/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 answer could not be graded \(1 student\)/)).toBeInTheDocument();
  });

  it('says when the results are published', async () => {
    open(resultsOf([ASHA], { examStatus: 'PUBLISHED' }));

    expect(await screen.findByText(/Results are published/)).toBeInTheDocument();
  });

  it('does not warn when everything was graded', async () => {
    open(resultsOf([ASHA]));

    await screen.findByRole('table');
    expect(screen.queryByText(/could not be graded \(/)).not.toBeInTheDocument();
  });

  it('finds students by name, roll number or email', async () => {
    open(resultsOf([ASHA, BEN_FAILED, CHITRA_ABSENT]));
    const search = await screen.findByLabelText('Find a student');

    await userEvent.type(search, 'r2');
    expect(screen.queryByText('Asha Rao')).not.toBeInTheDocument();
    expect(screen.getByText('Ben Rai')).toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, 'chitra');
    expect(screen.getByText('Chitra Nair')).toBeInTheDocument();
    expect(screen.queryByText('Ben Rai')).not.toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, 's1@college');
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, 'nobody');
    expect(await screen.findByText('No student matches.')).toBeInTheDocument();
  });

  it('can show only the students with answers that could not be graded', async () => {
    open(resultsOf([ASHA, BEN_FAILED, CHITRA_ABSENT]));

    await userEvent.click(await screen.findByLabelText('Only answers that could not be graded'));

    expect(screen.getByText('Ben Rai')).toBeInTheDocument();
    expect(screen.queryByText('Asha Rao')).not.toBeInTheDocument();
    expect(screen.queryByText('Chitra Nair')).not.toBeInTheDocument();
  });

  it('explains when there are no students yet', async () => {
    open(resultsOf([]));

    expect(await screen.findByText('There are no students in this exam yet.')).toBeInTheDocument();
  });
});

describe('choosing the exam', () => {
  it('offers the exams that have a PDF, not drafts', async () => {
    open(resultsOf([ASHA]), '/teacher/results');

    const select = await screen.findByLabelText('Exam');
    expect(within(select).queryByRole('option', { name: /A draft/ })).not.toBeInTheDocument();
    await userEvent.selectOptions(select, EXAM_ID);
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('explains when the results cannot be loaded', async () => {
    open(apiError(403, 'FORBIDDEN', 'You do not have access to this batch'));

    expect(await screen.findByText('Could not load the results')).toBeInTheDocument();
    expect(screen.getByText(/You don't have access to this/)).toBeInTheDocument();
  });
});

describe('an answer, for checking', () => {
  it('opens from the results and goes back to them', async () => {
    open(resultsOf([ASHA]), undefined, {
      'GET /answers/:examId/:studentEmail/:q': {
        examId: EXAM_ID,
        studentEmail: 's1@college.edu',
        questionNumber: 1,
        marks: 10,
        absent: false,
        status: 'GRADED',
        attempt: 1,
        imageUrl: 'https://bucket/photo.jpg',
        imageExpiresInSeconds: 900,
        language: 'python',
        rawTranscription: 'def f(x)',
        correctedCode: 'def f(x):',
        fixes: ['Added a colon'],
        verdicts: [
          { index: 0, kind: 'small', verdict: 'WA', input: '1', expected: '2', actual: '3' },
        ],
        score: 5,
        testsPassed: 0,
        testsTotal: 1,
      },
    });

    await userEvent.click(await screen.findByRole('link', { name: /Question 1 for Asha Rao/ }));

    expect(
      await screen.findByRole('img', { name: 'Answer photo for question 1' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Added a colon')).toBeInTheDocument();
    expect(screen.getByText('Wrong answer')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/teacher/answer/');
    const back = screen.getByRole('link', { name: /Back to the results/ });
    expect(back).toHaveAttribute('href', `/teacher/results?exam=${EXAM_ID}&batch=A`);
  });
});
