import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StaffMember } from '@yulove/shared';
import { FakeOidc, fakeUser, jsonResponse, meFor, renderApp } from '../../test/helpers.js';
import { apiError, mockApi, type Route } from '../../test/mockApi.js';

const BATCHES = [
  { batchId: 'A', name: 'Batch A' },
  { batchId: 'B', name: 'Batch B' },
  { batchId: 'C', name: 'Batch C' },
];

const STAFF: StaffMember[] = [
  {
    email: 'tina@college.edu',
    name: 'Tina Teacher',
    role: 'TEACHER',
    batchIds: ['A'],
    active: true,
  },
  {
    email: 'mo@college.edu',
    name: 'Mo Manager',
    role: 'BATCH_MANAGER',
    batchIds: ['A', 'B'],
    active: true,
  },
  { email: 'gone@college.edu', name: 'Gus Gone', role: 'TEACHER', batchIds: [], active: false },
];

function setup(route: string, extra: Record<string, Route> = {}) {
  const state = { batches: [...BATCHES], staff: structuredClone(STAFF) };
  const api = mockApi({
    'GET /me': meFor('SUPER_ADMIN'),
    'GET /batches': () => ({ batches: state.batches }),
    'GET /staff': () => ({ staff: state.staff }),
    ...extra,
  });
  renderApp({ oidc: new FakeOidc(fakeUser()), route });
  return { api, state };
}

afterEach(() => vi.unstubAllGlobals());

describe('the admin menu', () => {
  it('links to the staff and batches screens', async () => {
    setup('/admin');

    expect(
      await screen.findByRole('link', { name: /Teachers and batch managers/ }),
    ).toHaveAttribute('href', '/admin/staff');
    expect(screen.getByRole('link', { name: /^Batches/ })).toHaveAttribute(
      'href',
      '/admin/batches',
    );
  });
});

describe('batches', () => {
  it('lists the batches by name with their IDs', async () => {
    setup('/admin/batches');

    const list = (await screen.findByText('Batch A')).closest('ul') as HTMLElement;
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('ID: B')).toBeInTheDocument();
  });

  it('creates a batch and shows it in the list', async () => {
    const { api, state } = setup('/admin/batches', {
      'POST /batches': (call) => {
        const body = call.body as { batchId: string; name: string };
        state.batches.push(body);
        return jsonResponse({ batch: body }, 201);
      },
    });

    await userEvent.type(await screen.findByLabelText('Batch ID'), '2026-D');
    await userEvent.type(screen.getByLabelText('Batch name'), 'Batch D');
    await userEvent.click(screen.getByRole('button', { name: 'Add batch' }));

    expect(await screen.findByText('Added Batch D (ID 2026-D).')).toBeInTheDocument();
    expect(await screen.findByText('ID: 2026-D')).toBeInTheDocument();
    expect(api.callsTo('POST /batches')[0]?.body).toEqual({ batchId: '2026-D', name: 'Batch D' });
    expect(screen.getByLabelText('Batch ID')).toHaveValue('');
  });

  it('explains a batch ID that is not allowed, without asking the API', async () => {
    const { api } = setup('/admin/batches');

    await userEvent.type(await screen.findByLabelText('Batch ID'), 'bad id!');
    await userEvent.type(screen.getByLabelText('Batch name'), 'Whatever');
    await userEvent.click(screen.getByRole('button', { name: 'Add batch' }));

    expect(await screen.findByText(/can only use letters, numbers, - and _/)).toBeInTheDocument();
    expect(api.callsTo('POST /batches')).toHaveLength(0);
  });

  it('asks for a name', async () => {
    setup('/admin/batches');
    await userEvent.type(await screen.findByLabelText('Batch ID'), 'ok-1');
    await userEvent.click(screen.getByRole('button', { name: 'Add batch' }));

    expect(await screen.findByText('Type a name for the batch.')).toBeInTheDocument();
  });

  it('says plainly when the ID is already used', async () => {
    setup('/admin/batches', { 'POST /batches': apiError(409, 'CONFLICT', 'Batch A exists') });

    await userEvent.type(await screen.findByLabelText('Batch ID'), 'A');
    await userEvent.type(screen.getByLabelText('Batch name'), 'Again');
    await userEvent.click(screen.getByRole('button', { name: 'Add batch' }));

    expect(
      await screen.findByText('A batch with this ID already exists. Choose a different ID.'),
    ).toBeInTheDocument();
  });
});

describe('teachers and batch managers', () => {
  it('lists teachers and batch managers separately, with their batches', async () => {
    setup('/admin/staff');

    const tina = (await screen.findByText('Tina Teacher')).closest('li') as HTMLElement;
    expect(within(tina).getByText('Batch A')).toBeInTheDocument();
    const mo = screen.getByText('Mo Manager').closest('li') as HTMLElement;
    expect(within(mo).getByText('Batch A')).toBeInTheDocument();
    expect(within(mo).getByText('Batch B')).toBeInTheDocument();
    const gus = screen.getByText('Gus Gone').closest('li') as HTMLElement;
    expect(within(gus).getByText('Inactive', { selector: '.chip' })).toBeInTheDocument();
    expect(within(gus).getByText('No batches yet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Teachers' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Batch managers' })).toBeInTheDocument();
  });

  it('adds a teacher with batches', async () => {
    const { api } = setup('/admin/staff', {
      'POST /staff': (call) => {
        const body = call.body as { name: string; email: string };
        return jsonResponse({ user: { ...body, role: 'TEACHER' } }, 201);
      },
    });

    await userEvent.type(await screen.findByLabelText('Name'), 'New Person');
    await userEvent.type(screen.getByLabelText('College email'), 'new@college.edu');
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'TEACHER');
    const form = screen.getByLabelText('Name').closest('form') as HTMLElement;
    await userEvent.click(within(form).getByLabelText('Batch B'));
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));

    expect(
      await screen.findByText(/Added New Person\. They can now sign in with new@college\.edu/),
    ).toBeInTheDocument();
    expect(api.callsTo('POST /staff')[0]?.body).toEqual({
      name: 'New Person',
      email: 'new@college.edu',
      role: 'TEACHER',
      batchIds: ['B'],
    });
    expect(screen.getByLabelText('Name')).toHaveValue('');
  });

  it('adds a batch manager', async () => {
    const { api } = setup('/admin/staff', {
      'POST /staff': () =>
        jsonResponse({ user: { name: 'M', email: 'm@college.edu', role: 'BATCH_MANAGER' } }, 201),
    });

    await userEvent.type(await screen.findByLabelText('Name'), 'M');
    await userEvent.type(screen.getByLabelText('College email'), 'm@college.edu');
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'BATCH_MANAGER');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));

    await screen.findByText(/Added M\./);
    expect(api.callsTo('POST /staff')[0]?.body).toMatchObject({
      role: 'BATCH_MANAGER',
      batchIds: [],
    });
  });

  it('checks the name and email before sending anything', async () => {
    const { api } = setup('/admin/staff');

    await userEvent.click(await screen.findByRole('button', { name: 'Add person' }));
    expect(await screen.findByText('Type the person’s name.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Name'), 'Someone');
    await userEvent.type(screen.getByLabelText('College email'), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText(/Type a valid college email address/)).toBeInTheDocument();
    expect(api.callsTo('POST /staff')).toHaveLength(0);
  });

  it('shows the API’s message for an email that is not allowed or already used', async () => {
    setup('/admin/staff', {
      'POST /staff': apiError(422, 'VALIDATION_FAILED', 'Email: must end in @college.edu'),
    });

    await userEvent.type(await screen.findByLabelText('Name'), 'Someone');
    await userEvent.type(screen.getByLabelText('College email'), 'someone@gmail.com');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email: must end in @college.edu');
  });

  it('changes a person’s batches with a list of checkboxes and saves them', async () => {
    const { api, state } = setup('/admin/staff', {
      'PUT /staff/:email/batches': (call) => {
        const batchIds = (call.body as { batchIds: string[] }).batchIds;
        const person = state.staff.find((s) => s.email === call.params['email']);
        if (person) person.batchIds = batchIds;
        return { user: { ...person } };
      },
    });

    await userEvent.click(
      await screen.findByRole('button', { name: 'Change batches for Tina Teacher' }),
    );
    const group = screen.getByRole('group', { name: 'Batches for Tina Teacher' });
    expect(within(group).getByLabelText('Batch A')).toBeChecked();
    expect(within(group).getByLabelText('Batch B')).not.toBeChecked();

    await userEvent.click(within(group).getByLabelText('Batch A')); // off
    await userEvent.click(within(group).getByLabelText('Batch B'));
    await userEvent.click(within(group).getByLabelText('Batch C'));
    await userEvent.click(screen.getByRole('button', { name: 'Save batches' }));

    const [call] = api.callsTo('PUT /staff/:email/batches');
    expect(call?.params['email']).toBe('tina@college.edu');
    expect(call?.body).toEqual({ batchIds: ['B', 'C'] });
    // The card is back to showing the chips, now with the new batches.
    const tina = (await screen.findByText('Tina Teacher')).closest('li') as HTMLElement;
    expect(await within(tina).findByText('Batch C')).toBeInTheDocument();
    expect(within(tina).queryByText('Batch A')).not.toBeInTheDocument();
  });

  it('can leave without saving', async () => {
    const { api } = setup('/admin/staff');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Change batches for Mo Manager' }),
    );
    const group = screen.getByRole('group', { name: 'Batches for Mo Manager' });
    await userEvent.click(within(group).getByLabelText('Batch C'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(api.callsTo('PUT /staff/:email/batches')).toHaveLength(0);
    expect(screen.queryByRole('group', { name: /Batches for Mo/ })).not.toBeInTheDocument();
  });

  it('shows the API’s message when saving the batches fails', async () => {
    setup('/admin/staff', {
      'PUT /staff/:email/batches': apiError(422, 'VALIDATION_FAILED', 'Unknown batches: Z'),
    });

    await userEvent.click(
      await screen.findByRole('button', { name: 'Change batches for Tina Teacher' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save batches' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown batches: Z');
  });

  it('explains when nobody has been added yet', async () => {
    const { state } = setup('/admin/staff');
    state.staff = [];
    // (the page loads after the state is emptied)
    expect(await screen.findByText('No teachers yet')).toBeInTheDocument();
    expect(screen.getByText('No batch managers yet')).toBeInTheDocument();
  });
});

describe('switching teachers and batch managers on and off', () => {
  /** A fake API where the switch changes the list, like the real one. */
  function withSwitch() {
    return setup('/admin/staff', {
      'PUT /users/:email/active': (call) => {
        const body = call.body as { active: boolean };
        const person = state.staff.find((m) => m.email === call.params['email']);
        if (person) person.active = body.active;
        return {
          user: { email: call.params['email'], name: person?.name, role: person?.role, ...body },
          changed: true,
        };
      },
    });
  }
  let state: { batches: typeof BATCHES; staff: StaffMember[] };
  const card = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

  function open() {
    const made = withSwitch();
    state = made.state;
    return made;
  }

  it('shows an Active or Inactive switch on every person, and greys out the inactive ones', async () => {
    open();

    await screen.findByText('Tina Teacher');
    const tina = card('Tina Teacher');
    const gus = card('Gus Gone');
    expect(within(tina).getByRole('switch', { name: 'Active: Tina Teacher' })).toBeChecked();
    expect(within(gus).getByRole('switch', { name: 'Inactive: Gus Gone' })).not.toBeChecked();
    expect(within(gus).getByText('Inactive', { selector: '.chip' })).toBeInTheDocument();
    expect(gus).toHaveClass('is-inactive');
    expect(tina).not.toHaveClass('is-inactive');
    expect(within(tina).queryByText('Inactive', { selector: '.chip' })).not.toBeInTheDocument();
  });

  it('asks for a reason first, sends nothing without one, and then switches the person off', async () => {
    const { api } = open();
    await screen.findByText('Tina Teacher');

    await userEvent.click(screen.getByRole('switch', { name: 'Active: Tina Teacher' }));
    const dialog = await screen.findByRole('dialog', { name: 'Make Tina Teacher inactive' });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Make inactive' }));
    expect(await within(dialog).findByText(/Write why/)).toBeInTheDocument();
    expect(api.callsTo('PUT /users/:email/active')).toHaveLength(0);

    await userEvent.type(within(dialog).getByLabelText('Reason'), '  Left the college  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make inactive' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const [call] = api.callsTo('PUT /users/:email/active');
    expect(call?.path).toBe('/users/tina%40college.edu/active');
    expect(call?.body).toEqual({ active: false, reason: 'Left the college' });

    // The list is loaded again, so she now shows as inactive.
    const tina = card('Tina Teacher');
    await waitFor(() => expect(tina).toHaveClass('is-inactive'));
    expect(
      within(card('Tina Teacher')).getByRole('switch', { name: 'Inactive: Tina Teacher' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Tina Teacher is now inactive/)).toBeInTheDocument();
  });

  it('switches an inactive person back on with a reason', async () => {
    const { api } = open();
    await screen.findByText('Gus Gone');

    await userEvent.click(screen.getByRole('switch', { name: 'Inactive: Gus Gone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Make Gus Gone active again' });
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Came back');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make active' }));

    await waitFor(() => expect(api.callsTo('PUT /users/:email/active')).toHaveLength(1));
    expect(api.callsTo('PUT /users/:email/active')[0]?.body).toEqual({
      active: true,
      reason: 'Came back',
    });
    await waitFor(() => expect(card('Gus Gone')).not.toHaveClass('is-inactive'));
  });

  it('sends nothing when the dialog is cancelled or closed with Escape', async () => {
    const { api } = open();
    await screen.findByText('Tina Teacher');

    await userEvent.click(screen.getByRole('switch', { name: 'Active: Tina Teacher' }));
    await userEvent.type(await screen.findByLabelText('Reason'), 'not sure');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('switch', { name: 'Active: Tina Teacher' }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    expect(api.callsTo('PUT /users/:email/active')).toHaveLength(0);
    expect(card('Tina Teacher')).not.toHaveClass('is-inactive');
  });

  it('refuses a reason that is too long without asking the server', async () => {
    const { api } = open();
    await screen.findByText('Tina Teacher');

    await userEvent.click(screen.getByRole('switch', { name: 'Active: Tina Teacher' }));
    const reason = await screen.findByLabelText('Reason');
    await userEvent.click(reason);
    await userEvent.paste('x'.repeat(1001));
    await userEvent.click(screen.getByRole('button', { name: 'Make inactive' }));

    expect(await screen.findByText(/too long/)).toBeInTheDocument();
    expect(api.callsTo('PUT /users/:email/active')).toHaveLength(0);
  });

  it('shows what the server said when it refuses, and keeps the dialog open', async () => {
    const { api } = setup('/admin/staff', {
      'PUT /users/:email/active': apiError(
        409,
        'CONFLICT',
        'This is the last active super admin, so it cannot be deactivated',
      ),
    });
    await screen.findByText('Tina Teacher');

    await userEvent.click(screen.getByRole('switch', { name: 'Active: Tina Teacher' }));
    await userEvent.type(await screen.findByLabelText('Reason'), 'because');
    await userEvent.click(screen.getByRole('button', { name: 'Make inactive' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/last active super admin/);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(api.callsTo('PUT /users/:email/active')).toHaveLength(1);
  });
});
