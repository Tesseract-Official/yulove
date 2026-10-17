import { Template } from 'aws-cdk-lib/assertions';
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

  it('reserve no concurrency anywhere: the account allows only 10 in total', () => {
    const { templates, worker } = buildApp(undefined, { routes: true, worker: true });
    const all = [...Object.values(templates), ...(worker ? [Template.fromStack(worker)] : [])];
    let seen = 0;
    for (const template of all) {
      for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
        seen += 1;
        expect(fn.Properties).not.toHaveProperty('ReservedConcurrentExecutions');
      }
      expect(
        Object.keys(template.findResources('AWS::Lambda::ProvisionedConcurrencyConfig')),
      ).toEqual([]);
    }
    // Every route, the pre-sign-up trigger, test generation and transcribe.
    expect(seen).toBeGreaterThanOrEqual(20);
  });
});
