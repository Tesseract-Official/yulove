import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeOidc, fakeUser, meFor, renderApp } from '../../test/helpers.js';
import { EXAM_ID, answerDetail, appealSummary, examSummary } from '../../test/fixtures.js';
import { apiError, mockApi, type Route } from '../../test/mockApi.js';

// Same stand-ins as the upload tests: jsdom has no layout, so the cropper is replaced, and the
// canvas work is replaced with a fixed result.
vi.mock('react-easy-crop', () => {
  interface Props {
    rotation: number;
    aspect: number;
    onCropComplete: (percent: unknown, pixels: unknown) => void;
  }
  function FakeCropper({ rotation, aspect, onCropComplete }: Props) {
    useEffect(() => {
      onCropComplete({}, { x: 10, y: 20, width: 300, height: 400 });
    }, [rotation, aspect]); // eslint-disable-line react-hooks/exhaustive-deps
    return <div data-testid="easy-crop" />;
  }
  return { default: FakeCropper };
});
const compressed = new Blob([new Uint8Array(123_456)], { type: 'image/jpeg' });
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

const PRESIGNED = {
  url: 'https://bucket.s3.ap-south-1.amazonaws.com/',
  fields: { key: 'answers/exam-1/R1/q1.jpg', 'Content-Type': 'image/jpeg', Policy: 'p' },
  key: 'answers/exam-1/R1/q1.jpg',
  maxBytes: 5 * 1024 * 1024,
  expiresInSeconds: 600,
};

const OPEN = appealSummary();
const OTHERS = [
  appealSummary({
    appealId: 'ap2',
    studentEmail: 's2@college.edu',
    studentName: 'Ben Rai',
    rollNo: 'R2',
    questionNumber: 2,
    status: 'CLOSED',
    note: 'Fine as it was.',
    createdAt: '2026-10-27T10:00:00.000Z',
    message: 'Closed one',
  }),
  appealSummary({
    appealId: 'ap3',
    studentEmail: 's3@college.edu',
    studentName: 'Chitra Nair',
    rollNo: 'R3',
    questionNumber: 1,
    status: 'RERUN',
    createdAt: '2026-10-26T10:00:00.000Z',
    message: 'Graded again one',
  }),
  appealSummary({
    appealId: 'ap4',
    studentEmail: 's4@college.edu',
    studentName: 'Dev Shah',
    rollNo: 'R4',
    questionNumber: 3,
    createdAt: '2026-10-24T10:00:00.000Z',
    message: 'An older open one',
  }),
];

function open(
  role: 'BATCH_MANAGER' | 'TEACHER' | 'SUPER_ADMIN',
  route: string,
  extra: Record<string, Route> = {},
) {
  const api = mockApi({
    'GET /me': meFor(role, { batchIds: ['A'] }),
    'GET /batches': { batches: [{ batchId: 'A', name: 'Batch A' }] },
    'GET /exams': {
      exams: [
        examSummary({ status: 'PUBLISHED' }),
        examSummary({ examId: 'ready', title: 'Not published', status: 'READY' }),
      ],
    },
    'GET /appeals': { examId: EXAM_ID, appeals: [OTHERS[0]!, OTHERS[1]!, OPEN, OTHERS[2]!] },
    'GET /answers/:examId/:studentEmail/:q': answerDetail(),
    ...extra,
  });
  renderApp({ oidc: new FakeOidc(fakeUser()), route });
  return api;
}

const queue = () => `/teacher/appeals?batch=A&exam=${EXAM_ID}`;
const detail = (id = 'ap1') => `/teacher/appeals/${EXAM_ID}/${id}?batch=A`;

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('the appeal queue', () => {
  it('lists the appeals with every open one first, then the rest newest first', async () => {
    open('TEACHER', queue());

    const list = await screen.findByRole('list', { name: 'Appeals' });
    const names = within(list)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.row-title')?.textContent ?? '');
    expect(names).toHaveLength(4);
    expect(names[0]).toContain('Asha Rao'); // open, 25 Oct
    expect(names[1]).toContain('Dev Shah'); // open, 24 Oct
    expect(names[2]).toContain('Ben Rai'); // closed, 27 Oct
    expect(names[3]).toContain('Chitra Nair'); // graded again, 26 Oct
  });

  it('shows who appealed, the question, the start of the message, the status and the date', async () => {
    open('TEACHER', queue());

    const asha = (await screen.findByText(/R1 · Asha Rao · Question 1/)).closest(
      'li',
    ) as HTMLElement;
    expect(within(asha).getByText(/My loop is correct/)).toBeInTheDocument();
    expect(
      within(asha).getByRole('link', { name: /Open the appeal from Asha Rao on question 1/ }),
    ).toHaveAttribute('href', `/teacher/appeals/${EXAM_ID}/ap1?batch=A`);
    const ben = screen.getByText(/R2 · Ben Rai/).closest('li') as HTMLElement;
    expect(within(ben).getByText('Closed')).toBeInTheDocument();
    const chitra = screen.getByText(/R3 · Chitra Nair/).closest('li') as HTMLElement;
    expect(within(chitra).getByText('Graded again')).toBeInTheDocument();
  });

  it('counts the appeals by status', async () => {
    open('TEACHER', queue());

    expect(await screen.findByText('2 open appeals')).toBeInTheDocument();
    expect(screen.getByText(/1 graded again · 1 closed/)).toBeInTheDocument();
  });

  it.each([
    ['OPEN', ['Asha Rao', 'Dev Shah']],
    ['RERUN', ['Chitra Nair']],
    ['CLOSED', ['Ben Rai']],
  ] as const)('can show only the appeals that are %s', async (status, names) => {
    open('TEACHER', queue());
    await screen.findByRole('list', { name: 'Appeals' });

    await userEvent.selectOptions(screen.getByLabelText('Show'), status);

    const shown = within(screen.getByRole('list', { name: 'Appeals' }))
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.row-title')?.textContent ?? '');
    expect(shown).toHaveLength(names.length);
    names.forEach((name, i) => expect(shown[i]).toContain(name));
  });

  it('refreshes when asked', async () => {
    const api = open('TEACHER', queue());
    await screen.findByRole('list', { name: 'Appeals' });
    expect(api.callsTo('GET /appeals')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(api.callsTo('GET /appeals')).toHaveLength(2));
    expect(api.callsTo('GET /appeals')[0]?.query.get('examId')).toBe(EXAM_ID);
  });

  it('offers only published exams, and says when there are none', async () => {
    open('TEACHER', '/teacher/appeals');

    const select = await screen.findByLabelText('Exam');
    expect(within(select).queryByRole('option', { name: /Not published/ })).not.toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /Week 3 test/ })).toBeInTheDocument();
  });

  it('explains when nobody has appealed, and when a request fails', async () => {
    open('TEACHER', queue(), { 'GET /appeals': { examId: EXAM_ID, appeals: [] } });
    expect(
      await screen.findByText('Nobody has appealed anything in this exam.'),
    ).toBeInTheDocument();
  });

  it('shows the API’s refusal in plain words', async () => {
    open('TEACHER', queue(), {
      'GET /appeals': apiError(403, 'FORBIDDEN', 'You do not have access to this batch'),
    });

    expect(await screen.findByText('Could not load the appeals')).toBeInTheDocument();
    expect(screen.getByText(/You don't have access to this/)).toBeInTheDocument();
  });

  it('links into the teacher’s own section', async () => {
    open('TEACHER', queue());

    expect(
      await screen.findByRole('link', { name: /Open the appeal from Asha Rao on question 1/ }),
    ).toHaveAttribute('href', `/teacher/appeals/${EXAM_ID}/ap1?batch=A`);
  });
});

describe('an appeal', () => {
  it('shows what the student wrote, and the answer with the photo, transcription, fixes, language, complexity and verdicts', async () => {
    open('TEACHER', detail());

    expect(
      await screen.findByText(/My loop is correct, the reader misread the bound\./),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('img', { name: 'Answer photo for question 1' }),
    ).toBeInTheDocument();
    expect(screen.getByText('As written')).toBeInTheDocument();
    expect(screen.getByText('After fixing typing mistakes')).toBeInTheDocument();
    expect(screen.getByText('Added a colon after def f(n)')).toBeInTheDocument();
    expect(screen.getByText('Python')).toBeInTheDocument();
    expect(screen.getByText('O(n)')).toBeInTheDocument();
    const results = screen.getByRole('list', { name: 'Test results' });
    expect(within(results).getByText('Passed')).toBeInTheDocument();
    expect(within(results).getByText('Wrong answer')).toBeInTheDocument();
  });

  it('shows the raw and corrected code side by side', async () => {
    open('TEACHER', detail());

    const raw = (await screen.findByText('As written')).closest('.side-by-side');
    expect(raw).not.toBeNull();
    expect(raw).toContainElement(screen.getByText('After fixing typing mistakes'));
  });

  it('has a photo that can be zoomed and fitted back', async () => {
    open('TEACHER', detail());
    const photo = await screen.findByRole('img', { name: 'Answer photo for question 1' });
    expect(photo).toHaveStyle({ width: '100%' });
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
    expect(zoomOut).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(photo).toHaveStyle({ width: '150%' });
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(photo).toHaveStyle({ width: '200%' });
    expect(screen.getByText('200%')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(photo).toHaveStyle({ width: '150%' });
    await userEvent.click(screen.getByRole('button', { name: 'Fit to screen' }));
    expect(photo).toHaveStyle({ width: '100%' });
  });

  it('says when the appeal cannot be found', async () => {
    open('TEACHER', detail('nope'));

    expect(await screen.findByText('Appeal not found')).toBeInTheDocument();
  });

  it('goes back to the queue of the same exam', async () => {
    open('TEACHER', detail());

    expect(await screen.findByRole('link', { name: /Back to the appeals/ })).toHaveAttribute(
      'href',
      `/teacher/appeals?exam=${EXAM_ID}&batch=A`,
    );
  });

  it('shows the answer’s new status after a re-grade, when Refresh is pressed', async () => {
    let status: 'QUEUED' | 'GRADED' = 'QUEUED';
    const api = open('TEACHER', detail(), {
      'GET /answers/:examId/:studentEmail/:q': () => answerDetail({ status }),
    });
    expect(await screen.findByText('Waiting')).toBeInTheDocument();

    status = 'GRADED';
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('Graded')).toBeInTheDocument();
    expect(api.callsTo('GET /answers/:examId/:studentEmail/:q')).toHaveLength(2);
  });
});

describe('what a reviewer can do', () => {
  it('re-grades as is: PUT with RERUN, and no upload or submit', async () => {
    const api = open('TEACHER', detail(), {
      'PUT /appeals/:id': { appeal: { ...OPEN, status: 'RERUN' }, attempt: 2 },
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Re-grade as is' }));

    expect(await screen.findByText(/Sent for grading again\. Press Refresh/)).toBeInTheDocument();
    const [call] = api.callsTo('PUT /appeals/:id');
    expect(call?.params['id']).toBe('ap1');
    expect(call?.body).toEqual({ status: 'RERUN' });
    expect(api.callsTo('POST /answers/upload-url')).toHaveLength(0);
    expect(api.callsTo('POST /answers/submit')).toHaveLength(0);
    expect(api.s3Posts).toHaveLength(0);
  });

  it('can add a note when re-grading', async () => {
    const api = open('TEACHER', detail(), {
      'PUT /appeals/:id': { appeal: { ...OPEN, status: 'RERUN' }, attempt: 2 },
    });

    await userEvent.type(
      await screen.findByLabelText('Note for the student'),
      'Checking the bound.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Re-grade as is' }));

    await screen.findByText(/Sent for grading again/);
    expect(api.callsTo('PUT /appeals/:id')[0]?.body).toEqual({
      status: 'RERUN',
      note: 'Checking the bound.',
    });
  });

  it('closes only with a note', async () => {
    const api = open('TEACHER', detail(), {
      'PUT /appeals/:id': { appeal: { ...OPEN, status: 'CLOSED', note: 'Correct as graded.' } },
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Close with a note' }));
    expect(
      await screen.findByText('Write a note for the student before closing the appeal.'),
    ).toBeInTheDocument();
    expect(api.callsTo('PUT /appeals/:id')).toHaveLength(0);

    await userEvent.type(screen.getByLabelText('Note for the student'), 'Correct as graded.');
    await userEvent.click(screen.getByRole('button', { name: 'Close with a note' }));

    expect(await screen.findByText(/The appeal is closed/)).toBeInTheDocument();
    expect(api.callsTo('PUT /appeals/:id')[0]?.body).toEqual({
      status: 'CLOSED',
      note: 'Correct as graded.',
    });
  });

  it('uploads a better photo, then re-grades it: upload link, S3, then RERUN, and never submit', async () => {
    const api = open('SUPER_ADMIN', detail(), {
      'POST /answers/upload-url': PRESIGNED,
      'PUT /appeals/:id': { appeal: { ...OPEN, status: 'RERUN' }, attempt: 2 },
    });

    await userEvent.click(
      await screen.findByRole('button', { name: 'Upload a better photo and re-grade' }),
    );
    const camera = screen.getByLabelText('Take a photo');
    expect(camera).toHaveAttribute('capture', 'environment');
    await userEvent.upload(
      camera,
      new File([new Uint8Array(500_000)], 'new.jpg', { type: 'image/jpeg' }),
    );
    expect(await screen.findByTestId('easy-crop')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use this photo and grade again' }));

    expect(await screen.findByText(/Sent for grading again/)).toBeInTheDocument();
    expect(api.callsTo('POST /answers/upload-url')[0]?.body).toEqual({
      examId: EXAM_ID,
      studentEmail: 's1@college.edu',
      questionNumber: 1,
      contentType: 'image/jpeg',
    });
    const [post] = api.s3Posts;
    expect(post?.entries.map(([name]) => name)).toEqual([...Object.keys(PRESIGNED.fields), 'file']);
    expect((post?.entries.at(-1)?.[1] as File).size).toBe(compressed.size);
    expect(api.callsTo('PUT /appeals/:id')[0]?.body).toEqual({ status: 'RERUN' });
    expect(api.callsTo('POST /answers/submit')).toHaveLength(0);
    // In that order.
    const order = api.fetchMock.mock.calls.map(
      ([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`,
    );
    const at = (needle: string) => order.findIndex((entry) => entry.includes(needle));
    expect(at('/answers/upload-url')).toBeLessThan(at(PRESIGNED.url));
    expect(at(PRESIGNED.url)).toBeLessThan(at('PUT https://api.example.com/appeals/ap1'));
  });

  it('keeps the appeal open and says why when the upload fails', async () => {
    const api = open('SUPER_ADMIN', detail(), {
      'POST /answers/upload-url': apiError(
        409,
        'CONFLICT',
        's1@college.edu is marked absent for this exam',
      ),
    });

    await userEvent.click(
      await screen.findByRole('button', { name: 'Upload a better photo and re-grade' }),
    );
    await userEvent.upload(
      screen.getByLabelText('Choose a file'),
      new File(['x'], 'new.jpg', { type: 'image/jpeg' }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Use this photo and grade again' }),
    );

    expect(await screen.findByText(/is marked absent for this exam/)).toBeInTheDocument();
    expect(api.callsTo('PUT /appeals/:id')).toHaveLength(0);
  });

  it('shows the API’s message if the appeal was handled by someone else meanwhile', async () => {
    open('TEACHER', detail(), {
      'PUT /appeals/:id': apiError(409, 'CONFLICT', 'This appeal is already closed'),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Re-grade as is' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This appeal is already closed');
    expect(alert).toHaveTextContent('Press Refresh');
  });

  it('shows the outcome, and no actions, once an appeal is handled', async () => {
    open('TEACHER', detail('ap2'), {
      'GET /answers/:examId/:studentEmail/:q': answerDetail({
        studentEmail: 's2@college.edu',
        questionNumber: 2,
      }),
    });

    expect(await screen.findByText('Outcome')).toBeInTheDocument();
    expect(screen.getByText('Note: Fine as it was.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-grade as is' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close with a note' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upload a better photo/ })).not.toBeInTheDocument();
  });
});

describe('a teacher reviewing an appeal', () => {
  it('can re-grade and close, but is not offered a photo upload', async () => {
    const api = open('TEACHER', detail(), {
      'PUT /appeals/:id': { appeal: { ...OPEN, status: 'RERUN' }, attempt: 2 },
    });

    expect(await screen.findByRole('button', { name: 'Re-grade as is' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close with a note' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upload a better photo/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Take a photo')).not.toBeInTheDocument();
    expect(screen.getByText(/ask a batch manager to upload it/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Re-grade as is' }));
    await screen.findByText(/Sent for grading again/);
    expect(api.callsTo('PUT /appeals/:id')[0]?.body).toEqual({ status: 'RERUN' });
    expect(api.callsTo('POST /answers/upload-url')).toHaveLength(0);
  });

  it('goes back to the teacher’s own queue', async () => {
    open('TEACHER', detail());

    expect(await screen.findByRole('link', { name: /Back to the appeals/ })).toHaveAttribute(
      'href',
      `/teacher/appeals?exam=${EXAM_ID}&batch=A`,
    );
  });
});
