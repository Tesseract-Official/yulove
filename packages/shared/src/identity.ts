/** Emails are stored and compared trimmed and lower-case, everywhere. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Roll numbers are compared case-insensitively and stored trimmed and upper-case. */
export function normaliseRollNo(rollNo: string): string {
  return rollNo.trim().toUpperCase();
}
