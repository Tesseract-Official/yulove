import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardStudentRow, ExamBoardResponse } from '@yulove/shared';
import { FakeOidc, fakeUser, meFor, renderApp } from '../../test/helpers.js';
import {
  ASHA,
  BEN_ABSENT,
  CHITRA,
  EXAM_ID,
  boardOf,
  examSummary,
  student,
} from '../../test/fixtures.js';
import { apiError, mockApi } from '../../test/mockApi.js';

// jsdom has no layout, so the cropper cannot measure anything. This stand-in reports a fixed crop
// area (as the real one does once it has laid out the photo) and shows the turn it was given.
vi.mock('react-easy-crop', () => {
  interface Props {
    rotation: number;
    aspect: number;
    onCropComplete: (percent: unknown, pixels: unknown) => void;
  }
  function FakeCropper({ rotation, aspect, onCropComplete }: Props) {
    useEffect(() => {
      onCropComplete({}, { x: 10, y: 20, width: 300, height: 400 });
      // The real one reports again after every turn or change of frame, not on every render.
    }, [rotation, aspect]); // eslint-disable-line react-hooks/exhaustive-deps
    return <div data-testid="easy-crop" data-rotation={rotation} data-aspect={aspect} />;
  }
  return { default: FakeCropper };
});

const compressed = new Blob([new Uint8Array(654_321)], { type: 'image/jpeg' });
vi.mock('../../imaging/imaging.js', () => ({
  prepareImage: vi.fn(async () => ({
    blob: new Blob(['working copy']),
    width: 3200,
    height: 2400,
  })),
  cropAndCompress: vi.fn(async () => ({
    blob: compressed,
    width: 1500,
    height: 2000,
    quality: 0.85,
  })),
}));
const imaging = await import('../../imaging/imaging.js');

const PRESIGNED = {
  url: 'https://bucket.s3.ap-south-1.amazonaws.com/',
  fields: {
    key: 'answers/exam-1/R1/q1.jpg',
    'Content-Type': 'image/jpeg',
    Policy: 'p',
    'X-Amz-Signature': 's',
  },
  key: 'answers/exam-1/R1/q1.jpg',
  maxBytes: 5 * 1024 * 1024,
  expiresInSeconds: 600,
};

interface World {
  board: ExamBoardResponse;
}

/** A fake API with one batch and one READY exam; uploads and absent marks change the board. */
function setup(students: BoardStudentRow[], extra: Record<string, never> = {}, s3Status = 204) {
  const world: World = { board: boardOf(structuredClone(students)) };
  const api = mockApi(
    {
      'GET /me': meFor('BATCH_MANAGER', { batchIds: ['A'] }),
      'GET /batches': { batches: [{ batchId: 'A', name: 'Batch A' }] },
      'GET /exams': {
        exams: [
          examSummary(),
          examSummary({ examId: 'exam-0', title: 'Old draft', status: 'DRAFT' }),
        ],
      },
      'GET /exams/:id/answers': () => world.board,
      'POST /answers/upload-url': PRESIGNED,
      'POST /answers/submit': (call) => {
        const body = call.body as { studentEmail: string; questionNumber: number };
        const row = world.board.students.find((s) => s.email === body.studentEmail);
        const q = row?.questions.find((c) => c.number === body.questionNumber);
        if (q) q.status = 'QUEUED';
        return { ...body, examId: EXAM_ID, attempt: 1, status: 'QUEUED' };
      },
      'PUT /exams/:id/students/:email/absent': (call) => {
        const row = world.board.students.find((s) => s.email === call.params['email']);
        if (row) row.absent = (call.body as { absent: boolean }).absent;
        return {
          examId: EXAM_ID,
          studentEmail: call.params['email'],
          absent: row?.absent,
          totalScore: 0,
          maxScore: 20,
        };
      },
      ...extra,
    },
    { s3: () => new Response(null, { status: s3Status }) },
  );
  return { api, world };
}

const start = (route = '/manager/upload') => renderApp({ oidc: new FakeOidc(fakeUser()), route });

/** Choose the exam (the only batch is chosen for the manager). */
async function chooseExam() {
  await userEvent.selectOptions(await screen.findByLabelText('Exam'), EXAM_ID);
}

async function chooseStudent(name: string) {
  await userEvent.click(
    await screen.findByRole('button', { name: new RegExp(`Choose .*${name}`) }),
  );
}

const photo = () => new File([new Uint8Array(2_000_000)], 'page.jpg', { type: 'image/jpeg' });

/** Take a photo and send it for grading; resolves when the success message shows. */
async function sendPhoto(question: number) {
  await userEvent.upload(await screen.findByLabelText('Take a photo'), photo());
  await userEvent.click(
    await screen.findByRole('button', { name: /Send for grading|Replace and grade again/ }),
  );
  await screen.findByText(`Question ${question} was sent for grading.`);
}

beforeEach(() => {
  vi.mocked(imaging.cropAndCompress).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('uploading answer photos', () => {
  it('goes batch → exam → student → question → photo → crop → upload → submit', async () => {
    const { api } = setup([ASHA, BEN_ABSENT, CHITRA]);
    start();

    // Only the exams that can take answers are offered (the draft is not).
    const exam = await screen.findByLabelText('Exam');
    expect(within(exam).queryByText(/Old draft/)).not.toBeInTheDocument();
    await userEvent.selectOptions(exam, EXAM_ID);
    await chooseStudent('Asha Rao');

    // The phone camera is one control, picking a file the other.
    const camera = await screen.findByLabelText('Take a photo');
    expect(camera).toHaveAttribute('accept', 'image/*');
    expect(camera).toHaveAttribute('capture', 'environment');
    expect(screen.getByLabelText('Choose a file')).not.toHaveAttribute('capture');

    await userEvent.upload(camera, photo());
    expect(await screen.findByTestId('easy-crop')).toHaveAttribute('data-rotation', '0');
    await userEvent.click(screen.getByRole('button', { name: /Turn right/ }));
    await waitFor(() =>
      expect(screen.getByTestId('easy-crop')).toHaveAttribute('data-rotation', '90'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send for grading' }));
    await screen.findByText('Question 1 was sent for grading.');

    // The photo was cut and compressed using the turn and the area from the cropper...
    expect(imaging.cropAndCompress).toHaveBeenCalledWith(
      expect.objectContaining({ rotation: 90, area: { x: 10, y: 20, width: 300, height: 400 } }),
    );
    // ...asked for an upload link for this answer...
    const [link] = api.callsTo('POST /answers/upload-url');
    expect(link?.body).toEqual({
      examId: EXAM_ID,
      studentEmail: 's1@college.edu',
      questionNumber: 1,
      contentType: 'image/jpeg',
    });
    // ...and sent the compressed JPEG straight to S3: the link's fields first, the file last, and
    // no sign-in token.
    const [post] = api.s3Posts;
    expect(post?.url).toBe(PRESIGNED.url);
    expect(post?.entries.map(([name]) => name)).toEqual([...Object.keys(PRESIGNED.fields), 'file']);
    const file = post?.entries.at(-1)?.[1] as File;
    expect(file.type).toBe('image/jpeg');
    expect(file.size).toBe(compressed.size);
    expect(file.size).toBeLessThanOrEqual(PRESIGNED.maxBytes);
    expect(file.size).toBeLessThan(photo().size); // smaller than the camera photo
    expect(post?.headers['authorization']).toBeUndefined();
    // Order: link, then S3, then submit.
    const order = api.fetchMock.mock.calls.map(([url]) => String(url));
    expect(order.findIndex((u) => u.endsWith('/answers/upload-url'))).toBeLessThan(
      order.findIndex((u) => u === PRESIGNED.url),
    );
    expect(order.findIndex((u) => u === PRESIGNED.url)).toBeLessThan(
      order.findIndex((u) => u.endsWith('/answers/submit')),
    );
    expect(api.callsTo('POST /answers/submit')[0]?.body).toEqual({
      examId: EXAM_ID,
      studentEmail: 's1@college.edu',
      questionNumber: 1,
    });
  });

  it('moves straight to the next question, then offers the next student', async () => {
    setup([ASHA, BEN_ABSENT, CHITRA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    expect(await screen.findByRole('heading', { name: 'Question 1' })).toBeInTheDocument();
    await sendPhoto(1);
    expect(await screen.findByRole('heading', { name: 'Question 2' })).toBeInTheDocument();
    await sendPhoto(2);
    expect(await screen.findByRole('heading', { name: 'Question 3' })).toBeInTheDocument();
    await sendPhoto(3);

    expect(
      await screen.findByText(/All 3 questions for Asha Rao have been sent for grading/),
    ).toBeInTheDocument();
    // The absent student is skipped: the next one is Chitra.
    const next = screen.getByRole('button', { name: /Next student: R3 · Chitra Nair/ });
    await userEvent.click(next);

    expect(await screen.findByRole('heading', { name: /R3 · Chitra Nair/ })).toBeInTheDocument();
    // Chitra already has question 1, so it goes to question 2.
    expect(screen.getByRole('heading', { name: 'Question 2' })).toBeInTheDocument();
  });

  it('shows which questions already have a photo', async () => {
    setup([CHITRA]);
    start();
    await chooseExam();
    await chooseStudent('Chitra Nair');

    expect(await screen.findByRole('button', { name: 'Question 1: Graded' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Question 2: No photo yet' })).toBeInTheDocument();
    expect(screen.getByText('1 of 3 have a photo.')).toBeInTheDocument();
  });

  it('lets a photo be replaced, after a plain warning', async () => {
    const { api } = setup([CHITRA]);
    start();
    await chooseExam();
    await chooseStudent('Chitra Nair');

    await userEvent.click(await screen.findByRole('button', { name: 'Question 1: Graded' }));
    expect(screen.getByText(/already has a photo/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Take a photo')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Replace photo' }));
    expect(
      screen.getByText(/replaces the old one, and the answer is graded again/),
    ).toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText('Choose a file'), photo());
    await userEvent.click(await screen.findByRole('button', { name: 'Replace and grade again' }));

    await screen.findByText('Question 1 was sent for grading.');
    expect(api.callsTo('POST /answers/submit')[0]?.body).toMatchObject({ questionNumber: 1 });
  });

  it('keeps the photo and explains when S3 refuses it, so it can be tried again', async () => {
    const { api } = setup([ASHA], {}, 403);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    await userEvent.upload(await screen.findByLabelText('Take a photo'), photo());
    await userEvent.click(await screen.findByRole('button', { name: 'Send for grading' }));

    expect(await screen.findByText(/The upload link ran out/)).toBeInTheDocument();
    expect(api.callsTo('POST /answers/submit')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Send for grading' })).toBeEnabled();
  });

  it('keeps the place in the address, so a reload goes back to the same student', async () => {
    setup([ASHA, CHITRA]);
    start('/manager/upload?batch=A&exam=exam-1&student=s3%40college.edu');

    expect(await screen.findByRole('heading', { name: /R3 · Chitra Nair/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Exam')).not.toBeInTheDocument();
  });
});

describe('a student who is absent', () => {
  it('cannot be uploaded for: no photo controls, and no upload link is asked for', async () => {
    const { api } = setup([ASHA, BEN_ABSENT]);
    start();
    await chooseExam();
    await chooseStudent('Ben Rai');

    expect(
      await screen.findByText(/Ben Rai is marked absent, so photos cannot be uploaded/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Take a photo')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Choose a file')).not.toBeInTheDocument();
    expect(api.callsTo('POST /answers/upload-url')).toHaveLength(0);
  });

  it('can be marked present from there, which opens the upload', async () => {
    const { api } = setup([BEN_ABSENT]);
    start();
    await chooseExam();
    await chooseStudent('Ben Rai');

    await userEvent.click(await screen.findByRole('button', { name: 'Mark Ben Rai present' }));

    expect(await screen.findByLabelText('Take a photo')).toBeInTheDocument();
    expect(api.callsTo('PUT /exams/:id/students/:email/absent')[0]?.body).toEqual({
      absent: false,
    });
  });

  it('shows the API’s message when someone marked the student absent in the meantime', async () => {
    const { api } = setup([ASHA], {
      'POST /answers/upload-url': () =>
        apiError(409, 'CONFLICT', 's1@college.edu is marked absent for this exam'),
    } as never);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    await userEvent.upload(await screen.findByLabelText('Take a photo'), photo());
    await userEvent.click(await screen.findByRole('button', { name: 'Send for grading' }));

    expect(await screen.findByText(/is marked absent for this exam/)).toBeInTheDocument();
    expect(api.s3Posts).toHaveLength(0);
    expect(api.callsTo('POST /answers/submit')).toHaveLength(0);
  });
});

describe('the student picker', () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    student(`stu${i + 1}@college.edu`, `Student ${String(i + 1).padStart(2, '0')}`, `R${i + 100}`),
  );

  it('finds students by roll number, name or email', async () => {
    setup([ASHA, BEN_ABSENT, CHITRA]);
    start();
    await chooseExam();
    const search = await screen.findByLabelText(/Find a student/);

    await userEvent.type(search, 'r2');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Choose R2 · Ben Rai/ })).toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, 'chitra');
    expect(screen.getByRole('button', { name: /Choose R3 · Chitra Nair/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Asha/ })).not.toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, 's1@college');
    expect(screen.getByRole('button', { name: /Choose R1 · Asha Rao/ })).toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, 'zzz');
    expect(await screen.findByText('No student found')).toBeInTheDocument();
  });

  it('lists at most 20 at a time and says so', async () => {
    setup(many);
    start();
    await chooseExam();

    expect(
      await screen.findByText('Showing 20 of 25. Keep typing to narrow the list.'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Choose / })).toHaveLength(20);
  });

  it('shows who is absent and how many photos each student has', async () => {
    setup([ASHA, BEN_ABSENT, CHITRA]);
    start();
    await chooseExam();

    const ben = (await screen.findByRole('button', { name: /Choose R2/ })).closest(
      'li',
    ) as HTMLElement;
    expect(within(ben).getByText('Absent')).toBeInTheDocument();
    const chitra = screen.getByRole('button', { name: /Choose R3/ }).closest('li') as HTMLElement;
    expect(within(chitra).getByText('1 of 3 uploaded')).toBeInTheDocument();
  });

  it('marks a student absent only after asking, and present at once', async () => {
    const { api } = setup([ASHA]);
    start();
    await chooseExam();

    await userEvent.click(await screen.findByRole('button', { name: 'Mark Asha Rao absent' }));
    expect(screen.getByText(/Their marks will be 0 for this exam/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.callsTo('PUT /exams/:id/students/:email/absent')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Mark Asha Rao absent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, mark absent' }));
    expect(await screen.findByText('Absent')).toBeInTheDocument();
    expect(api.callsTo('PUT /exams/:id/students/:email/absent')[0]?.body).toEqual({ absent: true });
    expect(api.callsTo('PUT /exams/:id/students/:email/absent')[0]?.params['email']).toBe(
      's1@college.edu',
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Mark Asha Rao present' }));
    await waitFor(() => expect(screen.queryByText('Absent')).not.toBeInTheDocument());
    expect(api.callsTo('PUT /exams/:id/students/:email/absent')[1]?.body).toEqual({
      absent: false,
    });
  });

  it('explains when an exam has no students yet', async () => {
    setup([]);
    start();
    await chooseExam();

    expect(await screen.findByText('No students in this exam yet')).toBeInTheDocument();
  });
});

describe('choosing the exam', () => {
  it('says what to do when no exam can take answers yet', async () => {
    const { api } = setup([ASHA], {
      'GET /exams': { exams: [examSummary({ status: 'DRAFT' })] },
    } as never);
    start();

    expect(await screen.findByText('No exams to choose from')).toBeInTheDocument();
    expect(screen.getByText(/Ask the teacher to finish the exam/)).toBeInTheDocument();
    expect(api.callsTo('GET /exams/:id/answers')).toHaveLength(0);
  });

  it('lets a batch manager with several batches choose one', async () => {
    setup([ASHA], {
      'GET /batches': {
        batches: [
          { batchId: 'A', name: 'Batch A' },
          { batchId: 'B', name: 'Batch B' },
        ],
      },
    } as never);
    start();

    expect(screen.queryByLabelText('Exam')).not.toBeInTheDocument();
    await userEvent.selectOptions(await screen.findByLabelText('Batch'), 'A');
    expect(await screen.findByLabelText('Exam')).toBeInTheDocument();
  });
});
