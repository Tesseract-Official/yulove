import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeOidc, fakeUser, jsonResponse, meFor, renderApp } from '../../test/helpers.js';
import { questionResponse, questionSummary, testsResponse } from '../../test/fixtures.js';
import { apiError, mockApi, type Route } from '../../test/mockApi.js';

function open(route: string, extra: Record<string, Route> = {}) {
  const api = mockApi({
    'GET /me': meFor('TEACHER', { batchIds: ['A'] }),
    'GET /questions': { questions: [] },
    'GET /questions/:id': questionResponse(),
    'GET /questions/:id/tests': testsResponse(null),
    ...extra,
  });
  renderApp({ oidc: new FakeOidc(fakeUser()), route });
  return api;
}

afterEach(() => vi.unstubAllGlobals());

describe('the questions list', () => {
  it('shows each question with the state of its tests', async () => {
    open('/teacher/questions', {
      'GET /questions': {
        questions: [
          questionSummary({
            questionId: 'a',
            title: 'Alpha',
            testStatus: 'APPROVED',
            usedInExams: 2,
          }),
          questionSummary({ questionId: 'b', title: 'Bravo', testStatus: 'NEEDS_REVIEW' }),
          questionSummary({
            questionId: 'c',
            title: 'Charlie',
            testStatus: 'GENERATION_FAILED',
            testFailure: 'Gemini was busy',
          }),
          questionSummary({ questionId: 'd', title: 'Delta' }),
          questionSummary({ questionId: 'e', title: 'Echo', testStatus: 'GENERATING', version: 3 }),
        ],
      },
    });

    const card = (title: string) => screen.getByText(title).closest('li') as HTMLElement;
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(within(card('Alpha')).getByText('Approved')).toBeInTheDocument();
    expect(within(card('Alpha')).getByText(/In 2 exams/)).toBeInTheDocument();
    expect(within(card('Bravo')).getByText('Ready for review')).toBeInTheDocument();
    expect(within(card('Bravo')).getByText(/Not in any exam yet/)).toBeInTheDocument();
    expect(within(card('Charlie')).getByText('Failed')).toBeInTheDocument();
    expect(within(card('Charlie')).getByText('Gemini was busy')).toBeInTheDocument();
    expect(within(card('Delta')).getByText('Not generated yet')).toBeInTheDocument();
    expect(within(card('Echo')).getByText('Generating')).toBeInTheDocument();
    expect(within(card('Echo')).getByText(/Version 3/)).toBeInTheDocument();
  });

  it('links to edit a question and to its tests, and to write a new one', async () => {
    open('/teacher/questions', {
      'GET /questions': { questions: [questionSummary({ questionId: 'abc' })] },
    });

    expect(await screen.findByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/teacher/questions/abc',
    );
    expect(screen.getByRole('link', { name: 'Tests' })).toHaveAttribute(
      'href',
      '/teacher/questions/abc/tests',
    );
    expect(screen.getByRole('link', { name: 'Write a new question' })).toHaveAttribute(
      'href',
      '/teacher/questions/new',
    );
  });

  it('says whose question it is when a super admin sees someone else’s', async () => {
    open('/teacher/questions', {
      'GET /questions': { questions: [questionSummary({ teacherEmail: 'someone@college.edu' })] },
    });

    expect(await screen.findByText('Written by someone@college.edu')).toBeInTheDocument();
  });

  it('explains when there are no questions yet', async () => {
    open('/teacher/questions');

    expect(await screen.findByText('No questions yet')).toBeInTheDocument();
  });
});

async function fillNewQuestion() {
  await userEvent.type(await screen.findByLabelText('Title'), 'Two Sum');
  await userEvent.type(screen.getByLabelText('Statement'), 'Write a function called twoSum.');
  await userEvent.type(
    screen.getByLabelText('What the input and output look like'),
    'Array and target.',
  );
  await userEvent.type(screen.getByLabelText('Constraints'), 'n up to 100000');
  await userEvent.click(screen.getByLabelText('Example 1 input'));
  await userEvent.paste('{"nums":[2,7],"target":9}');
  await userEvent.click(screen.getByLabelText('Example 1 output'));
  await userEvent.paste('[0,1]');
  await userEvent.type(screen.getByLabelText('Time complexity students must meet'), 'O(n)');
}

describe('writing a new question', () => {
  it('suggests putting the function name in the statement', async () => {
    open('/teacher/questions/new');

    expect(await screen.findByText(/Say which function students should write/)).toBeInTheDocument();
  });

  it('shows what is missing, beside the fields, and sends nothing', async () => {
    const api = open('/teacher/questions/new');

    await userEvent.click(await screen.findByRole('button', { name: 'Save question' }));

    expect(
      await screen.findByText('Some answers need fixing. They are marked below.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Type a title for the question.')).toBeInTheDocument();
    expect(screen.getByText('Type the question statement.')).toBeInTheDocument();
    expect(screen.getByText('Type the example input.')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveAttribute('aria-invalid', 'true');
    expect(api.callsTo('POST /questions')).toHaveLength(0);
  });

  it('sends the question with the time limit in milliseconds, then goes to its tests', async () => {
    const api = open('/teacher/questions/new', {
      'POST /questions': (call) =>
        jsonResponse(
          { question: { ...(call.body as object), questionId: 'new-1', version: 1 } },
          201,
        ),
    });

    await fillNewQuestion();
    await userEvent.clear(screen.getByLabelText('Time limit (seconds)'));
    await userEvent.type(screen.getByLabelText('Time limit (seconds)'), '1.5');
    await userEvent.selectOptions(
      screen.getByLabelText('How an answer is compared with the expected output'),
      'ANY_ORDER',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save question' }));

    expect(
      await screen.findByText('Question saved. Next: generate its tests.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/teacher/questions/new-1/tests');
    expect(api.callsTo('POST /questions')[0]?.body).toEqual({
      title: 'Two Sum',
      statement: 'Write a function called twoSum.',
      ioDescription: 'Array and target.',
      constraints: 'n up to 100000',
      examples: [{ input: '{"nums":[2,7],"target":9}', output: '[0,1]' }],
      targetComplexity: 'O(n)',
      timeLimitMs: 1500,
      memoryMb: 256,
      compareMode: 'ANY_ORDER',
    });
  });

  it('adds and removes examples, up to three', async () => {
    open('/teacher/questions/new');
    await screen.findByLabelText('Title');

    await userEvent.click(screen.getByRole('button', { name: 'Add another example' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add another example' }));
    expect(screen.getByLabelText('Example 3 input')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add another example' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove example 2' }));
    expect(screen.queryByLabelText('Example 3 input')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add another example' })).toBeInTheDocument();
  });

  it('shows the API’s message when it refuses the question', async () => {
    open('/teacher/questions/new', {
      'POST /questions': apiError(422, 'VALIDATION_FAILED', 'Examples: at most 3'),
    });

    await fillNewQuestion();
    await userEvent.click(screen.getByRole('button', { name: 'Save question' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Examples: at most 3');
  });
});

describe('editing a question', () => {
  const save = (extra: Record<string, Route>) =>
    open('/teacher/questions/q1', {
      'GET /questions/:id': questionResponse({ testStatus: 'APPROVED' }),
      ...extra,
    });

  it('fills the form with the question, showing the time limit in seconds', async () => {
    open('/teacher/questions/q1', {
      'GET /questions/:id': questionResponse({
        timeLimitMs: 1500,
        memoryMb: 128,
        compareMode: 'FLOAT',
      }),
    });

    expect(await screen.findByLabelText('Title')).toHaveValue('Two Sum');
    expect(screen.getByLabelText('Time limit (seconds)')).toHaveValue('1.5');
    expect(screen.getByLabelText('Memory limit (MB)')).toHaveValue('128');
    expect(screen.getByLabelText('How an answer is compared with the expected output')).toHaveValue(
      'FLOAT',
    );
    expect(screen.getByLabelText('Example 1 explanation (optional)')).toHaveValue('2 + 7 = 9');
  });

  it('warns that saving makes a new version when the question is in use', async () => {
    open('/teacher/questions/q1', {
      'GET /questions/:id': questionResponse({ version: 2 }, { inUse: true, usedInExams: 1 }),
    });

    const warning = await screen.findByText(/already has answers/);
    expect(warning).toHaveTextContent('Saving creates a new version (version 3)');
    expect(warning).toHaveTextContent('The exam keeps using version 2');
  });

  it('says the changes apply to exams that have no answers yet', async () => {
    open('/teacher/questions/q1', {
      'GET /questions/:id': questionResponse({}, { inUse: false, usedInExams: 2 }),
    });

    expect(await screen.findByText(/used in 2 exams that have no answers yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Saving creates a new version/)).not.toBeInTheDocument();
  });

  it('shows no notice for a question nothing uses', async () => {
    open('/teacher/questions/q1');

    await screen.findByLabelText('Title');
    expect(screen.queryByText(/already has answers/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no answers yet/)).not.toBeInTheDocument();
  });

  it('warns when a change will throw the tests away, but not for the title or examples', async () => {
    save({});
    const title = await screen.findByLabelText('Title');

    await userEvent.type(title, ' (new)');
    await userEvent.type(screen.getByLabelText('Example 1 explanation (optional)'), ' again');
    expect(screen.queryByText(/must be generated and approved again/)).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Statement'), ' More words.');
    expect(await screen.findByText(/must be generated and approved again/)).toBeInTheDocument();
  });

  it('does not warn about tests for a question that has none', async () => {
    open('/teacher/questions/q1'); // testStatus undefined

    await userEvent.type(await screen.findByLabelText('Statement'), ' More words.');

    expect(screen.queryByText(/must be generated and approved again/)).not.toBeInTheDocument();
  });

  it('saves in place and says the tests were kept', async () => {
    const api = save({
      'PUT /questions/:id': (call) =>
        jsonResponse({
          question: {
            ...(call.body as object),
            questionId: 'q1',
            version: 1,
            testStatus: 'APPROVED',
          },
          newVersion: false,
          testsKept: true,
        }),
    });

    await userEvent.type(await screen.findByLabelText('Title'), ' (new)');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Saved. The tests were kept.')).toBeInTheDocument();
    expect(api.callsTo('PUT /questions/:id')[0]?.params['id']).toBe('q1');
    expect(api.callsTo('PUT /questions/:id')[0]?.body).toMatchObject({
      title: 'Two Sum (new)',
      timeLimitMs: 2000,
    });
  });

  it('says which version was made, and keeps the tests when only the title changed', async () => {
    save({
      'GET /questions/:id': questionResponse({ testStatus: 'APPROVED' }, { inUse: true }),
      'PUT /questions/:id': jsonResponse(
        {
          question: { ...questionResponse().question, version: 2, testStatus: 'APPROVED' },
          newVersion: true,
          testsKept: true,
        },
        201,
      ),
    });

    await userEvent.type(await screen.findByLabelText('Title'), ' v2');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Saved as version 2. The tests were kept.')).toBeInTheDocument();
  });

  it('goes to the tests screen when the change discarded the tests', async () => {
    save({
      'PUT /questions/:id': jsonResponse({
        question: { ...questionResponse().question, version: 1 },
        newVersion: false,
        testsKept: false,
      }),
    });

    await userEvent.type(await screen.findByLabelText('Statement'), ' More words.');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tests'));
    expect(
      await screen.findByText(/The old tests were removed because the question changed/),
    ).toBeInTheDocument();
  });

  it('shows the API’s message when saving fails', async () => {
    save({ 'PUT /questions/:id': apiError(409, 'CONFLICT', 'Question q1 v2 exists') });

    await userEvent.type(await screen.findByLabelText('Title'), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Question q1 v2 exists');
  });

  it('explains a question that cannot be loaded', async () => {
    open('/teacher/questions/q1', {
      'GET /questions/:id': apiError(403, 'FORBIDDEN', 'This question belongs to another teacher'),
    });

    expect(await screen.findByText('Could not load the question')).toBeInTheDocument();
    expect(screen.getByText(/You don't have access to this/)).toBeInTheDocument();
  });
});
