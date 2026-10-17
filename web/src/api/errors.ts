/** Any failed API call. `status` is 0 when the server could not be reached at all. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

/** A message that is safe to show a person for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
