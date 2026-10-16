import { describe, expect, it } from 'vitest';
import { ROLES } from './index.js';

describe('shared', () => {
  it('defines the four roles', () => {
    expect(ROLES).toHaveLength(4);
  });
});
