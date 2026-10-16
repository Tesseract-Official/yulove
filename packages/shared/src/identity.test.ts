import { describe, expect, it } from 'vitest';
import { normaliseEmail, normaliseRollNo } from './identity.js';

describe('normaliseEmail', () => {
  it.each([
    ['Student@College.edu', 'student@college.edu'],
    ['  STUDENT@COLLEGE.EDU  ', 'student@college.edu'],
    ['already@lower.case', 'already@lower.case'],
  ])('%j -> %j', (input, expected) => {
    expect(normaliseEmail(input)).toBe(expected);
  });
});

describe('normaliseRollNo', () => {
  it.each([
    ['22cs101', '22CS101'],
    ['  22Cs101 ', '22CS101'],
    ['22CS101', '22CS101'],
    ['cs-101/a', 'CS-101/A'],
  ])('%j -> %j', (input, expected) => {
    expect(normaliseRollNo(input)).toBe(expected);
  });

  it('makes case variants equal', () => {
    expect(normaliseRollNo('22cs101')).toBe(normaliseRollNo('22CS101'));
  });
});
