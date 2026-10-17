import { ValidationError, mapLimit, type BatchItem, type UserItem } from '@yulove/shared';
import { batchesDb } from '@yulove/shared/server';

/** Throws ValidationError (422) listing every id that is not an existing batch. */
export async function assertBatchesExist(batchIds: readonly string[]): Promise<void> {
  const unique = [...new Set(batchIds)];
  const found = await mapLimit(unique, 10, (id) => batchesDb.getBatch(id));
  const missing = unique.filter((_, i) => !found[i]);
  if (missing.length > 0) {
    throw new ValidationError(`Unknown batches: ${missing.join(', ')}`, { missing });
  }
}

const byName = (a: BatchItem, b: BatchItem) => a.name.localeCompare(b.name);

/**
 * The batches a user works with, by name: every batch for a super admin, otherwise the ones they
 * are assigned to (a batch that no longer exists is skipped).
 */
export async function batchesFor(user: UserItem): Promise<BatchItem[]> {
  if (user.role === 'SUPER_ADMIN') return (await batchesDb.listBatches()).sort(byName);

  const ids = user.role === 'STUDENT' ? [user.batchId] : (user.batchIds ?? []);
  const found = await mapLimit(
    ids.filter((id): id is string => id !== undefined),
    10,
    (id) => batchesDb.getBatch(id),
  );
  return found.filter((b): b is BatchItem => b !== undefined);
}
