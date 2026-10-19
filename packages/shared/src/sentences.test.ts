import { describe, expect, it } from 'vitest';
import {
  answerFailureText,
  endSentence,
  LEGACY_TESTGEN_BUSY_REASON,
  LEGACY_TRANSCRIBE_BUSY_REASON,
  testFailureText,
  TESTGEN_BUSY_REASON,
  TRANSCRIBE_BUSY_REASON,
} from './sentences.js';

describe('endSentence', () => {
  it.each([
    ['Gemini returned malformed JSON', 'Gemini returned malformed JSON.'],
    ['  trailing spaces  ', 'trailing spaces.'],
    ['Already ends.', 'Already ends.'],
    ['A question?', 'A question?'],
    ['Loud!', 'Loud!'],
    ['Cut short...', 'Cut short...'],
    ['Cut short…', 'Cut short…'],
    ['', ''],
    ['   ', ''],
  ])('%j → %j', (input, expected) => {
    expect(endSentence(input)).toBe(expected);
  });
});

describe('the busy texts', () => {
  it('are whole sentences that say what to do', () => {
    expect(TESTGEN_BUSY_REASON).toBe(
      'The tests could not be made because Gemini is busy. Wait a minute, then press Generate tests again.',
    );
    expect(TRANSCRIBE_BUSY_REASON).toBe(
      'Gemini is busy, so this answer could not be read. Wait a minute, then press Grade again.',
    );
    for (const text of [TESTGEN_BUSY_REASON, TRANSCRIBE_BUSY_REASON]) {
      expect(text.endsWith('.')).toBe(true);
      expect(text).not.toMatch(/\.\s*\.|[a-z] You can|again You/);
    }
  });
});

describe('testFailureText', () => {
  it('shows the busy sentence once, with nothing wrapped round it', () => {
    const text = testFailureText(TESTGEN_BUSY_REASON);
    expect(text).toBe(TESTGEN_BUSY_REASON);
    expect(text.match(/could not be made/g)).toHaveLength(1);
    expect(text).not.toMatch(/You can try again/);
  });

  it('shows the old stored busy text as the new sentence', () => {
    expect(testFailureText(LEGACY_TESTGEN_BUSY_REASON)).toBe(TESTGEN_BUSY_REASON);
  });

  it('puts any other reason after the lead, with a full stop and the way to try again', () => {
    expect(testFailureText('Gemini returned malformed JSON')).toBe(
      'The tests could not be made. Gemini returned malformed JSON. Press Generate tests to try again.',
    );
    expect(testFailureText('Gemini returned malformed JSON.')).toBe(
      'The tests could not be made. Gemini returned malformed JSON. Press Generate tests to try again.',
    );
  });

  it('says so when there is no reason', () => {
    expect(testFailureText(undefined)).toBe(
      'The tests could not be made. No reason was given. Press Generate tests to try again.',
    );
    expect(testFailureText('  ')).toBe(testFailureText(undefined));
  });
});

describe('answerFailureText', () => {
  it('maps the old busy text, ends other sentences and leaves nothing as nothing', () => {
    expect(answerFailureText(LEGACY_TRANSCRIBE_BUSY_REASON)).toBe(TRANSCRIBE_BUSY_REASON);
    expect(answerFailureText('The photo could not be found; upload it again')).toBe(
      'The photo could not be found; upload it again.',
    );
    expect(answerFailureText(undefined)).toBeUndefined();
    expect(answerFailureText('')).toBeUndefined();
  });
});
