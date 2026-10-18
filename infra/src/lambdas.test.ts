import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp } from './testing.js';

// These build the whole CDK app; on a busy machine that can take longer than vitest's 5 seconds.
const SYNTH_TIMEOUT_MS = 60_000;

describe('all Lambdas in the app', () => {
  it(
    'use the Node.js 22 runtime',
    () => {
      const { templates } = buildApp();
      let seen = 0;
      for (const template of Object.values(templates)) {
        for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
          seen += 1;
          expect(fn.Properties.Runtime).toBe('nodejs22.x');
        }
      }
      expect(seen).toBeGreaterThan(0);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    'reserve no concurrency anywhere: the account allows only 10 in total',
    () => {
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
    },
    SYNTH_TIMEOUT_MS,
  );
});

describe('log groups', () => {
  // The worker's group is in the Worker stack; everything else is built without Docker.
  const stacks = () => {
    const { templates, worker } = buildApp(undefined, { routes: true, worker: true });
    return [...Object.values(templates), ...(worker ? [Template.fromStack(worker)] : [])];
  };

  it(
    'every log group in the app keeps its logs for 30 days',
    () => {
      let seen = 0;
      for (const template of stacks()) {
        for (const group of Object.values(template.findResources('AWS::Logs::LogGroup'))) {
          seen += 1;
          expect(group.Properties.RetentionInDays).toBe(30);
        }
      }
      expect(seen).toBeGreaterThan(0);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    'every Lambda writes to a log group of its own, so none keeps logs forever',
    () => {
      let functions = 0;
      let groups = 0;
      for (const template of stacks()) {
        groups += Object.keys(template.findResources('AWS::Logs::LogGroup')).length;
        for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
          functions += 1;
          expect(fn.Properties.LoggingConfig?.LogGroup, fn.Properties.Description).toBeDefined();
        }
      }
      // One group per Lambda, plus the worker's.
      expect(groups).toBe(functions + 1);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    'adds no custom-resource Lambda for retention',
    () => {
      for (const template of stacks()) {
        expect(Object.keys(template.findResources('Custom::LogRetention'))).toEqual([]);
        expect(
          Object.values(template.findResources('AWS::Lambda::Function')).filter((fn) =>
            String(fn.Properties.Description ?? '').includes('LogRetention'),
          ),
        ).toEqual([]);
      }
    },
    SYNTH_TIMEOUT_MS,
  );
});
