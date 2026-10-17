import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';

const complete = {
  collegeDomain: 'college.edu',
  webOrigin: 'https://a.edu',
  geminiTestgenModel: 'gemini-testgen',
  geminiTranscribeModel: 'gemini-transcribe',
  budgetEmail: 'alerts@college.edu',
};

const nodeWith = (context: Record<string, string | undefined>) => new App({ context }).node;
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
      }),
    );
    expect(config).toEqual({
      collegeDomain: 'college.edu',
      webOrigins: ['https://a.edu', 'http://localhost:5173'],
      geminiTestgenModel: 'gemini-x',
      geminiTranscribeModel: 'gemini-y',
      budgetEmail: 'alerts@college.edu',
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
});
