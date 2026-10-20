import { describe, expect, it } from 'vitest';
import { auditEntryVisibleTo, isTeacherOverride, overrideVisibleTo } from './visibility.js';
import type { Override } from './types.js';

const by = (byRole?: Override['byRole']): Override => ({
  score: 9,
  reason: 'r',
  by: 'someone@x.com',
  at: 't',
  ...(byRole ? { byRole } : {}),
});

describe('what a super admin’s actions look like to each role', () => {
  it('a teacher’s override is visible to everyone who may see overrides', () => {
    for (const viewer of ['SUPER_ADMIN', 'TEACHER', 'BATCH_MANAGER'] as const) {
      expect(overrideVisibleTo(viewer, by('TEACHER'))).toEqual(by('TEACHER'));
    }
  });

  it('a super admin’s override, or one with no stored role, is visible only to super admins', () => {
    for (const override of [by('SUPER_ADMIN'), by()]) {
      expect(overrideVisibleTo('SUPER_ADMIN', override)).toBe(override);
      for (const viewer of ['TEACHER', 'BATCH_MANAGER', 'STUDENT'] as const) {
        expect(overrideVisibleTo(viewer, override)).toBeUndefined();
      }
    }
    expect(isTeacherOverride(by())).toBe(false);
    expect(overrideVisibleTo('TEACHER', undefined)).toBeUndefined();
  });

  it('audit entries by super admins, or with no stored role, are hidden from everyone else', () => {
    expect(auditEntryVisibleTo('SUPER_ADMIN', 'SUPER_ADMIN')).toBe(true);
    expect(auditEntryVisibleTo('SUPER_ADMIN', undefined)).toBe(true);
    expect(auditEntryVisibleTo('TEACHER', 'TEACHER')).toBe(true);
    expect(auditEntryVisibleTo('TEACHER', 'SUPER_ADMIN')).toBe(false);
    expect(auditEntryVisibleTo('TEACHER', undefined)).toBe(false);
  });
});
