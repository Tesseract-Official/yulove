import { describe, expect, it } from 'vitest';
import { fakeUser } from '../test/helpers.js';
import { RENEW_SKEW_SECONDS, canRenew, needsRenewal, secondsLeft } from './session.js';

describe('needsRenewal', () => {
  it('is false for tokens with plenty of time left', () => {
    expect(needsRenewal(fakeUser())).toBe(false);
    expect(needsRenewal(fakeUser(undefined, { idTokenExpiresIn: RENEW_SKEW_SECONDS + 30 }))).toBe(
      false,
    );
  });

  it('is true once the ID token has expired or is about to', () => {
    expect(needsRenewal(fakeUser(undefined, { idTokenExpiresIn: -5 }))).toBe(true);
    expect(needsRenewal(fakeUser(undefined, { idTokenExpiresIn: 30 }))).toBe(true);
    expect(needsRenewal(fakeUser(undefined, { idTokenExpiresIn: RENEW_SKEW_SECONDS }))).toBe(true);
  });

  it('is true when the access token is the one that is running out', () => {
    expect(needsRenewal(fakeUser(undefined, { accessTokenExpiresIn: 10 }))).toBe(true);
  });
});

describe('secondsLeft', () => {
  it('counts down to whichever token expires first', () => {
    const user = fakeUser(undefined, { idTokenExpiresIn: 600, accessTokenExpiresIn: 3000 });
    const now = Date.now() / 1000;

    const left = secondsLeft(user, now) ?? 0;
    // (fakeUser rounds its times down to whole seconds.)
    expect(left).toBeGreaterThan(598);
    expect(left).toBeLessThanOrEqual(600);
  });
});

describe('canRenew', () => {
  it('needs a refresh token', () => {
    expect(canRenew(fakeUser())).toBe(true);
    expect(canRenew(fakeUser(undefined, { refreshToken: null }))).toBe(false);
    expect(canRenew(fakeUser(undefined, { refreshToken: '' }))).toBe(false);
  });
});
