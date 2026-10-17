import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeOidc, fakeUser, jsonResponse, meFor, renderApp } from '../../test/helpers.js';
import { EXAM_ID, answerDetail, auditEntry } from '../../test/fixtures.js';
import { apiError, mockApi, type Route } from '../../test/mockApi.js';
import { validateOverride } from './AdminAnswerTools.js';

const ROUTE = `/manager/answer/${EXAM_ID}/s1%40college.edu/1?batch=A`;

function open(
  role: 'SUPER_ADMIN' | 'BATCH_MANAGER' | 'TEACHER',
  extra: Record<string, Route> = {},
) {
  const api = mockApi({
    'GET /me': meFor(role, { batchIds: ['A'] }),
    'GET /answers/:examId/:studentEmail/:q': answerDetail(),
    'GET /answers/:examId/:studentEmail/:q/audit': {
      examId: EXAM_ID,
      studentEmail: 's1@college.edu',
      questionNumber: 1,
      entries: [],
    },
    ...extra,
  });
  renderApp({
    oidc: new FakeOidc(fakeUser()),
    route: role === 'TEACHER' ? ROUTE.replace('/manager/', '/teacher/') : ROUTE,
  });
  return api;
}

const OVERRIDE_ROUTE = 'PUT /answers/:examId/:studentEmail/:q/override';
const dialog = () => screen.getByRole('dialog', { name: 'Override score' });

afterEach(() => vi.unstubAllGlobals());

describe('who sees the admin tools', () => {
  it.each(['BATCH_MANAGER', 'TEACHER'] as const)(
    'does not show them to a %s, and never asks for the audit history',
    async (role) => {
      const api = open(role);

      await screen.findByText(/marks$/);
      expect(screen.queryByRole('button', { name: 'Override score' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Audit history' })).not.toBeInTheDocument();
      expect(screen.queryByText('Admin tools')).not.toBeInTheDocument();
      expect(api.callsTo('GET /answers/:examId/:studentEmail/:q/audit')).toHaveLength(0);
      expect(api.callsTo(OVERRIDE_ROUTE)).toHaveLength(0);
    },
  );

  it('shows them to a super admin', async () => {
    open('SUPER_ADMIN');

    expect(await screen.findByRole('button', { name: 'Override score' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Audit history' })).toBeInTheDocument();
  });

  it('shows an existing override to everyone who looks at the answer', async () => {
    open('TEACHER', {
      'GET /answers/:examId/:studentEmail/:q': answerDetail({
        score: 9,
        override: {
          score: 9,
          reason: 'Rechecked by hand',
          by: 'admin@college.edu',
          at: '2026-10-26T09:00:00.000Z',
        },
      }),
    });

    expect(await screen.findByText(/Score adjusted by admin to 9/)).toBeInTheDocument();
    expect(screen.getByText(/Rechecked by hand/)).toBeInTheDocument();
  });
});

describe('validateOverride', () => {
  const base = { mode: 'set' as const, score: '8', reason: 'Checked', marks: 10 };

  it('gives the body for a good score and reason', () => {
    expect(validateOverride(base)).toEqual({ ok: true, body: { score: 8, reason: 'Checked' } });
    expect(validateOverride({ ...base, score: '0' })).toMatchObject({
      ok: true,
      body: { score: 0 },
    });
    expect(validateOverride({ ...base, score: '10' })).toMatchObject({
      ok: true,
      body: { score: 10 },
    });
    expect(validateOverride({ ...base, score: '7,5' })).toMatchObject({
      ok: true,
      body: { score: 7.5 },
    });
  });

  it.each(['10.5', '11', '-1', 'abc', ''])('rejects the score "%s"', (score) => {
    const result = validateOverride({ ...base, score });

    expect(result.ok).toBe(false);
  });

  it('says the range in the message', () => {
    expect(validateOverride({ ...base, score: '12' })).toEqual({
      ok: false,
      errors: { score: 'The score must be from 0 to 10, the marks for this question.' },
    });
  });

  it('always needs a reason, even to remove an override', () => {
    expect(validateOverride({ ...base, reason: '  ' })).toEqual({
      ok: false,
      errors: { reason: 'Write why the score is being changed.' },
    });
    expect(validateOverride({ ...base, mode: 'clear', reason: '' }).ok).toBe(false);
    expect(
      validateOverride({ ...base, mode: 'clear', score: 'x', reason: 'Back to normal' }),
    ).toEqual({
      ok: true,
      body: { score: null, reason: 'Back to normal' },
    });
  });
});

describe('the override dialog', () => {
  it('opens with the question’s marks and closes with Cancel or Escape', async () => {
    open('SUPER_ADMIN');

    await userEvent.click(await screen.findByRole('button', { name: 'Override score' }));
    expect(dialog()).toHaveTextContent('Question 1 is worth 10 marks');
    expect(screen.getByLabelText('New score (0 to 10)')).toHaveValue('7');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Override score' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks for a score from 0 to the marks and a reason, and sends nothing until both are right', async () => {
    const api = open('SUPER_ADMIN');
    await userEvent.click(await screen.findByRole('button', { name: 'Override score' }));

    await userEvent.clear(screen.getByLabelText(/New score/));
    await userEvent.type(screen.getByLabelText(/New score/), '11');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Save score' }));

    expect(
      await screen.findByText('The score must be from 0 to 10, the marks for this question.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Write why the score is being changed.')).toBeInTheDocument();
    expect(api.callsTo(OVERRIDE_ROUTE)).toHaveLength(0);
  });

  it('sets the score with the reason, then refreshes the answer and closes', async () => {
    let score = 7;
    const api = open('SUPER_ADMIN', {
      'GET /answers/:examId/:studentEmail/:q': () => answerDetail({ score }),
      [OVERRIDE_ROUTE]: () => {
        score = 8;
        return {
          examId: EXAM_ID,
          studentEmail: 's1@college.edu',
          questionNumber: 1,
          score: 8,
          override: {
            score: 8,
            reason: 'Rechecked',
            by: 'admin@college.edu',
            at: '2026-10-26T09:00:00.000Z',
          },
          totalScore: 20,
          maxScore: 30,
        };
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Override score' }));

    await userEvent.clear(screen.getByLabelText(/New score/));
    await userEvent.type(screen.getByLabelText(/New score/), '8');
    await userEvent.type(screen.getByLabelText('Reason'), 'Rechecked');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Save score' }));

    expect(await screen.findByText('The score is now 8 out of 10.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const [call] = api.callsTo(OVERRIDE_ROUTE);
    expect(call?.params).toEqual({ examId: EXAM_ID, studentEmail: 's1@college.edu', q: '1' });
    expect(call?.body).toEqual({ score: 8, reason: 'Rechecked' });
    expect(await screen.findByText('8 / 10 marks')).toBeInTheDocument();
  });

  it('removes an override with score null, still needing a reason', async () => {
    const api = open('SUPER_ADMIN', {
      'GET /answers/:examId/:studentEmail/:q': answerDetail({
        score: 9,
        override: {
          score: 9,
          reason: 'Old reason',
          by: 'admin@college.edu',
          at: '2026-10-26T09:00:00.000Z',
        },
      }),
      [OVERRIDE_ROUTE]: {
        examId: EXAM_ID,
        studentEmail: 's1@college.edu',
        questionNumber: 1,
        score: 7,
        override: null,
        totalScore: 18,
        maxScore: 30,
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Override score' }));
    expect(dialog()).toHaveTextContent('Current override: 9');

    await userEvent.click(
      screen.getByLabelText('Remove the override and use the calculated score'),
    );
    expect(screen.queryByLabelText(/New score/)).not.toBeInTheDocument();
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Remove override' }));
    expect(await screen.findByText('Write why the score is being changed.')).toBeInTheDocument();
    expect(api.callsTo(OVERRIDE_ROUTE)).toHaveLength(0);

    await userEvent.type(screen.getByLabelText('Reason'), 'Back to normal');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Remove override' }));

    expect(
      await screen.findByText('The override was removed. The score is 7 out of 10.'),
    ).toBeInTheDocument();
    expect(api.callsTo(OVERRIDE_ROUTE)[0]?.body).toEqual({ score: null, reason: 'Back to normal' });
  });

  it('cannot remove an override that does not exist', async () => {
    open('SUPER_ADMIN');

    await userEvent.click(await screen.findByRole('button', { name: 'Override score' }));

    expect(
      screen.getByLabelText('Remove the override and use the calculated score'),
    ).toBeDisabled();
  });

  it('shows the 409 clearly when the student is absent, and stays open', async () => {
    const api = open('SUPER_ADMIN', {
      [OVERRIDE_ROUTE]: apiError(409, 'CONFLICT', 'Student is marked absent; unmark absent first'),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Override score' }));

    await userEvent.type(screen.getByLabelText('Reason'), 'Recheck');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Save score' }));

    const alert = await within(dialog()).findByRole('alert');
    expect(alert).toHaveTextContent('Student is marked absent; unmark absent first');
    expect(alert).toHaveTextContent('Mark the student present on the Upload answers screen');
    expect(screen.getByRole('dialog', { name: 'Override score' })).toBeInTheDocument();
    expect(api.callsTo(OVERRIDE_ROUTE)).toHaveLength(1);
  });

  it('shows the API’s message for other refusals', async () => {
    open('SUPER_ADMIN', {
      [OVERRIDE_ROUTE]: apiError(
        422,
        'VALIDATION_FAILED',
        "The score cannot be more than the question's 10 marks",
      ),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Override score' }));
    await userEvent.type(screen.getByLabelText('Reason'), 'Recheck');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Save score' }));

    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('cannot be more than');
  });
});

describe('the audit history', () => {
  const AUDIT = 'GET /answers/:examId/:studentEmail/:q/audit';

  it('is not asked for until it is opened', async () => {
    const api = open('SUPER_ADMIN');
    await screen.findByRole('button', { name: 'Audit history' });

    expect(api.callsTo(AUDIT)).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Audit history' }));
    await screen.findByText('No changes have been made to this score.');
    expect(api.callsTo(AUDIT)).toHaveLength(1);
  });

  it('lists who changed the score, when, what they did, from what to what, and why, newest first', async () => {
    open('SUPER_ADMIN', {
      [AUDIT]: {
        examId: EXAM_ID,
        studentEmail: 's1@college.edu',
        questionNumber: 1,
        entries: [
          auditEntry({ timestamp: '2026-10-26T09:00:00.000Z' }),
          auditEntry({
            timestamp: '2026-10-28T09:00:00.000Z',
            actor: 'founder@gmail.com',
            action: 'CLEAR_OVERRIDE',
            before: { override: 9, displayedScore: 9 },
            after: { override: null, displayedScore: 7 },
            reason: 'Back to the calculated score',
          }),
          auditEntry({
            timestamp: '2026-10-27T09:00:00.000Z',
            before: { override: 9, displayedScore: 9 },
            after: { override: 6, displayedScore: 6 },
            reason: 'Second look',
          }),
        ],
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Audit history' }));

    const rows = within(await screen.findByRole('list', { name: 'Audit history' })).getAllByRole(
      'listitem',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Removed the override');
    expect(rows[0]).toHaveTextContent('Score 9 → 7');
    expect(rows[0]).toHaveTextContent('By founder@gmail.com');
    expect(rows[0]).toHaveTextContent('Reason: Back to the calculated score');
    expect(rows[1]).toHaveTextContent('Set an override');
    expect(rows[1]).toHaveTextContent('Score 9 → 6');
    expect(rows[1]).toHaveTextContent('Reason: Second look');
    expect(rows[2]).toHaveTextContent('Score 7 → 9');
    expect(rows[2]).toHaveTextContent('By admin@college.edu');
    expect(rows[2]).toHaveTextContent('Reason: Rechecked by hand');
    expect(rows[2]).toHaveTextContent(new Date('2026-10-26T09:00:00.000Z').toLocaleString());
  });

  it('can be hidden again', async () => {
    open('SUPER_ADMIN');
    const button = await screen.findByRole('button', { name: 'Audit history' });

    await userEvent.click(button);
    await screen.findByText('No changes have been made to this score.');
    await userEvent.click(button);

    expect(screen.queryByText('No changes have been made to this score.')).not.toBeInTheDocument();
  });

  it('says so when the history cannot be loaded', async () => {
    open('SUPER_ADMIN', {
      [AUDIT]: apiError(404, 'NOT_FOUND', 'No answer has been submitted for this question'),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Audit history' }));

    expect(await screen.findByText('Could not load the history')).toBeInTheDocument();
  });

  it('shows a score changed just now after an override is saved', async () => {
    let entries = [] as ReturnType<typeof auditEntry>[];
    open('SUPER_ADMIN', {
      [AUDIT]: () => ({
        examId: EXAM_ID,
        studentEmail: 's1@college.edu',
        questionNumber: 1,
        entries,
      }),
      [OVERRIDE_ROUTE]: () => {
        entries = [auditEntry()];
        return jsonResponse({
          examId: EXAM_ID,
          studentEmail: 's1@college.edu',
          questionNumber: 1,
          score: 9,
          override: {
            score: 9,
            reason: 'Rechecked by hand',
            by: 'admin@college.edu',
            at: '2026-10-26T09:00:00.000Z',
          },
          totalScore: 1,
          maxScore: 2,
        });
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Audit history' }));
    await screen.findByText('No changes have been made to this score.');

    await userEvent.click(screen.getByRole('button', { name: 'Override score' }));
    await userEvent.clear(screen.getByLabelText(/New score/));
    await userEvent.type(screen.getByLabelText(/New score/), '9');
    await userEvent.type(screen.getByLabelText('Reason'), 'Rechecked by hand');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Save score' }));

    await waitFor(() => expect(screen.getByText('Set an override')).toBeInTheDocument());
  });
});
