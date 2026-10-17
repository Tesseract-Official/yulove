import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeOidc, fakeUser, jsonResponse, meFor, renderApp } from '../../test/helpers.js';
import {
  EXAM_ID,
  TEACHER_EMAIL,
  examDetail,
  examSummary,
  questionSummary,
} from '../../test/fixtures.js';
import { apiError, mockApi, type Route } from '../../test/mockApi.js';

vi.mock('../common/download.js', () => ({ startDownload: vi.fn() }));
const { startDownload } = await import('../common/download.js');

const QUESTIONS = [
  questionSummary({ questionId: 'q1', title: 'Two Sum', testStatus: 'APPROVED' }),
  questionSummary({
    questionId: 'q2',
    title: 'Valid Parentheses',
    testStatus: 'APPROVED',
    version: 2,
  }),
  questionSummary({ questionId: 'q3', title: 'Still Reviewing', testStatus: 'NEEDS_REVIEW' }),
  questionSummary({ questionId: 'q4', title: 'Not Generated' }),
  questionSummary({ questionId: 'q5', title: 'Third Approved', testStatus: 'APPROVED' }),
];

function open(
  route: string,
  extra: Record<string, Route> = {},
  role: 'TEACHER' | 'SUPER_ADMIN' = 'TEACHER',
) {
  const api = mockApi({
    'GET /me': meFor(role, { batchIds: ['A'], email: TEACHER_EMAIL }),
    'GET /batches': {
      batches: [
        { batchId: 'A', name: 'Batch A' },
        { batchId: 'B', name: 'Batch B' },
      ],
    },
    'GET /questions': { questions: QUESTIONS },
    'GET /exams': { exams: [] },
    'GET /exams/:id': examDetail(),
    ...extra,
  });
  renderApp({ oidc: new FakeOidc(fakeUser()), route });
  return api;
}

beforeEach(() => vi.mocked(startDownload).mockClear());
afterEach(() => vi.unstubAllGlobals());

describe('the exams list', () => {
  it('lists the exams of the teacher’s batches with their state', async () => {
    open('/teacher/exams', {
      'GET /exams': {
        exams: [
          examSummary({ examId: 'e1', title: 'Week 3', status: 'DRAFT' }),
          examSummary({
            examId: 'e2',
            title: 'Week 2',
            status: 'READY',
            batchId: 'B',
            questionCount: 1,
          }),
          examSummary({
            examId: 'e3',
            title: 'Week 1',
            status: 'PUBLISHED',
            createdBy: 'other@college.edu',
          }),
        ],
      },
    });

    const card = (title: string) => screen.getByText(title).closest('li') as HTMLElement;
    expect(await screen.findByText('Week 3')).toBeInTheDocument();
    expect(within(card('Week 3')).getByText('Draft')).toBeInTheDocument();
    expect(
      within(card('Week 3')).getByText(/Batch A · 2026-10-24 · 3 questions/),
    ).toBeInTheDocument();
    expect(within(card('Week 2')).getByText('PDF ready')).toBeInTheDocument();
    expect(within(card('Week 2')).getByText(/Batch B · .* · 1 question$/)).toBeInTheDocument();
    expect(within(card('Week 1')).getByText('Published')).toBeInTheDocument();
    expect(within(card('Week 1')).getByText('Made by other@college.edu')).toBeInTheDocument();
    expect(within(card('Week 3')).getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/teacher/exams/e1',
    );
    // A draft has no results yet.
    expect(within(card('Week 3')).queryByRole('link', { name: 'Results' })).not.toBeInTheDocument();
    expect(within(card('Week 2')).getByRole('link', { name: 'Results' })).toHaveAttribute(
      'href',
      '/teacher/results?batch=B&exam=e2',
    );
  });

  it('explains when there are no exams yet', async () => {
    open('/teacher/exams');

    expect(await screen.findByText('No exams yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Build a new exam' })).toHaveAttribute(
      'href',
      '/teacher/exams/new',
    );
  });
});

async function addQuestion(title: string) {
  await userEvent.selectOptions(
    await screen.findByLabelText('Add a question (approved ones only)'),
    title,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
}

describe('building a new exam', () => {
  it('offers only approved questions', async () => {
    open('/teacher/exams/new');

    const select = await screen.findByLabelText('Add a question (approved ones only)');
    const titles = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(titles).toEqual([
      'Choose a question…',
      'Two Sum',
      'Valid Parentheses',
      'Third Approved',
    ]);
  });

  it('says what to do when there are no approved questions', async () => {
    open('/teacher/exams/new', { 'GET /questions': { questions: [QUESTIONS[2]!] } });

    expect(await screen.findByText(/You have no approved questions yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Write or approve one' })).toHaveAttribute(
      'href',
      '/teacher/questions',
    );
  });

  it('adds questions in order with marks, and shows the total', async () => {
    open('/teacher/exams/new');

    await addQuestion('Two Sum');
    await addQuestion('Valid Parentheses');

    expect(screen.getByText('Question 1: Two Sum')).toBeInTheDocument();
    expect(screen.getByText('Question 2: Valid Parentheses')).toBeInTheDocument();
    expect(screen.getByText('Total marks: 20')).toBeInTheDocument();
    // A question already in the exam cannot be added twice.
    const select = screen.getByLabelText('Add a question (approved ones only)');
    expect(within(select).queryByRole('option', { name: 'Two Sum' })).not.toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Marks for question 2'));
    await userEvent.type(screen.getByLabelText('Marks for question 2'), '5');
    expect(screen.getByText('Total marks: 15')).toBeInTheDocument();
  });

  it('moves and removes questions, and the order is the order sent', async () => {
    const api = open('/teacher/exams/new', {
      'POST /exams': (call) =>
        jsonResponse(
          { exam: { ...(call.body as object), examId: 'new-exam', status: 'DRAFT' } },
          201,
        ),
    });
    await userEvent.selectOptions(await screen.findByLabelText('Batch'), 'A');
    await userEvent.type(screen.getByLabelText('Title'), 'Week 4');
    await addQuestion('Two Sum');
    await addQuestion('Valid Parentheses');
    await addQuestion('Third Approved');

    await userEvent.click(screen.getByRole('button', { name: 'Move question 3 up' }));
    expect(screen.getByRole('button', { name: 'Move question 1 up' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove question 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save exam' }));

    await waitFor(() => expect(api.callsTo('POST /exams')).toHaveLength(1));
    const body = api.callsTo('POST /exams')[0]!.body as {
      questions: unknown[];
      batchId: string;
      title: string;
    };
    expect(body.batchId).toBe('A');
    expect(body.title).toBe('Week 4');
    // After moving "Third Approved" up and removing "Two Sum": Third Approved, then Parentheses.
    expect(body.questions).toEqual([
      { number: 1, questionId: 'q5', version: 1, marks: 10 },
      { number: 2, questionId: 'q2', version: 2, marks: 10 },
    ]);
  });

  it('shows what is missing and sends nothing', async () => {
    const api = open('/teacher/exams/new');

    await userEvent.click(await screen.findByRole('button', { name: 'Save exam' }));

    expect(
      await screen.findByText('Some answers need fixing. They are marked below.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Choose the batch that will write this exam.')).toBeInTheDocument();
    expect(screen.getByText('Type a title for the exam.')).toBeInTheDocument();
    expect(screen.getByText('Add at least one question.')).toBeInTheDocument();
    expect(api.callsTo('POST /exams')).toHaveLength(0);
  });

  it('asks for marks above 0 beside the question', async () => {
    const api = open('/teacher/exams/new');
    await userEvent.selectOptions(await screen.findByLabelText('Batch'), 'A');
    await userEvent.type(screen.getByLabelText('Title'), 'Week 4');
    await addQuestion('Two Sum');
    await userEvent.clear(screen.getByLabelText('Marks for question 1'));
    await userEvent.type(screen.getByLabelText('Marks for question 1'), '0');

    await userEvent.click(screen.getByRole('button', { name: 'Save exam' }));

    expect(await screen.findByText('Type the marks as a number above 0.')).toBeInTheDocument();
    expect(screen.getByLabelText('Marks for question 1')).toHaveAttribute('aria-invalid', 'true');
    expect(api.callsTo('POST /exams')).toHaveLength(0);
  });

  it('opens the saved exam, ready for its PDF', async () => {
    open('/teacher/exams/new', {
      'POST /exams': jsonResponse({ exam: { examId: 'new-exam' } }, 201),
      'GET /exams/:id': examDetail({ examId: 'new-exam' }),
    });
    await userEvent.selectOptions(await screen.findByLabelText('Batch'), 'A');
    await userEvent.type(screen.getByLabelText('Title'), 'Week 4');
    await addQuestion('Two Sum');
    await userEvent.click(screen.getByRole('button', { name: 'Save exam' }));

    expect(await screen.findByText('Exam saved. Next: make its PDF.')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/teacher/exams/new-exam');
  });

  it('shows the API’s message when saving fails', async () => {
    open('/teacher/exams/new', {
      'POST /exams': apiError(
        422,
        'VALIDATION_FAILED',
        'Only approved questions can be used. Not approved: q3 v1',
      ),
    });
    await userEvent.selectOptions(await screen.findByLabelText('Batch'), 'A');
    await userEvent.type(screen.getByLabelText('Title'), 'Week 4');
    await addQuestion('Two Sum');
    await userEvent.click(screen.getByRole('button', { name: 'Save exam' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only approved questions can be used',
    );
  });
});

describe('an exam that exists', () => {
  it('shows it ready to change, with the batch fixed', async () => {
    open(`/teacher/exams/${EXAM_ID}`);

    expect(await screen.findByLabelText('Title')).toHaveValue('Week 3 test');
    expect(screen.getByLabelText('Date of the exam')).toHaveValue('2026-10-24');
    expect(screen.getByText('Question 1: Two Sum')).toBeInTheDocument();
    expect(screen.getByLabelText('Marks for question 2')).toHaveValue('5');
    // The batch name arrives with the list of batches.
    await waitFor(() =>
      expect(screen.getByText('Batch:').parentElement).toHaveTextContent('Batch A'),
    );
    expect(screen.queryByLabelText('Batch')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('saves a change with the whole question list', async () => {
    const api = open(`/teacher/exams/${EXAM_ID}`, {
      'PUT /exams/:id': (call) =>
        jsonResponse({ exam: { examId: call.params['id'] }, changed: true }),
    });

    await userEvent.type(await screen.findByLabelText('Title'), ' (final)');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/Saved\. Make the PDF again/)).toBeInTheDocument();
    const [call] = api.callsTo('PUT /exams/:id');
    expect(call?.params['id']).toBe(EXAM_ID);
    expect(call?.body).toEqual({
      batchId: 'A',
      title: 'Week 3 test (final)',
      date: '2026-10-24',
      questions: [
        { number: 1, questionId: 'q1', version: 1, marks: 10 },
        { number: 2, questionId: 'q2', version: 1, marks: 5 },
      ],
    });
  });

  it('warns that changing a finished exam removes its PDF', async () => {
    open(`/teacher/exams/${EXAM_ID}`, {
      'GET /exams/:id': examDetail({ status: 'READY' }, { hasPdf: true }),
    });

    await userEvent.type(await screen.findByLabelText('Title'), '!');

    expect(
      await screen.findByText(/sends the exam back to Draft and removes its PDF/),
    ).toBeInTheDocument();
  });

  it('flags a question that is no longer approved', async () => {
    open(`/teacher/exams/${EXAM_ID}`, {
      'GET /exams/:id': examDetail({
        questions: [
          {
            number: 1,
            questionId: 'q1',
            version: 1,
            marks: 10,
            title: 'Two Sum',
            testStatus: 'GENERATING',
            exists: true,
          },
          {
            number: 2,
            questionId: 'gone',
            version: 1,
            marks: 5,
            title: undefined,
            testStatus: undefined,
            exists: false,
          },
        ],
      }),
    });

    expect(await screen.findByText('No longer approved (Generating)')).toBeInTheDocument();
    expect(screen.getByText('No longer exists')).toBeInTheDocument();
  });

  it('explains when the exam cannot be loaded', async () => {
    open(`/teacher/exams/${EXAM_ID}`, {
      'GET /exams/:id': apiError(404, 'NOT_FOUND', 'No exam exam-1'),
    });

    expect(await screen.findByText('Could not load the exam')).toBeInTheDocument();
  });
});

describe('an exam with answers (locked)', () => {
  const locked = () => ({
    'GET /exams/:id': examDetail({ status: 'READY' }, { hasAnswers: true, hasPdf: true }),
  });

  it('says the questions and marks are locked, and keeps the title and date editable', async () => {
    open(`/teacher/exams/${EXAM_ID}`, locked());

    expect(await screen.findByText(/questions and marks are locked/)).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeEnabled();
    expect(screen.getByLabelText('Date of the exam')).toBeEnabled();
    expect(screen.getByLabelText('Marks for question 1')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Move question/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove question/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Add a question (approved ones only)')).not.toBeInTheDocument();
  });

  it('still saves a new title, sending the questions unchanged', async () => {
    const api = open(`/teacher/exams/${EXAM_ID}`, {
      ...locked(),
      'PUT /exams/:id': jsonResponse({ exam: { examId: EXAM_ID }, changed: true }),
    });

    await userEvent.type(await screen.findByLabelText('Title'), ' B');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.callsTo('PUT /exams/:id')).toHaveLength(1));
    expect(api.callsTo('PUT /exams/:id')[0]?.body).toMatchObject({
      title: 'Week 3 test B',
      questions: [
        { number: 1, questionId: 'q1', version: 1, marks: 10 },
        { number: 2, questionId: 'q2', version: 1, marks: 5 },
      ],
    });
  });
});

describe('an exam that is published, or made by someone else', () => {
  it('cannot be changed once published, but its PDF can still be made', async () => {
    open(`/teacher/exams/${EXAM_ID}`, {
      'GET /exams/:id': examDetail(
        { status: 'PUBLISHED' },
        { canEdit: false, hasPdf: true, hasAnswers: true },
      ),
    });

    expect(
      await screen.findByText(/This exam is published, so it cannot be changed/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make the PDF again' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
  });

  it('is read-only for another teacher, who also cannot make its PDF', async () => {
    open(`/teacher/exams/${EXAM_ID}`, {
      'GET /exams/:id': examDetail({ createdBy: 'other@college.edu' }, { canEdit: false }),
    });

    expect(
      await screen.findByText(/Only other@college\.edu can change this exam/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Only other@college\.edu can make or download the PDF/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate PDF' })).not.toBeInTheDocument();
  });

  it('lets a super admin change another teacher’s exam', async () => {
    open(
      `/teacher/exams/${EXAM_ID}`,
      { 'GET /exams/:id': examDetail({ createdBy: 'other@college.edu' }, { canEdit: true }) },
      'SUPER_ADMIN',
    );

    expect(await screen.findByRole('button', { name: 'Save changes' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Generate PDF' })).toBeInTheDocument();
  });
});

describe('the PDF', () => {
  it('makes the PDF, says it can take a while, and then offers the download', async () => {
    let hasPdf = false;
    const api = open(`/teacher/exams/${EXAM_ID}`, {
      'GET /exams/:id': () => examDetail({ status: hasPdf ? 'READY' : 'DRAFT' }, { hasPdf }),
      'POST /exams/:id/pdf': () => {
        hasPdf = true;
        return { examId: EXAM_ID, status: 'READY', pdfKey: 'exams/exam-1/paper.pdf', pageCount: 2 };
      },
    });

    expect(
      await screen.findByText(/No PDF has been made yet\. Making it can take up to half a minute/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Generate PDF' }));

    expect(
      await screen.findByText('The PDF is ready. You can download it now.'),
    ).toBeInTheDocument();
    expect(api.callsTo('POST /exams/:id/pdf')).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download PDF' })).toBeEnabled());
    expect(screen.getByText('PDF ready')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the results' })).toHaveAttribute(
      'href',
      '/teacher/results?batch=A&exam=exam-1',
    );
  });

  it('downloads the PDF through the link the API gives', async () => {
    const api = open(`/teacher/exams/${EXAM_ID}`, {
      'GET /exams/:id': examDetail({ status: 'READY' }, { hasPdf: true }),
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
    expect(api.callsTo('GET /exams/:id/pdf')).toHaveLength(1);
  });

  it('waits for unsaved changes to be saved first', async () => {
    open(`/teacher/exams/${EXAM_ID}`, {
      'GET /exams/:id': examDetail({ status: 'READY' }, { hasPdf: true }),
    });

    await userEvent.type(await screen.findByLabelText('Title'), '!');

    expect(
      screen.getByText('Save your changes first, so the PDF matches them.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make the PDF again' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeDisabled();
  });

  it('shows the API’s message when the PDF cannot be made', async () => {
    open(`/teacher/exams/${EXAM_ID}`, {
      'POST /exams/:id/pdf': apiError(
        409,
        'CONFLICT',
        'These questions are no longer approved: q1 v1. Approve them again or change the exam.',
      ),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Generate PDF' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('no longer approved');
  });
});
