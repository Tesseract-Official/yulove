import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudentSummary } from '@yulove/shared';
import { FakeOidc, fakeUser, meFor, renderApp } from '../../test/helpers.js';
import { apiError, mockApi, type Route } from '../../test/mockApi.js';

const STUDENTS: StudentSummary[] = [
  { email: 'asha@college.edu', name: 'Asha Rao', rollNo: 'R1', batchId: 'A', active: true },
  { email: 'ben@college.edu', name: 'Ben Khan', rollNo: 'R2', batchId: 'A', active: false },
  { email: 'chitra@college.edu', name: 'Chitra Das', rollNo: 'R10', batchId: 'A', active: true },
];

function setup(extra: Record<string, Route> = {}, students = STUDENTS) {
  const state = { students: structuredClone(students) };
  const api = mockApi({
    'GET /me': meFor('BATCH_MANAGER', { batchIds: ['A'] }),
    'GET /batches': { batches: [{ batchId: 'A', name: 'Batch A' }] },
    'GET /batches/:batchId/students': () => ({ students: state.students }),
    'PUT /users/:email/active': (call) => {
      const body = call.body as { active: boolean };
      const person = state.students.find((s) => s.email === call.params['email']);
      if (person) person.active = body.active;
      return { user: { email: call.params['email'], ...body }, changed: true };
    },
    ...extra,
  });
  renderApp({ oidc: new FakeOidc(fakeUser()), route: '/manager/students' });
  return api;
}

const row = (name: string) =>
  screen.getByText(new RegExp(name), { selector: '.row-title' }).closest('li') as HTMLElement;

afterEach(() => vi.unstubAllGlobals());

describe('the batch manager’s student list', () => {
  it('is on the menu', async () => {
    mockApi({
      'GET /me': meFor('BATCH_MANAGER', { batchIds: ['A'] }),
      'GET /batches': { batches: [{ batchId: 'A', name: 'Batch A' }] },
    });
    renderApp({ oidc: new FakeOidc(fakeUser()), route: '/manager' });

    expect(await screen.findByRole('link', { name: /Students/ })).toHaveAttribute(
      'href',
      '/manager/students',
    );
  });

  it('lists the batch’s students with a switch each, greying out and labelling the inactive ones', async () => {
    const api = setup();

    await screen.findByText(/Asha Rao/, { selector: '.row-title' });
    expect(api.callsTo('GET /batches/:batchId/students')[0]?.path).toBe('/batches/A/students');
    expect(within(row('Asha Rao')).getByRole('switch', { name: 'Active: Asha Rao' })).toBeChecked();
    const ben = row('Ben Khan');
    expect(within(ben).getByRole('switch', { name: 'Inactive: Ben Khan' })).not.toBeChecked();
    expect(within(ben).getByText('Inactive', { selector: '.chip' })).toBeInTheDocument();
    expect(ben).toHaveClass('is-inactive');
    expect(row('Asha Rao')).not.toHaveClass('is-inactive');
  });

  it('finds students by roll number, name or email', async () => {
    setup();
    await screen.findByText(/Asha Rao/, { selector: '.row-title' });

    await userEvent.type(screen.getByLabelText('Find a student'), 'r10');
    expect(row('Chitra Das')).toBeInTheDocument();
    expect(screen.queryByText(/Asha Rao/, { selector: '.row-title' })).not.toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Find a student'));
    await userEvent.type(screen.getByLabelText('Find a student'), 'ben@');
    expect(row('Ben Khan')).toBeInTheDocument();
    expect(screen.queryByText(/Chitra Das/, { selector: '.row-title' })).not.toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Find a student'));
    await userEvent.type(screen.getByLabelText('Find a student'), 'zzz');
    expect(screen.getByText('No student found')).toBeInTheDocument();
  });

  it('switches a student off with a reason, then shows them as inactive', async () => {
    const api = setup();
    await screen.findByText(/Asha Rao/, { selector: '.row-title' });

    await userEvent.click(screen.getByRole('switch', { name: 'Active: Asha Rao' }));
    const dialog = await screen.findByRole('dialog', { name: 'Make Asha Rao inactive' });
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Withdrew from the course');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make inactive' }));

    await waitFor(() => expect(row('Asha Rao')).toHaveClass('is-inactive'));
    const [call] = api.callsTo('PUT /users/:email/active');
    expect(call?.path).toBe('/users/asha%40college.edu/active');
    expect(call?.body).toEqual({ active: false, reason: 'Withdrew from the course' });
    expect(api.callsTo('GET /batches/:batchId/students').length).toBeGreaterThanOrEqual(2);
  });

  it('switches a student back on', async () => {
    const api = setup();
    await screen.findByText(/Ben Khan/, { selector: '.row-title' });

    await userEvent.click(screen.getByRole('switch', { name: 'Inactive: Ben Khan' }));
    await userEvent.type(await screen.findByLabelText('Reason'), 'Rejoined');
    await userEvent.click(screen.getByRole('button', { name: 'Make active' }));

    await waitFor(() => expect(row('Ben Khan')).not.toHaveClass('is-inactive'));
    expect(api.callsTo('PUT /users/:email/active')[0]?.body).toEqual({
      active: true,
      reason: 'Rejoined',
    });
  });

  it('asks for a reason: nothing is sent without one', async () => {
    const api = setup();
    await screen.findByText(/Asha Rao/, { selector: '.row-title' });

    await userEvent.click(screen.getByRole('switch', { name: 'Active: Asha Rao' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Make inactive' }));

    expect(await screen.findByText(/Write why/)).toBeInTheDocument();
    expect(api.callsTo('PUT /users/:email/active')).toHaveLength(0);
  });

  it('says so when the server refuses (a student of another batch)', async () => {
    setup({
      'PUT /users/:email/active': apiError(
        403,
        'FORBIDDEN',
        'You do not have access to this batch',
      ),
    });
    await screen.findByText(/Asha Rao/, { selector: '.row-title' });

    await userEvent.click(screen.getByRole('switch', { name: 'Active: Asha Rao' }));
    await userEvent.type(await screen.findByLabelText('Reason'), 'because');
    await userEvent.click(screen.getByRole('button', { name: 'Make inactive' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(row('Asha Rao')).not.toHaveClass('is-inactive');
  });

  it('shows an empty batch and a load error plainly', async () => {
    setup({ 'GET /batches/:batchId/students': { students: [] } });
    expect(await screen.findByText('No students in this batch yet')).toBeInTheDocument();
  });

  it('offers a retry when the list cannot be loaded', async () => {
    setup({ 'GET /batches/:batchId/students': apiError(400, 'BAD', 'Nope') });
    expect(await screen.findByText('Could not load the students')).toBeInTheDocument();
  });
});
