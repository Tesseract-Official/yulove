import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp, TEST_CONTEXT } from '../testing.js';
import {
  FAILED_TO_GRADE_PER_HOUR,
  APP_ERRORS_PER_5_MINUTES,
  MAX_ALARMS_IN_APP,
  MONITORING_ALARM_COUNT,
  QUEUE_AGE_ALARM_SECONDS,
} from './monitoring-stack.js';

const { monitoring } = buildApp(undefined, { monitoring: true });
const template = Template.fromStack(monitoring as NonNullable<typeof monitoring>);

const alarmNamed = (name: string) => {
  const found = Object.values(template.findResources('AWS::CloudWatch::Alarm')).filter(
    (a) => a.Properties.AlarmName === name,
  );
  expect(found, name).toHaveLength(1);
  return found[0]?.Properties as Record<string, unknown>;
};

describe('MonitoringStack topic', () => {
  it('is one SNS topic that emails the budget address', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::SNS::Subscription', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'alerts@college.edu',
    });
  });

  it('makes no subscription for a <PLACEHOLDER> address, so the app still synthesizes', () => {
    const placeholder = buildApp(
      { ...TEST_CONTEXT, budgetEmail: '<ALERT_EMAIL>' },
      {
        monitoring: true,
      },
    );
    const t = Template.fromStack(
      placeholder.monitoring as NonNullable<typeof placeholder.monitoring>,
    );
    t.resourceCountIs('AWS::SNS::Topic', 1);
    t.resourceCountIs('AWS::SNS::Subscription', 0);
  });
});

describe('MonitoringStack alarms', () => {
  it('has exactly the five alarms', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 5);
    expect(MONITORING_ALARM_COUNT).toBe(5);
  });

  it.each([
    ['transcribe', 3600],
    ['execute', 3600],
    ['results', 900],
  ] as const)(
    'alarms when the oldest message on the %s queue is over %i seconds old',
    (queue, seconds) => {
      const alarm = alarmNamed(`dsa-judge-${queue}-queue-oldest-message`);
      expect(alarm).toMatchObject({
        Namespace: 'AWS/SQS',
        MetricName: 'ApproximateAgeOfOldestMessage',
        Statistic: 'Maximum',
        Period: 300,
        Threshold: seconds,
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 1,
        TreatMissingData: 'notBreaching',
      });
      expect(JSON.stringify(alarm['Dimensions'])).toContain(`${queue}Queue`);
      expect(QUEUE_AGE_ALARM_SECONDS[queue]).toBe(seconds);
    },
  );

  it('alarms on more than 20 FAILED_TO_GRADE answers in an hour', () => {
    expect(alarmNamed('dsa-judge-failed-to-grade')).toMatchObject({
      Namespace: 'DsaJudge',
      MetricName: 'FailedToGrade',
      Statistic: 'Sum',
      Period: 3600,
      Threshold: FAILED_TO_GRADE_PER_HOUR,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
    expect(FAILED_TO_GRADE_PER_HOUR).toBe(20);
  });

  it('alarms on more than 5 AppError metrics in 5 minutes, from this app only', () => {
    const alarm = alarmNamed('dsa-judge-app-errors');
    expect(alarm).toMatchObject({
      Namespace: 'DsaJudge',
      MetricName: 'AppError',
      Statistic: 'Sum',
      Period: 300,
      Threshold: APP_ERRORS_PER_5_MINUTES,
      ComparisonOperator: 'GreaterThanThreshold',
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
    });
    expect(APP_ERRORS_PER_5_MINUTES).toBe(5);
    expect(alarm).not.toHaveProperty('Dimensions');
  });

  it('no longer watches the account-wide AWS/Lambda Errors metric', () => {
    for (const a of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
      expect(a.Properties.Namespace).not.toBe('AWS/Lambda');
    }
  });

  it('tells the topic when an alarm starts and when it clears', () => {
    for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
      expect(alarm.Properties.AlarmActions).toEqual([
        { Ref: expect.stringMatching(/^AlertsTopic/) },
      ]);
      expect(alarm.Properties.OKActions).toEqual([{ Ref: expect.stringMatching(/^AlertsTopic/) }]);
    }
  });
});

describe('alarms in the whole app', () => {
  it('stay within the free tier: at most 10 in total', () => {
    const { monitoring: m, worker } = buildApp(undefined, { monitoring: true, worker: true });
    const count = (stack: Parameters<typeof Template.fromStack>[0]) =>
      Object.keys(Template.fromStack(stack).findResources('AWS::CloudWatch::Alarm')).length;
    const total = count(m as NonNullable<typeof m>) + count(worker as NonNullable<typeof worker>);
    expect(total).toBe(7); // 5 here and the worker's 2 scaling alarms
    expect(total).toBeLessThanOrEqual(MAX_ALARMS_IN_APP);
  });

  it('are the only resources of the stack besides the topic', () => {
    const types = new Set(
      Object.values(template.toJSON().Resources as Record<string, { Type: string }>).map(
        (r) => r.Type,
      ),
    );
    expect([...types].sort()).toEqual(
      ['AWS::CloudWatch::Alarm', 'AWS::SNS::Subscription', 'AWS::SNS::Topic'].sort(),
    );
  });
});
