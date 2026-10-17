import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';

const complete = {
  collegeDomain: 'college.edu',
  webOrigin: 'https://a.edu',
  geminiTestgenModel: 'gemini-testgen',
  geminiTranscribeModel: 'gemini-transcribe',
  budgetEmail: 'alerts@college.edu',
  superAdminEmails: ['founder@gmail.com'],
};

type Context = Record<string, string | string[] | undefined>;
const nodeWith = (context: Context) => new App({ context }).node;
const without = (key: keyof typeof complete) => ({ ...complete, [key]: undefined });

describe('readConfig', () => {
  it('reads and normalises the context values', () => {
    const config = readConfig(
      nodeWith({
        collegeDomain: '@College.EDU',
        webOrigin: 'https://a.edu/, http://localhost:5173',
        geminiTestgenModel: ' gemini-x ',
        geminiTranscribeModel: ' gemini-y ',
        budgetEmail: ' alerts@college.edu ',
        superAdminEmails: ['Founder@Gmail.com'],
      }),
    );
    expect(config).toEqual({
      collegeDomain: 'college.edu',
      webOrigins: ['https://a.edu', 'http://localhost:5173'],
      geminiTestgenModel: 'gemini-x',
      geminiTranscribeModel: 'gemini-y',
      budgetEmail: 'alerts@college.edu',
      superAdminEmails: ['founder@gmail.com'],
    });
  });

  it('keeps the two Gemini models separate', () => {
    const config = readConfig(nodeWith(complete));
    expect(config.geminiTestgenModel).toBe('gemini-testgen');
    expect(config.geminiTranscribeModel).toBe('gemini-transcribe');
  });

  it.each(Object.keys(complete) as Array<keyof typeof complete>)(
    'throws when %s is missing',
    (key) => {
      expect(() => readConfig(nodeWith(without(key)))).toThrow(new RegExp(key));
    },
  );

  it('no longer reads the old single geminiModel setting', () => {
    const old = {
      ...complete,
      geminiTestgenModel: undefined,
      geminiTranscribeModel: undefined,
      geminiModel: 'g',
    };
    expect(() => readConfig(nodeWith(old))).toThrow(/geminiTestgenModel/);
  });

  it('rejects a webOrigin with a path', () => {
    expect(() => readConfig(nodeWith({ ...complete, webOrigin: 'https://a.edu/app' }))).toThrow(
      /origin/,
    );
  });

  describe('budgetEmail', () => {
    it('accepts a placeholder, so the app can be synthesised before the address is known', () => {
      expect(readConfig(nodeWith({ ...complete, budgetEmail: '<BUDGET_EMAIL>' })).budgetEmail).toBe(
        '<BUDGET_EMAIL>',
      );
    });

    it.each(['not an email', 'a@b', '@college.edu', 'two@@college.edu'])('rejects %j', (value) => {
      expect(() => readConfig(nodeWith({ ...complete, budgetEmail: value }))).toThrow(
        /budgetEmail/,
      );
    });
  });

  describe('superAdminEmails', () => {
    const read = (superAdminEmails: string | string[] | undefined) =>
      readConfig(nodeWith({ ...complete, superAdminEmails })).superAdminEmails;

    it('reads a list, trimming, lower-casing and removing duplicates', () => {
      expect(read([' A@Gmail.com', 'b@gmail.com', 'a@gmail.com'])).toEqual([
        'a@gmail.com',
        'b@gmail.com',
      ]);
    });

    it('reads a comma-separated string, as passed with -c on the command line', () => {
      expect(read('a@gmail.com, B@gmail.com,')).toEqual(['a@gmail.com', 'b@gmail.com']);
    });

    it.each([undefined, [], '', [' ']])('throws when the list is %j', (value) => {
      expect(() => read(value)).toThrow(/superAdminEmails/);
    });

    it.each([['not an email'], ['a@b'], ['ok@gmail.com', 'two@@gmail.com']])(
      'rejects %j',
      (...values) => {
        expect(() => read(values)).toThrow(/superAdminEmails must contain email addresses/);
      },
    );
  });
});
