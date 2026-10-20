import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

// jsdom has no canvas, so the photo work is replaced with fixed results. The crop screen's own
// maths is tested in imaging/cropMath.test.ts, and the screen itself in photoAdjuster.test.tsx.
vi.mock('../../imaging/imaging.js', () => ({
  prepareImage: vi.fn(async () => ({
    blob: new Blob(['working copy']),
    width: 3200,
    height: 2400,
  })),
  suggestCrop: vi.fn(async () => null),
  cropAndCompress: vi.fn(async () => ({
    // A new file every time, so a test can tell whether a retry sends the very same one.
    blob: new Blob([new Uint8Array(654_321)], { type: 'image/jpeg' }),
    width: 1500,
    height: 2000,
    quality: 0.85,
  })),
}));
// The upload goes through XMLHttpRequest, which jsdom would send for real. Everything else in the
// module stays real.
vi.mock('../../imaging/upload.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../imaging/upload.js')>();
  return { ...actual, uploadPhoto: vi.fn() };
});
const imaging = await import('../../imaging/imaging.js');
const uploads = await import('../../imaging/upload.js');

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
function setup(students: BoardStudentRow[], extra: Record<string, never> = {}) {
  const world: World = { board: boardOf(structuredClone(students)) };
  const api = mockApi({
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
  });
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

/** Take a photo, accept the crop and press Send. Does not wait for the upload. */
async function takeAndSend() {
  await userEvent.upload(await screen.findByLabelText('Take a photo'), photo());
  await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
  await userEvent.click(await screen.findByRole('button', { name: /^Send/ }));
}

const header = () => document.querySelector('.flow-head') as HTMLElement;
const questionLabel = () => within(header()).getByText(/^Q\d+ of \d+$/).textContent;

/** The camera input that was opened by a click, newest last. */
const cameraClicks = (clicks: { mock: { contexts: unknown[] } }) =>
  clicks.mock.contexts.filter(
    (el) => el instanceof HTMLInputElement && el.getAttribute('capture') === 'environment',
  );

let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(imaging.cropAndCompress).mockClear();
  vi.mocked(uploads.uploadPhoto)
    .mockReset()
    .mockImplementation(async (_presigned, _photo, options) => {
      options?.onProgress?.(0.5);
      options?.onProgress?.(1);
    });
  window.localStorage.clear();
  // jsdom has no layout: the crop screen needs a size to place the photo and the crop box in.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 400,
    bottom: 600,
    width: 400,
    height: 600,
    toJSON: () => ({}),
  });
  clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('one flow from camera to send', () => {
  it('goes exam → student → camera → adjust → preview → send, with the upload kept as it was', async () => {
    const { api } = setup([ASHA, BEN_ABSENT, CHITRA]);
    start();

    // Only the exams that can take answers are offered (the draft is not).
    const exam = await screen.findByLabelText('Exam');
    expect(within(exam).queryByText(/Old draft/)).not.toBeInTheDocument();
    await userEvent.selectOptions(exam, EXAM_ID);
    await chooseStudent('Asha Rao');

    // Everything is on this one screen: who and which question, the camera, and the gallery.
    expect(within(header()).getByText(/R1 · Asha Rao/)).toBeInTheDocument();
    expect(questionLabel()).toBe('Q1 of 3');
    const camera = await screen.findByLabelText('Take a photo');
    expect(camera).toHaveAttribute('accept', 'image/*');
    expect(camera).toHaveAttribute('capture', 'environment');
    expect(screen.getByLabelText('Choose from gallery')).not.toHaveAttribute('capture');

    await userEvent.upload(camera, photo());

    // Adjust: the photo and a crop box that starts as the whole photo, no fixed shape.
    const box = await screen.findByTestId('crop-box');
    expect(box).toHaveAttribute('data-width', '3200');
    expect(box).toHaveAttribute('data-height', '2400');
    await userEvent.click(screen.getByRole('button', { name: 'Rotate right' }));
    expect(screen.getByTestId('crop-box')).toHaveAttribute('data-width', '2400');
    expect(screen.getByTestId('crop-box')).toHaveAttribute('data-height', '3200');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    // Preview: the finished photo, and Send.
    expect(imaging.cropAndCompress).toHaveBeenCalledWith(
      expect.objectContaining({
        rotation: 90,
        area: { x: 0, y: 0, width: 2400, height: 3200 },
      }),
    );
    expect(await screen.findByText(/1500 × 2000 px · 639 KB/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(api.callsTo('POST /answers/submit')).toHaveLength(1));
    // Same calls as before: an upload link for this answer, the file to S3, then submit.
    expect(api.callsTo('POST /answers/upload-url')[0]?.body).toEqual({
      examId: EXAM_ID,
      studentEmail: 's1@college.edu',
      questionNumber: 1,
      contentType: 'image/jpeg',
    });
    expect(uploads.uploadPhoto).toHaveBeenCalledTimes(1);
    const [presigned, sent] = vi.mocked(uploads.uploadPhoto).mock.calls[0]!;
    expect(presigned).toEqual(PRESIGNED);
    expect(sent.type).toBe('image/jpeg');
    expect(sent.size).toBe(654_321);
    expect(api.callsTo('POST /answers/submit')[0]?.body).toEqual({
      examId: EXAM_ID,
      studentEmail: 's1@college.edu',
      questionNumber: 1,
    });
  });

  it('offers the gallery as well, and a retake from the adjust screen', async () => {
    setup([ASHA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    await userEvent.upload(await screen.findByLabelText('Choose from gallery'), photo());
    await screen.findByTestId('crop-box');
    clickSpy.mockClear();

    await userEvent.click(screen.getByRole('button', { name: 'Retake' }));

    // Back to the start for this question, and the camera is opened again.
    expect(await screen.findByRole('button', { name: 'Take a photo' })).toBeInTheDocument();
    expect(screen.queryByTestId('crop-box')).not.toBeInTheDocument();
    expect(cameraClicks(clickSpy)).toHaveLength(1);
  });

  it('can go back from the preview to adjust without losing the crop', async () => {
    setup([ASHA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    await userEvent.upload(await screen.findByLabelText('Take a photo'), photo());
    await userEvent.click(await screen.findByRole('button', { name: 'Rotate left' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Back to adjust' }));

    const box = await screen.findByTestId('crop-box');
    expect(box).toHaveAttribute('data-width', '2400');
    expect(box).toHaveAttribute('data-height', '3200');
  });

  it('shows what is wrong, and stays on the screen, when the photo cannot be prepared', async () => {
    setup([ASHA]);
    vi.mocked(imaging.cropAndCompress).mockRejectedValueOnce(
      new Error('The photo is too large to send. Move closer to the page and retake it.'),
    );
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    await userEvent.upload(await screen.findByLabelText('Take a photo'), photo());
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));

    expect(await screen.findByText(/too large to send/)).toBeInTheDocument();
    expect(screen.getByTestId('crop-box')).toBeInTheDocument();
  });
});

describe('after Send', () => {
  it('points the camera at the next question straight away, before the upload is finished', async () => {
    const release = { go: () => {} };
    vi.mocked(uploads.uploadPhoto).mockImplementationOnce(
      () => new Promise<void>((resolve) => (release.go = resolve)),
    );
    const { api } = setup([ASHA, BEN_ABSENT, CHITRA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    await userEvent.upload(await screen.findByLabelText('Take a photo'), photo());
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    clickSpy.mockClear();
    await userEvent.click(await screen.findByRole('button', { name: 'Send' }));

    // Already on question 2, with the camera opened, while question 1 is still going up.
    expect(questionLabel()).toBe('Q2 of 3');
    expect(cameraClicks(clickSpy)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeInTheDocument();
    expect(screen.getByText('Q1 for R1 · Asha Rao is on its way.')).toBeInTheDocument();
    const sending = await screen.findByRole('progressbar', {
      name: /Sending Q1 for R1 · Asha Rao/,
    });
    expect(sending).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Question 1 is being sent' })).toBeInTheDocument();
    expect(api.callsTo('POST /answers/submit')).toHaveLength(0);

    release.go();
    expect(
      await screen.findByRole('button', { name: 'Question 1 has a photo' }),
    ).toBeInTheDocument();
    expect(api.callsTo('POST /answers/submit')).toHaveLength(1);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('goes through the questions, then to the next student who is not absent', async () => {
    const { api } = setup([ASHA, BEN_ABSENT, CHITRA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    await takeAndSend();
    expect(questionLabel()).toBe('Q2 of 3');
    await takeAndSend();
    expect(questionLabel()).toBe('Q3 of 3');
    clickSpy.mockClear();
    await takeAndSend();

    // After Asha's last question: Chitra (Ben is absent), and her first open question is Q2.
    await waitFor(() => expect(within(header()).getByText(/R3 · Chitra Nair/)).toBeInTheDocument());
    expect(questionLabel()).toBe('Q2 of 3');
    expect(cameraClicks(clickSpy)).toHaveLength(1);
    // The address follows, so a reload comes back to Chitra.
    await waitFor(() => expect(api.callsTo('POST /answers/submit')).toHaveLength(3));
    expect(
      api
        .callsTo('POST /answers/submit')
        .map((c) => (c.body as { questionNumber: number }).questionNumber),
    ).toEqual([1, 2, 3]);
  });

  it('shows a row of marks for the student: sent, being sent, and still to do', async () => {
    const release = { go: () => {} };
    vi.mocked(uploads.uploadPhoto)
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(() => new Promise<void>((resolve) => (release.go = resolve)));
    setup([ASHA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    const row = () => screen.getByRole('list', { name: 'Photos for R1 · Asha Rao' });
    expect(
      within(row())
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Q1 •', 'Q2 •', 'Q3 •']);

    await takeAndSend();
    await takeAndSend();

    await waitFor(() =>
      expect(
        within(row())
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Q1 ✓', expect.stringMatching(/^Q2 … \d+%$/), 'Q3 •']),
    );
    release.go();
    await waitFor(() =>
      expect(
        within(row())
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Q1 ✓', 'Q2 ✓', 'Q3 •']),
    );
  });

  it('says when every student has every photo', async () => {
    setup([ASHA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    await takeAndSend();
    await takeAndSend();
    await takeAndSend();

    expect(
      await screen.findByText(/Every student has a photo for every question/),
    ).toBeInTheDocument();
  });

  it('moves between questions and students with the buttons, skipping students who are absent', async () => {
    setup([ASHA, BEN_ABSENT, CHITRA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    expect(screen.getByRole('button', { name: 'Previous question' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous student' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next question' }));
    expect(questionLabel()).toBe('Q2 of 3');
    await userEvent.click(screen.getByRole('button', { name: 'Previous question' }));
    expect(questionLabel()).toBe('Q1 of 3');

    await userEvent.click(screen.getByRole('button', { name: 'Next student' }));
    expect(within(header()).getByText(/R3 · Chitra Nair/)).toBeInTheDocument();
    expect(questionLabel()).toBe('Q2 of 3'); // Q1 already has a photo
    expect(screen.getByRole('button', { name: 'Next student' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Previous student' }));
    expect(within(header()).getByText(/R1 · Asha Rao/)).toBeInTheDocument();
  });

  it('warns that a question already has a photo, and replaces it when sent', async () => {
    const { api } = setup([CHITRA]);
    start();
    await chooseExam();
    await chooseStudent('Chitra Nair');
    expect(questionLabel()).toBe('Q2 of 3');

    await userEvent.click(screen.getByRole('button', { name: 'Question 1 has a photo' }));
    expect(screen.getByText(/already has a photo/)).toBeInTheDocument();
    await userEvent.upload(await screen.findByLabelText('Take a photo'), photo());
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Send and replace' }));

    await waitFor(() =>
      expect(api.callsTo('POST /answers/submit')[0]?.body).toMatchObject({ questionNumber: 1 }),
    );
  });
});

describe('a photo that fails to send', () => {
  it('is kept with the reason and a Retry chip, then sent again with the same file', async () => {
    vi.mocked(uploads.uploadPhoto).mockRejectedValueOnce(
      new uploads.PhotoUploadError(
        'The upload link ran out. Press the button again to send the photo.',
      ),
    );
    const { api } = setup([ASHA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    await takeAndSend();

    expect(await screen.findByText(/1 photo has not been sent/)).toBeInTheDocument();
    expect(screen.getByText(/The upload link ran out/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Question 1 could not be sent' }),
    ).toBeInTheDocument();
    expect(api.callsTo('POST /answers/submit')).toHaveLength(0);

    await userEvent.click(
      screen.getByRole('button', { name: /Retry sending Q1 for R1 · Asha Rao/ }),
    );

    await waitFor(() => expect(api.callsTo('POST /answers/submit')).toHaveLength(1));
    // A fresh upload link for the second try, and the very same photo.
    expect(api.callsTo('POST /answers/upload-url')).toHaveLength(2);
    const [first, second] = vi.mocked(uploads.uploadPhoto).mock.calls;
    expect(second?.[1]).toBe(first?.[1]);
    await waitFor(() => expect(screen.queryByText(/has not been sent/)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Question 1 has a photo' })).toBeInTheDocument();
  });

  it('shows the API’s message when the student was marked absent meanwhile, and sends nothing to S3', async () => {
    const { api } = setup([ASHA], {
      'POST /answers/upload-url': () =>
        apiError(409, 'CONFLICT', 's1@college.edu is marked absent for this exam'),
    } as never);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    await takeAndSend();

    expect(await screen.findByText(/is marked absent for this exam/)).toBeInTheDocument();
    expect(uploads.uploadPhoto).not.toHaveBeenCalled();
    expect(api.callsTo('POST /answers/submit')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Retry sending Q1/ })).toBeInTheDocument();
  });

  it('is never dropped on its own: only Discard removes it, and Retry all sends every failed one', async () => {
    vi.mocked(uploads.uploadPhoto)
      .mockRejectedValueOnce(
        new uploads.PhotoUploadError(
          'The photo could not be sent. Check your connection and try again.',
        ),
      )
      .mockRejectedValueOnce(
        new uploads.PhotoUploadError(
          'The photo could not be sent. Check your connection and try again.',
        ),
      )
      .mockRejectedValueOnce(
        new uploads.PhotoUploadError(
          'The photo could not be sent. Check your connection and try again.',
        ),
      );
    const { api } = setup([ASHA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    await takeAndSend();
    await takeAndSend();
    await takeAndSend();
    await screen.findByText(/3 photos have not been sent/);

    await userEvent.click(screen.getByRole('button', { name: /Discard Q3/ }));
    expect(screen.getByText(/2 photos have not been sent/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry all' }));
    await waitFor(() => expect(api.callsTo('POST /answers/submit')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText(/not been sent/)).not.toBeInTheDocument());
  });
});

describe('photos that are not sent yet', () => {
  const unload = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event;
  };

  it('make closing or reloading the page ask first, until everything is sent', async () => {
    const release = { go: () => {} };
    vi.mocked(uploads.uploadPhoto).mockImplementationOnce(
      () => new Promise<void>((resolve) => (release.go = resolve)),
    );
    setup([ASHA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');
    expect(unload().defaultPrevented).toBe(false); // nothing to lose yet

    await takeAndSend();
    await screen.findByRole('progressbar');
    expect(unload().defaultPrevented).toBe(true);

    release.go();
    await screen.findByRole('button', { name: 'Question 1 has a photo' });
    expect(unload().defaultPrevented).toBe(false);
  });

  it('also make leaving ask first while a photo has failed', async () => {
    vi.mocked(uploads.uploadPhoto).mockRejectedValueOnce(new Error('offline'));
    setup([ASHA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');

    await takeAndSend();
    await screen.findByText(/1 photo has not been sent/);

    expect(unload().defaultPrevented).toBe(true);
  });

  it('keep going up while the manager moves to another page, and are announced there', async () => {
    const release = { go: () => {} };
    vi.mocked(uploads.uploadPhoto).mockImplementationOnce(
      () => new Promise<void>((resolve) => (release.go = resolve)),
    );
    const { api } = setup([ASHA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');
    await takeAndSend();
    await screen.findByRole('progressbar');

    // Leave: the student list, then the manager's home page.
    await userEvent.click(screen.getByRole('button', { name: 'Choose another student' }));
    expect(await screen.findByLabelText(/Find a student/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: /Back/ }));

    const banner = await screen.findByText(/Sending 1 photo… Keep this page open/);
    expect(banner).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Upload answers' })).toHaveAttribute(
      'href',
      '/manager/upload',
    );

    release.go();
    await waitFor(() => expect(api.callsTo('POST /answers/submit')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/Keep this page open/)).not.toBeInTheDocument());
  });

  it('are flagged on every page when one has failed', async () => {
    vi.mocked(uploads.uploadPhoto).mockRejectedValueOnce(new Error('offline'));
    setup([ASHA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');
    await takeAndSend();
    await screen.findByText(/1 photo has not been sent/);

    await userEvent.click(screen.getByRole('button', { name: 'Choose another student' }));
    await userEvent.click(await screen.findByRole('link', { name: /Back/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('1 photo has not been sent.');
  });
});

describe('where the manager left off', () => {
  it('keeps the place in the address, so a reload goes back to the same student', async () => {
    setup([ASHA, CHITRA]);
    start('/manager/upload?batch=A&exam=exam-1&student=s3%40college.edu');

    expect(await screen.findByText(/R3 · Chitra Nair/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Exam')).not.toBeInTheDocument();
  });

  it('remembers the last exam and student for the next visit', async () => {
    setup([ASHA, CHITRA]);
    start();
    await chooseExam();
    await chooseStudent('Chitra Nair');
    expect(await screen.findByText(/R3 · Chitra Nair/)).toBeInTheDocument();
    cleanup();

    // A new visit with nothing in the address goes straight back to Chitra.
    start();
    expect(await screen.findByText(/R3 · Chitra Nair/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Exam')).not.toBeInTheDocument();
  });

  it('follows the student through the exam, so the next visit starts where the last ended', async () => {
    setup([ASHA, CHITRA]);
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');
    await userEvent.click(await screen.findByRole('button', { name: 'Next student' }));
    cleanup();

    start();
    expect(await screen.findByText(/R3 · Chitra Nair/)).toBeInTheDocument();
  });

  it('starts empty when nothing is remembered, and copes with storage that refuses', async () => {
    setup([ASHA]);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    start();
    await chooseExam();
    await chooseStudent('Asha Rao');
    expect(await screen.findByText(/R1 · Asha Rao/)).toBeInTheDocument();
  });
});

describe('a student who is absent', () => {
  it('cannot be uploaded for: no way to take a photo, and no upload link is asked for', async () => {
    const { api } = setup([ASHA, BEN_ABSENT]);
    start();
    await chooseExam();
    await chooseStudent('Ben Rai');

    expect(
      await screen.findByText(/Ben Rai is marked absent, so photos cannot be uploaded/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take a photo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose from gallery' })).not.toBeInTheDocument();
    expect(api.callsTo('POST /answers/upload-url')).toHaveLength(0);
  });

  it('can be marked present from there, which opens the upload', async () => {
    const { api } = setup([BEN_ABSENT]);
    start();
    await chooseExam();
    await chooseStudent('Ben Rai');

    await userEvent.click(await screen.findByRole('button', { name: 'Mark Ben Rai present' }));

    expect(await screen.findByRole('button', { name: 'Take a photo' })).toBeInTheDocument();
    expect(api.callsTo('PUT /exams/:id/students/:email/absent')[0]?.body).toEqual({
      absent: false,
    });
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

describe('students who have been switched off', () => {
  it('are greyed out and labelled in the picker, and cannot be chosen', async () => {
    setup([ASHA, student('dan@college.edu', 'Dan Gone', 'R9', undefined, { active: false })]);
    start();
    await chooseExam();

    const dan = (await screen.findByText(/R9 · Dan Gone/)).closest('li') as HTMLElement;
    expect(dan).toHaveClass('is-inactive');
    expect(within(dan).getByText('Inactive')).toBeInTheDocument();
    expect(within(dan).getByRole('button', { name: /Choose R9 · Dan Gone/ })).toBeDisabled();
    // Everyone else is unchanged.
    expect(screen.getByRole('button', { name: /Choose .*Asha/ })).toBeEnabled();
  });
});
