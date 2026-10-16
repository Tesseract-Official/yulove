import { describe, expect, it } from 'vitest';
import { SCRIPTS_READY } from './index.js';

describe('scripts', () => {
  it('loads', () => {
    expect(SCRIPTS_READY).toBe(true);
  });
});
