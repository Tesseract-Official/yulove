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

/** The text the API uses when a request body fails validation (it names no field itself). */
const GENERIC_VALIDATION_MESSAGE = 'Request body failed validation';

/** "batchId" → "batch id" */
const words = (field: string) => field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

/** The field names in the API's validation details (a zod error tree), if there are any. */
function invalidFields(details: unknown): string[] {
  const properties = (details as { properties?: Record<string, unknown> } | undefined)?.properties;
  return properties && typeof properties === 'object' ? Object.keys(properties).map(words) : [];
}

function describeApiError(error: ApiError): string {
  if (error.status === 403) {
    return "You don't have access to this. Ask an admin to check your batches.";
  }
  if (error.status === 404 && error.message === 'Not found') {
    return 'That could not be found. It may have been removed.';
  }
  if (error.status === 422 && error.message === GENERIC_VALIDATION_MESSAGE) {
    const fields = invalidFields(error.details);
    return fields.length > 0
      ? `Please check: ${fields.join(', ')}. Then try again.`
      : 'Some details are not valid. Check the form and try again.';
  }
  return error.message;
}

/**
 * A message that is safe to show a person for any thrown value. The API's own messages are written
 * in plain words and are shown as they are; the generic ones (403, empty 404, unnamed 422) are
 * replaced with something that says what to do.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return describeApiError(error);
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
