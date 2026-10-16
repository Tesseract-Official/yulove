import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';

const nodeWith = (context: Record<string, string>) => new App({ context }).node;

describe('readConfig', () => {
  it('reads and normalises the context values', () => {
    const config = readConfig(
      nodeWith({
        collegeDomain: '@College.EDU',
        webOrigin: 'https://a.edu/, http://localhost:5173',
      }),
    );
    expect(config).toEqual({
      collegeDomain: 'college.edu',
      webOrigins: ['https://a.edu', 'http://localhost:5173'],
    });
  });

  it('throws when collegeDomain is missing', () => {
    expect(() => readConfig(nodeWith({ webOrigin: 'https://a.edu' }))).toThrow(/collegeDomain/);
  });

  it('throws when webOrigin is missing', () => {
    expect(() => readConfig(nodeWith({ collegeDomain: 'college.edu' }))).toThrow(/webOrigin/);
  });

  it('rejects a webOrigin with a path', () => {
    expect(() =>
      readConfig(nodeWith({ collegeDomain: 'college.edu', webOrigin: 'https://a.edu/app' })),
    ).toThrow(/origin/);
  });
});
