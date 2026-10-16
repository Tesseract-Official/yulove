import { describe, expect, it } from 'vitest';
import { SERVICE_NAME } from './index.js';

describe('api', () => {
  it('resolves the shared package', () => {
    expect(SERVICE_NAME).toBe('paper-dsa-exam-judge/api');
  });
});
