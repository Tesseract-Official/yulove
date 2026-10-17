import { describe, expect, it } from 'vitest';
import { ApiError, errorMessage } from './errors.js';

describe('errorMessage', () => {
  it('says what to do when access is refused', () => {
    expect(errorMessage(new ApiError(403, 'FORBIDDEN', 'Your role cannot do this'))).toBe(
      "You don't have access to this. Ask an admin to check your batches.",
    );
  });

  it('replaces the empty "Not found", but keeps a specific message', () => {
    expect(errorMessage(new ApiError(404, 'NOT_FOUND', 'Not found'))).toBe(
      'That could not be found. It may have been removed.',
    );
    expect(errorMessage(new ApiError(404, 'NOT_FOUND', 'No batch X'))).toBe('No batch X');
  });

  it('names the fields the API said were not valid', () => {
    const details = {
      errors: [],
      properties: { batchId: { errors: ['x'] }, name: { errors: ['y'] } },
    };
    expect(
      errorMessage(
        new ApiError(422, 'VALIDATION_FAILED', 'Request body failed validation', details),
      ),
    ).toBe('Please check: batch id, name. Then try again.');
    expect(
      errorMessage(new ApiError(422, 'VALIDATION_FAILED', 'Request body failed validation')),
    ).toBe('Some details are not valid. Check the form and try again.');
  });

  it('keeps the messages the API wrote in plain words', () => {
    expect(errorMessage(new ApiError(409, 'CONFLICT', '3 answers are still being graded.'))).toBe(
      '3 answers are still being graded.',
    );
    expect(
      errorMessage(new ApiError(422, 'VALIDATION_FAILED', 'Email: must end in @college.edu')),
    ).toBe('Email: must end in @college.edu');
    expect(errorMessage(new Error('Something broke'))).toBe('Something broke');
    expect(errorMessage('weird')).toBe('Something went wrong. Please try again.');
  });
});
