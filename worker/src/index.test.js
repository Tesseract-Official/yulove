import { describe, expect, it } from 'vitest';
import { WORKER_NAME } from './index.js';

describe('worker', () => {
  it('loads', () => {
    expect(WORKER_NAME).toBe('execution-worker');
  });
});
