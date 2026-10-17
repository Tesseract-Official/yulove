import type { Role } from '@yulove/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakeOidc,
  ID_TOKEN,
  ACCESS_TOKEN,
  apiErrorResponse,
  fakeUser,
  jsonResponse,
  meFor,
  renderApp,
  stubApi,
} from './test/helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const signedIn = () => new FakeOidc(fakeUser());
const location = () => screen.getByTestId('location');

const HOMES: Array<[Role, string, string]> = [
  ['SUPER_ADMIN', '/admin', 'Admin'],
  ['BATCH_MANAGER', '/manager', 'Batch manager'],
  ['TEACHER', '/teacher', 'Teacher'],
  ['STUDENT', '/student', 'Student'],
];

describe('routing by role', () => {
  it.each(HOMES)('sends a %s from / to %s', async (role, path, title) => {
    stubApi(() => jsonResponse(meFor(role)));

    renderApp({ oidc: signedIn() });

    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(location()).toHaveTextContent(path);
    // The student home is still a placeholder that lists the user's batches.
    if (role === 'STUDENT') {
      expect(screen.getByText('Batch Alpha')).toBeInTheDocument();
    }
  });

  it('asks GET /me with the ID token, not the access token', async () => {
    const fetchMock = stubApi(() => jsonResponse(meFor('STUDENT')));

    renderApp({ oidc: signedIn() });
    await screen.findByRole('heading', { level: 1, name: 'Student' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/me');
    const authorization = (init?.headers as Record<string, string>)['authorization'];
    expect(authorization).toBe(`Bearer ${ID_TOKEN}`);
    expect(authorization).not.toContain(ACCESS_TOKEN);
  });

  it('shows an empty state for a user with no batches', async () => {
    stubApi(() => jsonResponse(meFor('STUDENT', { batches: [] })));

    renderApp({ oidc: signedIn(), route: '/student' });

    expect(await screen.findByText('No batches yet')).toBeInTheDocument();
  });
});

describe('guards', () => {
  it.each([
    ['TEACHER', '/admin', '/teacher'],
    ['TEACHER', '/manager', '/teacher'],
    ['BATCH_MANAGER', '/teacher', '/manager'],
    ['BATCH_MANAGER', '/admin', '/manager'],
    ['STUDENT', '/teacher', '/student'],
    ['STUDENT', '/admin', '/student'],
    ['STUDENT', '/manager/anything/else', '/student'],
  ] as const)('keeps a %s out of %s', async (role, blocked, home) => {
    stubApi(() => jsonResponse(meFor(role)));

    renderApp({ oidc: signedIn(), route: blocked });

    await waitFor(() => expect(location()).toHaveTextContent(home));
    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument();
  });

  it('lets a user open their own section', async () => {
    stubApi(() => jsonResponse(meFor('TEACHER')));

    renderApp({ oidc: signedIn(), route: '/teacher' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Teacher' })).toBeInTheDocument();
  });

  it('lets a super admin open every section through the switcher', async () => {
    stubApi(() => jsonResponse(meFor('SUPER_ADMIN')));
    renderApp({ oidc: signedIn(), route: '/admin' });

    const switcher = await screen.findByRole('navigation', { name: 'Sections' });
    expect(
      within(switcher)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Admin', 'Batch manager', 'Teacher', 'Student']);

    for (const [, path, title] of HOMES) {
      await userEvent.click(within(switcher).getByRole('link', { name: title }));
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      expect(location()).toHaveTextContent(path);
    }
  });

  it('sends a signed-out visitor to the landing page and back after sign-in', async () => {
    stubApi(() => jsonResponse(meFor('TEACHER')));
    const oidc = new FakeOidc();

    renderApp({ oidc, route: '/teacher' });

    const button = await screen.findByRole('button', { name: 'Sign in with Google' });
    expect(location()).toHaveTextContent('/');
    expect(screen.queryByRole('heading', { name: 'Teacher' })).not.toBeInTheDocument();

    await userEvent.click(button);
    expect(oidc.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: '/teacher' } });
  });

  it('shows the sign-in page at / when signed out', async () => {
    renderApp();

    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
  });

  it('sends unknown addresses to /', async () => {
    stubApi(() => jsonResponse(meFor('STUDENT')));

    renderApp({ oidc: signedIn(), route: '/nowhere' });

    await waitFor(() => expect(location()).toHaveTextContent('/student'));
  });
});

describe('GET /me failures', () => {
  it('shows the not-registered page on 403, with a working sign-out', async () => {
    stubApi(() => apiErrorResponse(403, 'FORBIDDEN', 'You do not have access to this'));
    const navigateExternal = vi.fn();
    const oidc = signedIn();

    renderApp({ oidc, navigateExternal });

    expect(
      await screen.findByText("Your account isn't registered. Contact your batch manager."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // not a toast either

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(oidc.removeUser).toHaveBeenCalled();
    expect(navigateExternal).toHaveBeenCalledTimes(1);
  });

  it('blocks every section for an unregistered account', async () => {
    stubApi(() => apiErrorResponse(403, 'FORBIDDEN', 'nope'));

    renderApp({ oidc: signedIn(), route: '/admin' });

    expect(await screen.findByText(/isn't registered/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('shows an error with a retry for other failures', async () => {
    let calls = 0;
    stubApi(() => {
      calls += 1;
      return calls === 1
        ? apiErrorResponse(404, 'NOT_FOUND', 'Not found')
        : jsonResponse(meFor('STUDENT'));
    });

    renderApp({ oidc: signedIn() });

    expect(await screen.findByText('Could not load your account')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Student' })).toBeInTheDocument();
  });
});
