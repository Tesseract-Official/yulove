import { normaliseEmail } from '@yulove/shared';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Why this email cannot be used, or undefined when it is a valid address on the college domain.
 * Only `@<domain>` exactly matches: sub-domains and look-alikes are rejected.
 */
export function collegeEmailProblem(email: string, collegeDomain: string): string | undefined {
  const value = normaliseEmail(email);
  if (!EMAIL_SHAPE.test(value)) return 'not a valid email address';
  if (!value.endsWith(`@${collegeDomain.toLowerCase()}`)) {
    return `email must end in @${collegeDomain.toLowerCase()}`;
  }
  return undefined;
}

export function requireCollegeDomain(): string {
  const domain = process.env['COLLEGE_DOMAIN'];
  if (!domain) throw new Error('Missing environment variable COLLEGE_DOMAIN');
  return domain.trim().toLowerCase();
}
