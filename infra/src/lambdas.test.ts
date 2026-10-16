import { describe, expect, it } from 'vitest';
import { buildApp } from './testing.js';

describe('all Lambdas in the app', () => {
  it('use the Node.js 22 runtime', () => {
    const { templates } = buildApp();
    let seen = 0;
    for (const template of Object.values(templates)) {
      for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
        seen += 1;
        expect(fn.Properties.Runtime).toBe('nodejs22.x');
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});
