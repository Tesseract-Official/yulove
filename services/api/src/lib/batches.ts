import { ValidationError } from '@yulove/shared';
import { batchesDb } from '@yulove/shared/server';
import { mapLimit } from './concurrency.js';

/** Throws ValidationError (422) listing every id that is not an existing batch. */
export async function assertBatchesExist(batchIds: readonly string[]): Promise<void> {
  const unique = [...new Set(batchIds)];
  const found = await mapLimit(unique, 10, (id) => batchesDb.getBatch(id));
  const missing = unique.filter((_, i) => !found[i]);
  if (missing.length > 0) {
    throw new ValidationError(`Unknown batches: ${missing.join(', ')}`, { missing });
  }
}
