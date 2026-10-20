import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MyExamResultResponse } from '@yulove/shared';
import { FakeOidc, fakeUser, meFor, renderApp } from '../../test/helpers.js';
import { EXAM_ID, myExam, studentQuestion } from '../../test/fixtures.js';
import { apiError, mockApi, type Route } from '../../test/mockApi.js';

const ME = meFor('STUDENT', { batchId: 'A', email: 's1@college.edu' });

function open(route: string, routes: Record<string, Route> = {}) {
  const api = mockApi({
    'GET /me': ME,
    'GET /me/exams': { exams: [] },
    ...routes,
  });
  renderApp({ oidc: new FakeOidc(fakeUser()), route });
  return api;
}

const card = (n: number) =>
  screen.getByRole('heading', { name: `Question ${n}` }).closest('li') as HTMLElement;

afterEach(() => vi.unstubAllGlobals());

describe('the list of published exams', () => {
  it('shows each exam with the student’s total, and a way in', async () => {
    open('/student', {
      'GET /me/exams': {
        exams: [
          {
            examId: 'e2',
            title: 'Week 3',
            date: '2026-10-24',
            absent: false,
            totalScore: 34,
            maxScore: 50,
          },
          {
            examId: 'e1',
            title: 'Week 2',
            date: '2026-10-17',
            absent: true,
            totalScore: 0,
            maxScore: 40,
          },
        ],
      },
    });

    const week3 = (await screen.findByText('Week 3')).closest('li') as HTMLElement;
    expect(within(week3).getByText('34 / 50')).toBeInTheDocument();
    expect(within(week3).getByText('2026-10-24')).toBeInTheDocument();
    expect(within(week3).getByRole('link', { name: 'See my marks' })).toHaveAttribute(
      'href',
      '/student/exams/e2',
    );
    const week2 = screen.getByText('Week 2').closest('li') as HTMLElement;
    expect(within(week2).getByText('Absent')).toBeInTheDocument();
    expect(within(week2).queryByText(/\/ 40/)).not.toBeInTheDocument();
  });

  it('says so when nothing has been published yet', async () => {
    open('/student');

    expect(await screen.findByText('Nothing published yet')).toBeInTheDocument();
    expect(
      screen.getByText(/They will appear here when your batch manager publishes them/),
    ).toBeInTheDocument();
  });

  it('explains when the list cannot be loaded', async () => {
    open('/student', { 'GET /me/exams': apiError(403, 'FORBIDDEN', 'Your role cannot do this') });

    expect(await screen.findByText('Could not load your results')).toBeInTheDocument();
  });
});

describe('one exam', () => {
  const exam = (questions = [studentQuestion()], extra: Partial<MyExamResultResponse> = {}) =>
    myExam(questions, extra);

  it('shows the total and marks out of marks for every question', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': exam([
        studentQuestion({ number: 1, marks: 10, score: 7.5 }),
        studentQuestion({ number: 2, marks: 5, score: 5, testsPassed: 10, testsTotal: 10 }),
      ]),
    });

    expect(await screen.findByText('12.5')).toBeInTheDocument();
    expect(screen.getByText(/out of 15/)).toBeInTheDocument();
    expect(within(card(1)).getByText('7.5 / 10')).toBeInTheDocument();
    expect(within(card(2)).getByText('5 / 5')).toBeInTheDocument();
    expect(within(card(1)).getByText('7 of 10 tests passed')).toBeInTheDocument();
    expect(within(card(2)).getByText('10 of 10 tests passed')).toBeInTheDocument();
  });

  it('shows each failed small test with the input, the expected output and their output', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': exam([
        studentQuestion({
          failedSmallTests: [
            { index: 2, verdict: 'WA', input: '{"n":3}', expected: '6', actual: '5' },
            { index: 4, verdict: 'RE' },
          ],
        }),
      ]),
    });

    await screen.findByRole('heading', { name: 'Question 1' });
    const tests = within(card(1)).getByRole('list', {
      name: 'Tests that did not pass in question 1',
    });
    const third = within(tests).getByText('Test 3: wrong answer').closest('li') as HTMLElement;
    expect(within(third).getByText('{"n":3}')).toBeInTheDocument();
    expect(within(third).getByText('6')).toBeInTheDocument();
    expect(within(third).getByText('5')).toBeInTheDocument();
    expect(within(third).getByText('Your output')).toBeInTheDocument();
    expect(within(tests).getByText('Test 5: crashed')).toBeInTheDocument();
  });

  it('folds long or multi-line values away', async () => {
    const long = JSON.stringify({ nums: Array.from({ length: 60 }, (_, i) => i) });
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': exam([
        studentQuestion({
          failedSmallTests: [
            { index: 0, verdict: 'WA', input: long, expected: 'a\nb', actual: '1' },
          ],
        }),
      ]),
    });

    await screen.findByRole('heading', { name: 'Question 1' });
    const test = within(card(1))
      .getByText(/Test 1: wrong answer/)
      .closest('li') as HTMLElement;
    expect(
      within(test)
        .getByText(/Input \(\d+ characters\)/)
        .closest('details'),
    ).not.toHaveAttribute('open');
    expect(within(test).getByText('Expected output (3 characters)')).toBeInTheDocument();
    // The short single-line one is shown straight away.
    expect(within(test).getByText('Your output').closest('details')).toBeNull();
  });

  it.each([
    ['TLE', 'too slow'],
    ['WA', 'wrong answer'],
    ['RE', 'crashed'],
    ['MLE', 'used too much memory'],
    ['CE', 'did not compile'],
  ] as const)(
    'puts a failed large test (%s) in plain words: "Large test 2: %s"',
    async (verdict, words) => {
      open(`/student/exams/${EXAM_ID}`, {
        'GET /me/exams/:id': exam([
          studentQuestion({
            failedLargeTests: [
              { label: 'Large test 2', verdict, message: `Large test 2: ${verdict}` },
            ],
          }),
        ]),
      });

      expect(await screen.findByText(`Large test 2: ${words}`)).toBeInTheDocument();
    },
  );

  it('shows the complexity message', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': exam([
        studentQuestion({
          score: 0,
          testsPassed: 10,
          messages: ['Did not meet the required time complexity, O(n)'],
        }),
      ]),
    });

    expect(
      await screen.findByText('Did not meet the required time complexity, O(n)'),
    ).toBeInTheDocument();
  });

  it('says a question could not be graded, and offers an appeal', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': exam([
        studentQuestion({
          status: 'FAILED_TO_GRADE',
          score: 0,
          messages: ['Could not be graded — raise an appeal'],
          testsPassed: undefined,
          testsTotal: undefined,
        }),
      ]),
    });

    expect(await screen.findByText('Could not be graded — raise an appeal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Raise an appeal' })).toBeInTheDocument();
    expect(screen.queryByText(/tests passed/)).not.toBeInTheDocument();
  });

  it('says when no answer was submitted, or one is still being graded', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': exam([
        studentQuestion({
          number: 1,
          status: 'NOT_SUBMITTED',
          score: 0,
          messages: ['No answer was submitted'],
          canAppeal: false,
          testsPassed: undefined,
          testsTotal: undefined,
        }),
        studentQuestion({
          number: 2,
          status: 'IN_PROGRESS',
          score: 0,
          messages: ['Still being graded'],
          canAppeal: false,
          testsPassed: undefined,
          testsTotal: undefined,
        }),
      ]),
    });

    await screen.findByRole('heading', { name: 'Question 1' });
    expect(within(card(1)).getByText('No answer was submitted')).toBeInTheDocument();
    expect(within(card(2)).getByText('Still being graded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Raise an appeal' })).not.toBeInTheDocument();
  });

  it('says Absent across the exam when the student was marked absent', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': exam(
        [
          studentQuestion({
            status: 'ABSENT',
            score: 0,
            messages: ['Absent'],
            canAppeal: false,
            testsPassed: undefined,
            testsTotal: undefined,
          }),
        ],
        { absent: true, message: 'Absent', totalScore: 0 },
      ),
    });

    expect(await screen.findByText(/You were marked absent for this exam/)).toBeInTheDocument();
    expect(within(card(1)).getByText('Absent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Raise an appeal' })).not.toBeInTheDocument();
  });

  it('shows only the score when a super admin changed it: no label, no mention of an admin', async () => {
    // The API sends no marker for a super admin's override; the page must not invent one.
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': exam([studentQuestion({ score: 9 })]),
    });

    expect(await screen.findByText('9 / 10')).toBeInTheDocument();
    expect(screen.queryByText(/adjusted/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/admin/i);
  });

  it('says when a teacher adjusted the score, as an information line', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': exam([
        studentQuestion({
          score: 9,
          adjusted: true,
          adjustedBy: 'teacher',
          messages: ['Score adjusted by teacher'],
        }),
      ]),
    });

    const line = await screen.findByText('Score adjusted by teacher');
    expect(line).toHaveClass('notice-info');
    expect(document.body.textContent).not.toMatch(/admin/i);
  });

  it('explains when the exam cannot be found', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': apiError(404, 'NOT_FOUND', 'No exam exam-1'),
    });

    expect(await screen.findByText('Could not load your marks')).toBeInTheDocument();
  });
});

describe('appeals', () => {
  it('are hidden while one is open, and the student sees its status', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': myExam([
        studentQuestion({
          canAppeal: false,
          appeal: {
            appealId: 'ap1',
            status: 'OPEN',
            message: 'The reader misread my loop.',
            createdAt: '2026-10-25T10:00:00.000Z',
          },
        }),
      ]),
    });

    expect(await screen.findByText('Waiting for a reviewer')).toBeInTheDocument();
    expect(screen.getByText('“The reader misread my loop.”')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Raise an appeal' })).not.toBeInTheDocument();
  });

  it('show the reviewer’s note once graded again, and can be raised again', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': myExam([
        studentQuestion({
          appeal: {
            appealId: 'ap1',
            status: 'RERUN',
            message: 'Please check.',
            note: 'We used your better photo.',
            createdAt: '2026-10-25T10:00:00.000Z',
          },
        }),
      ]),
    });

    expect(await screen.findByText('Your answer was graded again')).toBeInTheDocument();
    expect(screen.getByText(/We used your better photo\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Raise an appeal' })).toBeInTheDocument();
  });

  it('show a closed appeal with its note, and can be raised again', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': myExam([
        studentQuestion({
          appeal: {
            appealId: 'ap1',
            status: 'CLOSED',
            message: 'Unfair.',
            note: 'The code really is wrong.',
            createdAt: '2026-10-25T10:00:00.000Z',
          },
        }),
      ]),
    });

    expect(await screen.findByText('Closed')).toBeInTheDocument();
    expect(screen.getByText(/The code really is wrong\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Raise an appeal' })).toBeInTheDocument();
  });

  it('offer the four reasons, none chosen, and will not send without one', async () => {
    const api = open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': myExam([studentQuestion()]),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Raise an appeal' }));
    const reasons = screen.getAllByRole('radio').map((r) => r.closest('label')?.textContent);
    expect(reasons).toEqual([
      'Photo is unclear or cut off',
      'My code was read wrong',
      'Wrong marks for a correct answer',
      'Other',
    ]);
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();

    await userEvent.type(screen.getByLabelText(/Tell the reviewer/), 'Please look again.');
    await userEvent.click(screen.getByRole('button', { name: 'Send appeal' }));

    expect(await screen.findByText('Choose what went wrong first.')).toBeInTheDocument();
    expect(api.callsTo('POST /appeals')).toHaveLength(0);
  });

  it('show the reason the student gave', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': myExam([
        studentQuestion({
          canAppeal: false,
          appeal: {
            appealId: 'ap1',
            status: 'OPEN',
            reason: 'PHOTO_UNCLEAR',
            message: 'The corner is cut off.',
            createdAt: '2026-10-25T10:00:00.000Z',
          },
        }),
      ]),
    });

    expect(await screen.findByText('Photo is unclear or cut off')).toBeInTheDocument();
  });

  it('use a form with a message limit of 1,000 characters and a counter', async () => {
    open(`/student/exams/${EXAM_ID}`, { 'GET /me/exams/:id': myExam([studentQuestion()]) });

    await userEvent.click(await screen.findByRole('button', { name: 'Raise an appeal' }));
    const box = screen.getByLabelText(/Tell the reviewer what you think is wrong with question 1/);
    expect(screen.getByText('0 / 1000')).toBeInTheDocument();
    expect(box).toHaveAttribute('maxlength', '1000');

    await userEvent.type(box, 'Hello there');
    expect(screen.getByText('11 / 1000')).toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste('x'.repeat(1100));
    expect(screen.getByText('1000 / 1000')).toBeInTheDocument();
    expect((box as HTMLTextAreaElement).value).toHaveLength(1000);
  });

  it('cannot be sent empty', async () => {
    const api = open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': myExam([studentQuestion()]),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Raise an appeal' }));
    await userEvent.click(screen.getByLabelText('Other'));
    await userEvent.type(screen.getByLabelText(/Tell the reviewer/), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Send appeal' }));

    expect(
      await screen.findByText('Write a short message for the reviewer first.'),
    ).toBeInTheDocument();
    expect(api.callsTo('POST /appeals')).toHaveLength(0);
  });

  it('are sent with the exam, the question and the message, and nobody else’s name', async () => {
    let appealed = false;
    const api = open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': () =>
        myExam([
          appealed
            ? studentQuestion({
                canAppeal: false,
                appeal: {
                  appealId: 'ap1',
                  status: 'OPEN',
                  message: 'Please look again.',
                  createdAt: '2026-10-25T10:00:00.000Z',
                },
              })
            : studentQuestion(),
        ]),
      'POST /appeals': () => {
        appealed = true;
        return new Response(JSON.stringify({ appeal: { appealId: 'ap1' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Raise an appeal' }));
    await userEvent.click(screen.getByLabelText('My code was read wrong'));
    await userEvent.type(screen.getByLabelText(/Tell the reviewer/), '  Please look again.  ');
    await userEvent.click(screen.getByRole('button', { name: 'Send appeal' }));

    expect(await screen.findByText('Waiting for a reviewer')).toBeInTheDocument();
    expect(api.callsTo('POST /appeals')[0]?.body).toEqual({
      examId: EXAM_ID,
      questionNumber: 1,
      reason: 'CODE_READ_WRONG',
      message: 'Please look again.',
    });
    expect(screen.queryByRole('button', { name: 'Raise an appeal' })).not.toBeInTheDocument();
  });

  it('show a plain message when one is already open, and refresh the card', async () => {
    const api = open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': myExam([studentQuestion()]),
      'POST /appeals': apiError(
        409,
        'CONFLICT',
        'You already have an open appeal on this question',
      ),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Raise an appeal' }));
    await userEvent.click(screen.getByLabelText('Other'));
    await userEvent.type(screen.getByLabelText(/Tell the reviewer/), 'Again');
    await userEvent.click(screen.getByRole('button', { name: 'Send appeal' }));

    expect(
      await screen.findByText('You already have an open appeal on this question'),
    ).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo('GET /me/exams/:id')).toHaveLength(2));
  });

  it('can be cancelled', async () => {
    const api = open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': myExam([studentQuestion()]),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Raise an appeal' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Raise an appeal' })).toBeInTheDocument();
    expect(api.callsTo('POST /appeals')).toHaveLength(0);
  });
});

describe('the student’s own graded photo', () => {
  const PHOTO =
    'https://bucket.s3.ap-south-1.amazonaws.com/answers/exam-1/R1/q1.jpg?X-Amz-Expires=300';
  const photoRoute = { url: PHOTO, expiresInSeconds: 300 };

  it('is shown on each answered question, fetched from the student’s own photo route', async () => {
    const api = open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': myExam([
        studentQuestion({ hasPhoto: true }),
        studentQuestion({ number: 2, marks: 5, hasPhoto: false, status: 'NOT_SUBMITTED' }),
      ]),
      'GET /me/exams/:id/questions/:q/photo': photoRoute,
    });

    const image = await within(
      await screen.findByRole('heading', { name: 'Question 1' }).then(() => card(1)),
    ).findByRole('img', { name: 'Your photo for question 1' });
    expect(image).toHaveAttribute('src', PHOTO);
    expect(within(card(2)).queryByRole('img')).not.toBeInTheDocument();
    expect(api.callsTo('GET /me/exams/:id/questions/:q/photo').map((c) => c.path)).toEqual([
      `/me/exams/${EXAM_ID}/questions/1/photo`,
    ]);
  });

  it('opens full screen when tapped, with zoom controls, and closes again', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': myExam([studentQuestion({ hasPhoto: true })]),
      'GET /me/exams/:id/questions/:q/photo': photoRoute,
    });

    await userEvent.click(
      await screen.findByRole('button', { name: 'Your photo for question 1: open full screen' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Your photo for question 1' });
    expect(within(dialog).getByRole('img')).toHaveAttribute('src', PHOTO);
    expect(within(dialog).getByText('100%')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    expect(within(dialog).getByText('150%')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Zoom out' }));
    expect(within(dialog).getByText('100%')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes with Escape', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': myExam([studentQuestion({ hasPhoto: true })]),
      'GET /me/exams/:id/questions/:q/photo': photoRoute,
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Your photo for question 1: open full screen' }),
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says so, with a retry, when the photo cannot be loaded; the marks still show', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': myExam([studentQuestion({ hasPhoto: true })]),
      'GET /me/exams/:id/questions/:q/photo': apiError(404, 'NOT_FOUND', 'no photo'),
    });
    expect(await screen.findByText(/Your photo could not be loaded/)).toBeInTheDocument();
    expect(screen.getByText('7 / 10')).toBeInTheDocument();
  });
});

describe('a student’s own data only', () => {
  it('only ever asks for the student’s own routes', async () => {
    const api = open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': myExam([studentQuestion()]),
      'POST /appeals': { appeal: {} },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Raise an appeal' }));
    await userEvent.click(screen.getByLabelText('Wrong marks for a correct answer'));
    await userEvent.type(screen.getByLabelText(/Tell the reviewer/), 'Hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send appeal' }));
    await waitFor(() => expect(api.callsTo('POST /appeals')).toHaveLength(1));

    const asked = api.calls.map((c) => `${c.method} ${c.path}`);
    for (const call of asked) {
      expect(call).toMatch(
        /^(GET \/me(\/exams(\/[^/]+(\/questions\/\d+\/photo)?)?)?|POST \/appeals)$/,
      );
    }
    // Nothing in what was sent names another student or an email.
    expect(JSON.stringify(api.callsTo('POST /appeals')[0]?.body)).not.toContain('@');
  });
});

describe('pinching the full-screen photo', () => {
  const PHOTO = 'https://bucket.s3.ap-south-1.amazonaws.com/answers/exam-1/R1/q1.jpg';

  it('zooms with two fingers moving apart, drags when zoomed and double-taps back to fit', async () => {
    open(`/student/exams/${EXAM_ID}`, {
      'GET /me/exams/:id': myExam([studentQuestion({ hasPhoto: true })]),
      'GET /me/exams/:id/questions/:q/photo': { url: PHOTO, expiresInSeconds: 300 },
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Your photo for question 1: open full screen' }),
    );
    const frame = screen.getByTestId('photo-frame');
    frame.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600 }) as DOMRect;
    const image = within(frame).getByRole('img');
    const pointer = (type: string, id: number, x: number, y: number) =>
      fireEvent(
        frame,
        Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }), {
          pointerId: id,
        }),
      );

    // Two fingers 100 px apart, then 200 px apart: twice the zoom.
    pointer('pointerdown', 1, 150, 300);
    pointer('pointerdown', 2, 250, 300);
    pointer('pointermove', 2, 350, 300);
    expect(screen.getByText('200%')).toBeInTheDocument();
    expect(image.style.transform).toContain('scale(2)');
    pointer('pointerup', 2, 350, 300);
    pointer('pointerup', 1, 150, 300);

    // One finger drags the zoomed photo.
    pointer('pointerdown', 3, 200, 300);
    pointer('pointermove', 3, 230, 310);
    expect(image.style.transform).toContain('scale(2)');
    pointer('pointerup', 3, 230, 310);

    // A double tap goes back to fit.
    pointer('pointerdown', 4, 200, 300);
    pointer('pointerup', 4, 200, 300);
    pointer('pointerdown', 4, 200, 300);
    pointer('pointerup', 4, 200, 300);
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)');
  });
});
