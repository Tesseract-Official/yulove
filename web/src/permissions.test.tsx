import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@yulove/shared';
import { FakeOidc, fakeUser, meFor, renderApp } from './test/helpers.js';
import { mockApi } from './test/mockApi.js';

const PAGES = {
  admin: ['/admin', '/admin/staff', '/admin/batches'],
  teacher: [
    '/teacher',
    '/teacher/questions',
    '/teacher/questions/new',
    '/teacher/questions/q1',
    '/teacher/questions/q1/tests',
    '/teacher/exams',
    '/teacher/exams/new',
    '/teacher/exams/exam-1',
    '/teacher/results',
    '/teacher/answer/exam-1/s1%40college.edu/1',
    '/teacher/appeals',
    '/teacher/appeals/exam-1/ap1',
  ],
  manager: [
    '/manager',
    '/manager/import',
    '/manager/students',
    '/manager/upload',
    '/manager/board',
    '/manager/answer/exam-1/s1%40college.edu/1',
    '/manager/appeals',
    '/manager/appeals/exam-1/ap1',
  ],
  student: ['/student', '/student/exams/exam-1'],
} as const;

function open(role: Role, route: string) {
  mockApi({
    'GET /me': meFor(role, { batchIds: ['A'] }),
    'GET /batches': { batches: [{ batchId: 'A', name: 'Batch A' }] },
    'GET /staff': { staff: [] },
    'GET /exams': { exams: [] },
    'GET /questions': { questions: [] },
    'GET /me/exams': { exams: [] },
    'GET /appeals': { examId: 'exam-1', appeals: [] },
  });
  renderApp({ oidc: new FakeOidc(fakeUser()), route });
}

const location = () => screen.getByTestId('location');

afterEach(() => vi.unstubAllGlobals());

describe('who can open the new screens', () => {
  it.each(
    PAGES.admin.flatMap((page) =>
      (['TEACHER', 'BATCH_MANAGER', 'STUDENT'] as const).map((role) => [role, page] as const),
    ),
  )('keeps a %s out of %s', async (role, page) => {
    open(role, page);

    const home = { TEACHER: '/teacher', BATCH_MANAGER: '/manager', STUDENT: '/student' }[role];
    await waitFor(() => expect(location()).toHaveTextContent(home));
    expect(
      screen.queryByRole('heading', { level: 1, name: /^Batches$|Teachers and batch managers/ }),
    ).not.toBeInTheDocument();
  });

  it.each(
    PAGES.manager.flatMap((page) =>
      (['TEACHER', 'STUDENT'] as const).map((role) => [role, page] as const),
    ),
  )('keeps a %s out of %s', async (role, page) => {
    open(role, page);

    const home = { TEACHER: '/teacher', STUDENT: '/student' }[role];
    await waitFor(() => expect(location()).toHaveTextContent(home));
  });

  it.each(PAGES.admin)('lets a super admin open %s', async (page) => {
    open('SUPER_ADMIN', page);

    await waitFor(() => expect(location()).toHaveTextContent(page));
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it.each(PAGES.manager)('lets a batch manager open %s', async (page) => {
    open('BATCH_MANAGER', page);

    await waitFor(() => expect(location()).toHaveTextContent(page.split('%')[0] ?? page));
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it.each(PAGES.manager)('lets a super admin open %s too', async (page) => {
    open('SUPER_ADMIN', page);

    await waitFor(() => expect(location()).toHaveTextContent(page.split('%')[0] ?? page));
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('keeps a signed-out visitor on the sign-in page', async () => {
    mockApi({});
    renderApp({ route: '/manager/upload' });

    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
  });
});

describe('who can open the teacher screens', () => {
  it.each(
    PAGES.teacher.flatMap((page) =>
      (['BATCH_MANAGER', 'STUDENT'] as const).map((role) => [role, page] as const),
    ),
  )('keeps a %s out of %s', async (role, page) => {
    open(role, page);

    const home = { BATCH_MANAGER: '/manager', STUDENT: '/student' }[role];
    await waitFor(() => expect(location()).toHaveTextContent(home));
  });

  it.each(PAGES.teacher)('lets a teacher open %s', async (page) => {
    open('TEACHER', page);

    await waitFor(() => expect(location()).toHaveTextContent(page.split('%')[0] ?? page));
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it.each(PAGES.teacher)('lets a super admin open %s too', async (page) => {
    open('SUPER_ADMIN', page);

    await waitFor(() => expect(location()).toHaveTextContent(page.split('%')[0] ?? page));
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('keeps a signed-out visitor on the sign-in page', async () => {
    mockApi({});
    renderApp({ route: '/teacher/exams' });

    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
  });
});

describe('who can open the student screens and the appeal queues', () => {
  it.each(
    PAGES.student.flatMap((page) =>
      (['TEACHER', 'BATCH_MANAGER'] as const).map((role) => [role, page] as const),
    ),
  )('keeps a %s out of %s', async (role, page) => {
    open(role, page);

    const home = { TEACHER: '/teacher', BATCH_MANAGER: '/manager' }[role];
    await waitFor(() => expect(location()).toHaveTextContent(home));
  });

  it.each(PAGES.student)('lets a student open %s', async (page) => {
    open('STUDENT', page);

    await waitFor(() => expect(location()).toHaveTextContent(page));
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it.each(PAGES.student)('lets a super admin open %s too', async (page) => {
    open('SUPER_ADMIN', page);

    await waitFor(() => expect(location()).toHaveTextContent(page));
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it.each(['/manager/appeals', '/teacher/appeals', '/admin', '/manager', '/teacher'])(
    'keeps a student out of %s',
    async (page) => {
      open('STUDENT', page);

      await waitFor(() => expect(location()).toHaveTextContent('/student'));
    },
  );
});
