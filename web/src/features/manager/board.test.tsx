import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnswerDetailResponse, ExamBoardResponse } from '@yulove/shared';
import { FakeOidc, fakeUser, meFor, renderApp } from '../../test/helpers.js';
import {
  ASHA,
  BEN_ABSENT,
  EXAM_ID,
  boardOf,
  cell,
  examSummary,
  student,
} from '../../test/fixtures.js';
import { apiError, mockApi, type Route } from '../../test/mockApi.js';

const FAILED = student(
  's4@college.edu',
  'Dev Shah',
  'R4',
  ['GRADED', 'FAILED_TO_GRADE', 'RUNNING'],
  {
    totalScore: 5,
  },
);
FAILED.questions[1] = cell(2, 'FAILED_TO_GRADE', {
  failReason: 'UNREADABLE',
  failDetail: 'The page is too dark.',
});

function setup(
  initial: ExamBoardResponse,
  extra: Record<string, Route> = {},
  route = '/manager/board?batch=A&exam=exam-1',
) {
  // A copy per test: the fake API changes it, and the fixtures are shared.
  const world = { board: structuredClone(initial) };
  const api = mockApi({
    'GET /me': meFor('BATCH_MANAGER', { batchIds: ['A'] }),
    'GET /batches': { batches: [{ batchId: 'A', name: 'Batch A' }] },
    'GET /exams': {
      exams: [
        examSummary(),
        examSummary({ examId: 'exam-9', title: 'Published one', status: 'PUBLISHED' }),
      ],
    },
    'GET /exams/:id/answers': () => world.board,
    ...extra,
  });
  renderApp({ oidc: new FakeOidc(fakeUser()), route });
  return { api, world };
}

afterEach(() => vi.unstubAllGlobals());

describe('the status board', () => {
  it('shows every student and question in plain words', async () => {
    setup(boardOf([ASHA, FAILED, BEN_ABSENT]));

    const dev = (await screen.findByText(/R4 · Dev Shah/)).closest('li') as HTMLElement;
    expect(within(dev).getByText('Graded')).toBeInTheDocument();
    expect(within(dev).getByText('Could not be graded')).toBeInTheDocument();
    expect(within(dev).getByText('Running the code')).toBeInTheDocument();
    expect(
      within(dev).getByText('The photo could not be read. Upload a clearer photo.'),
    ).toBeInTheDocument();
    expect(within(dev).getByText('The page is too dark.')).toBeInTheDocument();

    const asha = screen.getByText(/R1 · Asha Rao/).closest('li') as HTMLElement;
    expect(within(asha).getAllByText('No photo yet')).toHaveLength(3);
    const ben = screen.getByText(/R2 · Ben Rai/).closest('li') as HTMLElement;
    expect(within(ben).getByText('Absent')).toBeInTheDocument();
    expect(within(ben).getByText('Marked absent: 0 marks.')).toBeInTheDocument();
  });

  it('counts the answers by status', async () => {
    setup(boardOf([ASHA, FAILED]));

    const counts = await screen.findByRole('list', { name: 'Answers by status' });
    expect(within(counts).getByText('Graded').closest('li')).toHaveTextContent('1');
    expect(within(counts).getByText('No photo yet').closest('li')).toHaveTextContent('3');
    expect(within(counts).getByText('Could not be graded').closest('li')).toHaveTextContent('1');
  });

  it('only changes when Refresh is pressed', async () => {
    const { api, world } = setup(boardOf([ASHA]));
    await screen.findByText(/R1 · Asha Rao/);
    expect(api.callsTo('GET /exams/:id/answers')).toHaveLength(1);

    // The grading finished meanwhile; nothing changes on screen by itself.
    world.board = boardOf([
      student('s1@college.edu', 'Asha Rao', 'R1', ['GRADED', 'GRADED', 'GRADED']),
    ]);
    expect(screen.queryByText('Graded')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect((await screen.findAllByText('Graded')).length).toBeGreaterThan(0);
    expect(api.callsTo('GET /exams/:id/answers')).toHaveLength(2);
    expect(screen.getByText(/does not update by itself/)).toBeInTheDocument();
  });

  it('can show only the students who need attention, or who are still being graded', async () => {
    setup(
      boardOf([
        ASHA,
        FAILED,
        BEN_ABSENT,
        student('s5@college.edu', 'Eva Roy', 'R5', ['GRADED', 'GRADED', 'GRADED']),
      ]),
    );
    await screen.findByText(/R4 · Dev Shah/);
    const filter = screen.getByLabelText('Show');

    await userEvent.selectOptions(filter, 'attention');
    expect(screen.getByText(/R4 · Dev Shah/)).toBeInTheDocument();
    expect(screen.getByText(/R1 · Asha Rao/)).toBeInTheDocument(); // no photos yet
    expect(screen.queryByText(/R5 · Eva Roy/)).not.toBeInTheDocument();
    expect(screen.queryByText(/R2 · Ben Rai/)).not.toBeInTheDocument(); // absent: nothing to do

    await userEvent.selectOptions(filter, 'grading');
    expect(screen.getByText(/R4 · Dev Shah/)).toBeInTheDocument();
    expect(screen.queryByText(/R1 · Asha Rao/)).not.toBeInTheDocument();
  });

  it('asks for the exam first, from the exams that can take answers', async () => {
    setup(boardOf([ASHA]), {}, '/manager/board');

    await userEvent.selectOptions(await screen.findByLabelText('Exam'), 'exam-9');
    expect(await screen.findByText('Week 3 test')).toBeInTheDocument();
  });

  it('explains when the board cannot be loaded, and can try again', async () => {
    let fail = true;
    setup(boardOf([ASHA]), {
      'GET /exams/:id/answers': () => {
        if (fail) return apiError(404, 'NOT_FOUND', 'No exam exam-1');
        return boardOf([ASHA]);
      },
    });

    expect(await screen.findByText('Could not load the board')).toBeInTheDocument();
    expect(screen.getByText('No exam exam-1')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/R1 · Asha Rao/)).toBeInTheDocument();
  });
});

describe('grading a failed answer again', () => {
  it('offers it only for answers that could not be graded, then refreshes the board', async () => {
    const { api, world } = setup(boardOf([FAILED]), {
      'POST /answers/:examId/:studentEmail/:q/rerun': (call) => {
        const dev = student('s4@college.edu', 'Dev Shah', 'R4', ['GRADED', 'QUEUED', 'RUNNING']);
        world.board = boardOf([dev]);
        return {
          examId: EXAM_ID,
          studentEmail: call.params['studentEmail'],
          questionNumber: 2,
          attempt: 2,
          status: 'QUEUED',
        };
      },
    });

    const buttons = await screen.findAllByRole('button', { name: /Grade question \d again/ });
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]!);

    await waitFor(() =>
      expect(
        screen.queryByText('Could not be graded', { selector: '.chip' }),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findAllByText('Waiting')).not.toHaveLength(0);
    const [call] = api.callsTo('POST /answers/:examId/:studentEmail/:q/rerun');
    expect(call?.params).toMatchObject({ examId: EXAM_ID, studentEmail: 's4@college.edu', q: '2' });
    expect(api.callsTo('GET /exams/:id/answers')).toHaveLength(2);
  });

  it('shows the API’s message when it cannot be graded again', async () => {
    setup(boardOf([FAILED]), {
      'POST /answers/:examId/:studentEmail/:q/rerun': apiError(
        409,
        'CONFLICT',
        'dev@college.edu is marked absent for this exam',
      ),
    });

    await userEvent.click(await screen.findByRole('button', { name: /Grade question 2 again/ }));

    expect(await screen.findByText(/is marked absent for this exam/)).toBeInTheDocument();
  });
});

describe('publishing', () => {
  it('publishes at once when nothing is still being graded', async () => {
    const { api, world } = setup(
      boardOf([student('s1@college.edu', 'Asha Rao', 'R1', ['GRADED', 'GRADED', 'GRADED'])]),
      {
        'POST /exams/:id/publish': () => {
          world.board.examStatus = 'PUBLISHED';
          return { examId: EXAM_ID, status: 'PUBLISHED', inProgress: 0 };
        },
      },
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Publish results' }));

    expect(await screen.findByText('Results published')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish results' })).not.toBeInTheDocument();
    expect(api.callsTo('POST /exams/:id/publish')).toHaveLength(1);
    expect(api.callsTo('POST /exams/:id/publish')[0]?.body).toEqual({});
  });

  it('shows how many answers are still being graded and asks before publishing', async () => {
    const { api, world } = setup(boardOf([FAILED]), {
      'POST /exams/:id/publish': (call) => {
        if ((call.body as { confirm?: boolean }).confirm !== true) {
          return apiError(409, 'CONFLICT', '3 answers are still being graded. Publish anyway?', {
            inProgress: 3,
          });
        }
        world.board.examStatus = 'PUBLISHED';
        return { examId: EXAM_ID, status: 'PUBLISHED', inProgress: 3 };
      },
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Publish results' }));

    const question = await screen.findByRole('alertdialog', { name: 'Publish anyway?' });
    expect(question).toHaveTextContent('3 answers are still being graded.');
    // Nothing is published until the person confirms: only the first request went out, without confirm.
    expect(api.callsTo('POST /exams/:id/publish')).toHaveLength(1);
    expect(api.callsTo('POST /exams/:id/publish')[0]?.body).toEqual({});

    await userEvent.click(screen.getByRole('button', { name: 'Publish anyway' }));

    expect(await screen.findByText('Results published')).toBeInTheDocument();
    expect(api.callsTo('POST /exams/:id/publish')).toHaveLength(2);
    expect(api.callsTo('POST /exams/:id/publish')[1]?.body).toEqual({ confirm: true });
  });

  it('sends nothing more when the person cancels', async () => {
    const { api } = setup(boardOf([FAILED]), {
      'POST /exams/:id/publish': apiError(
        409,
        'CONFLICT',
        '1 answer is still being graded. Publish anyway?',
        { inProgress: 1 },
      ),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Publish results' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      '1 answer is still being graded.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish results' })).toBeInTheDocument();
    expect(api.callsTo('POST /exams/:id/publish')).toHaveLength(1);
  });

  it('shows the API’s message for any other problem, without a confirmation', async () => {
    setup(boardOf([ASHA]), {
      'POST /exams/:id/publish': apiError(
        409,
        'CONFLICT',
        'Only an exam that is READY can be published',
      ),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Publish results' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only an exam that is READY can be published',
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows an exam that is already published as published', async () => {
    setup(boardOf([ASHA], { examStatus: 'PUBLISHED' }));

    expect(await screen.findByText('Results published')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument();
  });
});

describe('viewing one answer', () => {
  const ANSWER: AnswerDetailResponse = {
    examId: EXAM_ID,
    studentEmail: 's4@college.edu',
    questionNumber: 1,
    marks: 10,
    absent: false,
    status: 'GRADED',
    attempt: 2,
    failReason: undefined,
    failDetail: undefined,
    imageUrl: 'https://bucket.s3.amazonaws.com/answers/exam-1/R4/q1.jpg?signed=1',
    imageExpiresInSeconds: 900,
    language: 'python',
    rawTranscription: 'def f(x)\n  return x',
    correctedCode: 'def f(x):\n    return x',
    fixes: ['Added a colon after def f(x)'],
    estimatedComplexity: 'O(n)',
    meetsComplexity: true,
    testsPassed: 1,
    testsTotal: 2,
    verdicts: [
      { index: 0, kind: 'small', verdict: 'AC' },
      { index: 1, kind: 'small', verdict: 'WA', input: '{"x":1}', expected: '1', actual: '2' },
    ],
    score: 5,
    override: undefined,
  };

  it('links from the board and shows the photo, the transcription and the test results', async () => {
    const { api } = setup(boardOf([FAILED]), {
      'GET /answers/:examId/:studentEmail/:q': ANSWER,
    });

    await userEvent.click(
      await screen.findByRole('link', { name: 'View question 1 for Dev Shah' }),
    );

    expect(await screen.findByRole('img', { name: 'Answer photo for question 1' })).toHaveAttribute(
      'src',
      ANSWER.imageUrl,
    );
    expect(screen.getByText(/works for about 15 minutes/)).toBeInTheDocument();
    expect(screen.getByText('Python')).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(screen.getByText(/def f\(x\)\s+return x/)).toBeInTheDocument();
    expect(screen.getByText(/def f\(x\):\s+return x/)).toBeInTheDocument();
    expect(screen.getByText('Added a colon after def f(x)')).toBeInTheDocument();

    const results = screen.getByRole('list', { name: 'Test results' });
    expect(within(results).getByText('Passed')).toBeInTheDocument();
    expect(within(results).getByText('Wrong answer')).toBeInTheDocument();
    expect(api.callsTo('GET /answers/:examId/:studentEmail/:q')[0]?.params).toEqual({
      examId: EXAM_ID,
      studentEmail: 's4@college.edu',
      q: '1',
    });
    expect(screen.getByRole('link', { name: /Back to the board/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/manager/board?exam=exam-1&batch=A'),
    );
  });

  it('explains a failed answer and lets it be graded again', async () => {
    const { api } = setup(
      boardOf([FAILED]),
      {
        'GET /answers/:examId/:studentEmail/:q': {
          ...ANSWER,
          status: 'FAILED_TO_GRADE',
          failReason: 'GEMINI_ERROR',
          failDetail: 'Busy',
          verdicts: [],
        },
        'POST /answers/:examId/:studentEmail/:q/rerun': {
          examId: EXAM_ID,
          attempt: 3,
          status: 'QUEUED',
        },
      },
      `/manager/answer/${EXAM_ID}/s4%40college.edu/2?batch=A`,
    );

    expect(
      await screen.findByText(/The reading service had a problem\. Try grading again\. Busy/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Grade again' }));

    expect(await screen.findByText(/Sent for grading again/)).toBeInTheDocument();
    expect(api.callsTo('POST /answers/:examId/:studentEmail/:q/rerun')).toHaveLength(1);
  });

  it('says so when no photo has been uploaded for the question', async () => {
    setup(
      boardOf([ASHA]),
      {
        'GET /answers/:examId/:studentEmail/:q': apiError(
          404,
          'NOT_FOUND',
          'No answer has been submitted for this question',
        ),
      },
      `/manager/answer/${EXAM_ID}/s1%40college.edu/1?batch=A`,
    );

    expect(await screen.findByText('No photo yet')).toBeInTheDocument();
  });
});
