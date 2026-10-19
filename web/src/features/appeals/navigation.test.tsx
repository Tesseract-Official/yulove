import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@yulove/shared';
import { FakeOidc, fakeUser, meFor, renderApp } from '../../test/helpers.js';
import { EXAM_ID, answerDetail, appealSummary, examSummary } from '../../test/fixtures.js';
import { mockApi } from '../../test/mockApi.js';

function open(role: Role, route: string, exams = [examSummary({ status: 'PUBLISHED' })]) {
  const api = mockApi({
    'GET /me': meFor(role, { batchIds: ['A'] }),
    'GET /batches': { batches: [{ batchId: 'A', name: 'Batch A' }] },
    'GET /exams': { exams },
    'GET /appeals': { examId: EXAM_ID, appeals: [appealSummary()] },
    'GET /answers/:examId/:studentEmail/:q': answerDetail(),
  });
  renderApp({ oidc: new FakeOidc(fakeUser()), route });
  return api;
}

const location = () => screen.getByTestId('location');

afterEach(() => vi.unstubAllGlobals());

describe('where Appeals is on the menus', () => {
  it('is on the teacher’s menu', async () => {
    open('TEACHER', '/teacher');

    expect(await screen.findByRole('link', { name: /Appeals/ })).toHaveAttribute(
      'href',
      '/teacher/appeals',
    );
  });

  it.each(['BATCH_MANAGER', 'SUPER_ADMIN'] as const)(
    'is not on the batch manager’s menu (seen as a %s)',
    async (role) => {
      open(role, '/manager');

      await screen.findByRole('heading', { name: 'Batch manager' });
      expect(screen.queryByRole('link', { name: /Appeals/ })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Check grading and publish/ })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Upload answers/ })).toBeInTheDocument();
    },
  );
});

describe('the old appeals addresses in the manager section', () => {
  it.each(['/manager/appeals', `/manager/appeals/${EXAM_ID}/ap1`])(
    'show "Not allowed" to a batch manager at %s, and load no appeals',
    async (route) => {
      const api = open('BATCH_MANAGER', route);

      expect(await screen.findByRole('heading', { name: 'Not allowed' })).toBeInTheDocument();
      expect(screen.getByText(/Appeals are handled by teachers now/)).toBeInTheDocument();
      expect(
        within(screen.getByRole('main')).getByRole('link', { name: 'Check grading and publish' }),
      ).toHaveAttribute('href', '/manager/board');
      expect(location()).toHaveTextContent(route);
      expect(api.callsTo('GET /appeals')).toHaveLength(0);
    },
  );

  it('send a super admin on to the teacher page, keeping the exam and batch', async () => {
    open('SUPER_ADMIN', `/manager/appeals?batch=A&exam=${EXAM_ID}`);

    await waitFor(() => expect(location()).toHaveTextContent('/teacher/appeals'));
    expect(await screen.findByRole('heading', { name: 'Appeals' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Exam')).toHaveValue(EXAM_ID);
  });

  it('send a super admin from one appeal to the same appeal under Teacher', async () => {
    open('SUPER_ADMIN', `/manager/appeals/${EXAM_ID}/ap1?batch=A`);

    await waitFor(() => expect(location()).toHaveTextContent(`/teacher/appeals/${EXAM_ID}/ap1`));
    expect(await screen.findByText(/The student wrote/)).toBeInTheDocument();
  });

  it('keep a teacher and a student out of the manager section, as before', async () => {
    open('TEACHER', '/manager/appeals');
    await waitFor(() => expect(location()).toHaveTextContent('/teacher'));
    expect(location()).not.toHaveTextContent('/manager');
  });

  it('keep a student out too', async () => {
    open('STUDENT', '/manager/appeals');
    await waitFor(() => expect(location()).toHaveTextContent('/student'));
  });
});

describe('the teacher’s appeal queue', () => {
  const MINE = examSummary({ status: 'PUBLISHED', examId: 'mine', title: 'My test' });
  const OTHERS = examSummary({
    status: 'PUBLISHED',
    examId: 'theirs',
    title: 'Another teacher’s test',
    createdBy: 'tara@college.edu',
  });

  it('offers a teacher every published exam of their batch, not only the ones they made', async () => {
    open('TEACHER', '/teacher/appeals?batch=A', [MINE, OTHERS]);

    const select = await screen.findByLabelText('Exam');
    expect(within(select).getByRole('option', { name: /My test/ })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /Another teacher/ })).toBeInTheDocument();
  });

  it('offers a super admin every exam', async () => {
    open('SUPER_ADMIN', '/teacher/appeals?batch=A', [MINE, OTHERS]);

    const select = await screen.findByLabelText('Exam');
    expect(within(select).getByRole('option', { name: /My test/ })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /Another teacher/ })).toBeInTheDocument();
  });

  it('sends the chosen exam to the appeals route', async () => {
    const api = open('TEACHER', '/teacher/appeals?batch=A', [MINE]);

    await userEvent.selectOptions(await screen.findByLabelText('Exam'), 'mine');

    await waitFor(() => expect(api.callsTo('GET /appeals')).toHaveLength(1));
    expect(api.callsTo('GET /appeals')[0]?.query.get('examId')).toBe('mine');
  });
});
