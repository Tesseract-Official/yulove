import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
  type IMetric,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Queue } from 'aws-cdk-lib/aws-sqs';
import {
  FAILED_TO_GRADE_METRIC,
  METRIC_NAMESPACE,
  QUEUE_NAMES,
  type QueueName,
} from '@yulove/shared';
import type { Construct } from 'constructs';

/**
 * A queue's oldest message waiting longer than this raises an alarm. For the execute queue it also
 * catches the worker not starting, since the worker is scaled to zero.
 */
export const QUEUE_AGE_ALARM_SECONDS = 15 * 60;

/** More answers than this ending as FAILED_TO_GRADE in an hour raises an alarm. */
export const FAILED_TO_GRADE_PER_HOUR = 20;

/** More Lambda errors than this in 5 minutes raises an alarm. */
export const LAMBDA_ERRORS_PER_5_MINUTES = 3;

/**
 * The most CloudWatch alarms the whole app may have, to stay inside the free tier. The worker
 * stack has two (its scaling alarms); this stack has MONITORING_ALARM_COUNT.
 */
export const MAX_ALARMS_IN_APP = 10;
export const MONITORING_ALARM_COUNT = QUEUE_NAMES.length + 2;

export interface MonitoringStackProps extends StackProps {
  queues: Record<QueueName, Queue>;
  /** Who is emailed. A `<PLACEHOLDER>` is accepted so the app still synthesizes; nobody is emailed. */
  alertEmail: string;
}

/**
 * Alarms that email the founders. Everything here is a single-metric standard alarm:
 *  - the oldest message on each queue (transcribe, execute, results) is over 15 minutes old;
 *  - more than 20 answers in an hour ended as FAILED_TO_GRADE (embedded metric format, printed by
 *    the transcribe and record Lambdas and the submit route);
 *  - Lambda errors across the region (one alarm for all functions: the AWS/Lambda metric without a
 *    function dimension, which also counts any other Lambda in the account).
 * It is a leaf stack, so nothing depends on it.
 */
export class MonitoringStack extends Stack {
  readonly topic: Topic;
  readonly alarms: Alarm[] = [];

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    this.topic = new Topic(this, 'AlertsTopic', {
      topicName: 'dsa-judge-alerts',
      displayName: 'DSA Judge alerts',
    });
    if (!/^<.+>$/.test(props.alertEmail)) {
      this.topic.addSubscription(new EmailSubscription(props.alertEmail));
    }

    for (const name of QUEUE_NAMES) {
      this.addAlarm(`${name}QueueAgeAlarm`, {
        alarmName: `dsa-judge-${name}-queue-oldest-message`,
        description: `The oldest message on the ${name} queue has waited over ${QUEUE_AGE_ALARM_SECONDS / 60} minutes.`,
        metric: props.queues[name].metricApproximateAgeOfOldestMessage({
          period: Duration.minutes(5),
          statistic: 'Maximum',
        }),
        threshold: QUEUE_AGE_ALARM_SECONDS,
      });
    }

    this.addAlarm('FailedToGradeAlarm', {
      alarmName: 'dsa-judge-failed-to-grade',
      description: `More than ${FAILED_TO_GRADE_PER_HOUR} answers could not be graded in an hour.`,
      metric: new Metric({
        namespace: METRIC_NAMESPACE,
        metricName: FAILED_TO_GRADE_METRIC,
        statistic: 'Sum',
        period: Duration.hours(1),
      }),
      threshold: FAILED_TO_GRADE_PER_HOUR,
    });

    this.addAlarm('LambdaErrorsAlarm', {
      alarmName: 'dsa-judge-lambda-errors',
      description: `More than ${LAMBDA_ERRORS_PER_5_MINUTES} Lambda errors in 5 minutes (all functions in the region).`,
      metric: new Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        statistic: 'Sum',
        period: Duration.minutes(5),
      }),
      threshold: LAMBDA_ERRORS_PER_5_MINUTES,
    });
  }

  private addAlarm(
    id: string,
    options: { alarmName: string; description: string; metric: IMetric; threshold: number },
  ): void {
    const alarm = new Alarm(this, id, {
      alarmName: options.alarmName,
      alarmDescription: options.description,
      metric: options.metric,
      threshold: options.threshold,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      // A quiet queue or a month without a failure sends no data; that is not a problem.
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new SnsAction(this.topic));
    alarm.addOkAction(new SnsAction(this.topic));
    this.alarms.push(alarm);
  }
}
