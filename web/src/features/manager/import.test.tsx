import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportStudentsResponse } from '@yulove/shared';
import { FakeOidc, fakeUser, meFor, renderApp } from '../../test/helpers.js';
import { apiError, mockApi } from '../../test/mockApi.js';

const CSV =
  'name,college email,roll number,batch\nAsha Rao,asha@college.edu,R1,A\nBen,ben@college.edu,R2,A\n';

const RESULT: ImportStudentsResponse = {
  created: [{ line: 2, email: 'asha@college.edu', name: 'Asha Rao', rollNo: 'R1', batchId: 'A' }],
  updated: [{ line: 3, email: 'ben@college.edu', name: 'Ben Rai', rollNo: 'R2', batchId: 'A' }],
  rejected: [
    { line: 4, email: 'cat@gmail.com', rollNo: 'R3', reason: 'email must end in @college.edu' },
    { line: 5, rollNo: 'R4', reason: 'missing college email' },
  ],
  counts: { rows: 4, created: 1, updated: 1, rejected: 2 },
};

function setup(reply: unknown = RESULT) {
  const api = mockApi({
    'GET /me': meFor('BATCH_MANAGER', { batchIds: ['A'] }),
    'GET /batches': { batches: [{ batchId: 'A', name: 'Batch A' }] },
    'POST /batches/:batchId/students/import': reply as never,
  });
  renderApp({ oidc: new FakeOidc(fakeUser()), route: '/manager/import' });
  return api;
}

const csvFile = (name = 'students.csv', content = CSV) =>
  new File([content], name, { type: 'text/csv' });

afterEach(() => vi.unstubAllGlobals());

describe('importing students from a CSV', () => {
  it('sends the file’s text for the chosen batch and shows what happened', async () => {
    const api = setup();
    await userEvent.upload(await screen.findByLabelText('CSV file'), csvFile());
    await userEvent.click(screen.getByRole('button', { name: 'Upload students' }));

    expect(await screen.findByText(/1 student added/)).toBeInTheDocument();
    expect(screen.getByText(/1 student updated/)).toBeInTheDocument();
    expect(screen.getByText(/2 rows skipped/)).toBeInTheDocument();

    const [call] = api.callsTo('POST /batches/:batchId/students/import');
    expect(call?.params['batchId']).toBe('A');
    expect(call?.body).toEqual({ csv: CSV });
  });

  it('lists every skipped row with its line and the reason', async () => {
    setup();
    await userEvent.upload(await screen.findByLabelText('CSV file'), csvFile());
    await userEvent.click(screen.getByRole('button', { name: 'Upload students' }));

    const skipped = await screen.findByRole('list', { name: 'Skipped rows' });
    const rows = within(skipped).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Line 4 · R3 · cat@gmail.com');
    expect(rows[0]).toHaveTextContent('Email must end in @college.edu');
    expect(rows[1]).toHaveTextContent('Line 5 · R4');
    expect(rows[1]).toHaveTextContent('Missing college email');
  });

  it('lists the students added and updated', async () => {
    setup();
    await userEvent.upload(await screen.findByLabelText('CSV file'), csvFile());
    await userEvent.click(screen.getByRole('button', { name: 'Upload students' }));

    await userEvent.click(await screen.findByText('Students added (1)'));
    expect(screen.getByText('R1 · Asha Rao')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Students updated (1)'));
    expect(screen.getByText('R2 · Ben Rai')).toBeInTheDocument();
  });

  it('says so when every row was imported', async () => {
    setup({ ...RESULT, rejected: [], counts: { rows: 2, created: 1, updated: 1, rejected: 0 } });
    await userEvent.upload(await screen.findByLabelText('CSV file'), csvFile());
    await userEvent.click(screen.getByRole('button', { name: 'Upload students' }));

    expect(await screen.findByText('Every row was imported.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Skipped rows' })).not.toBeInTheDocument();
  });

  it('shows the API’s message when the whole file is refused', async () => {
    setup(apiError(422, 'VALIDATION_FAILED', 'The CSV is missing these columns: roll number'));
    await userEvent.upload(await screen.findByLabelText('CSV file'), csvFile());
    await userEvent.click(screen.getByRole('button', { name: 'Upload students' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The CSV is missing these columns: roll number',
    );
    expect(screen.queryByText('Result')).not.toBeInTheDocument();
  });

  it('does not send a file that is not a CSV, is empty, or is over 1 MB', async () => {
    const api = setup();
    const input = await screen.findByLabelText('CSV file');

    await userEvent.upload(input, new File(['x'], 'students.xlsx'), { applyAccept: false });
    expect(await screen.findByText(/choose a CSV file/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload students' })).toBeDisabled();

    await userEvent.upload(input, csvFile('empty.csv', ''));
    expect(await screen.findByText('That file is empty.')).toBeInTheDocument();

    await userEvent.upload(input, csvFile('big.csv', 'x'.repeat(1_000_001)));
    expect(await screen.findByText(/too big \(over 1 MB\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload students' })).toBeDisabled();
    expect(api.callsTo('POST /batches/:batchId/students/import')).toHaveLength(0);
  });

  it('shows the columns the file needs, in plain words', async () => {
    setup();
    expect(await screen.findByText('name, college email, roll number, batch')).toBeInTheDocument();
  });
});
