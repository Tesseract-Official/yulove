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
  APP_ERROR_METRIC,
  FAILED_TO_GRADE_METRIC,
  METRIC_NAMESPACE,
  QUEUE_NAMES,
  type QueueName,
} from '@yulove/shared';
import type { Construct } from 'constructs';

/**
 * A queue's oldest message waiting longer than this raises an alarm, in seconds. Transcription and
 * execution are throttled on purpose (5 Gemini calls at once, one worker), so after a bulk upload
 * the oldest message can honestly wait a long time; an hour means something is stuck. For the
 * execute queue it also catches the worker not starting, since the worker is scaled to zero.
 * Recording is quick, so a results message waiting 15 minutes is already wrong.
 */
export const QUEUE_AGE_ALARM_SECONDS: Record<QueueName, number> = {
  transcribe: 60 * 60,
  execute: 60 * 60,
  results: 15 * 60,
};

/** More answers than this ending as FAILED_TO_GRADE in an hour raises an alarm. */
export const FAILED_TO_GRADE_PER_HOUR = 20;

/**
 * More `AppError` metrics than this in 5 minutes raise an alarm. The app prints one for each 5xx
 * the API returns and each error a pipeline Lambda catches without having planned for it.
 */
export const APP_ERRORS_PER_5_MINUTES = 5;

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
 *  - the oldest message on each queue waits too long (over 60 minutes for transcribe and execute, 15 for results);
 *  - more than 20 answers in an hour ended as FAILED_TO_GRADE (embedded metric format, printed by
 *    the transcribe and record Lambdas and the submit route);
 *  - more than 5 `AppError` metrics in 5 minutes (embedded metric format, printed by apiHandler on
 *    a 5xx and by the pipeline Lambdas on an unexpected caught error). It counts only this app, and
 *    not a Gemini-busy redelivery or a handled FAILED_TO_GRADE.
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
        description: `The oldest message on the ${name} queue has waited over ${QUEUE_AGE_ALARM_SECONDS[name] / 60} minutes.`,
        metric: props.queues[name].metricApproximateAgeOfOldestMessage({
          period: Duration.minutes(5),
          statistic: 'Maximum',
        }),
        threshold: QUEUE_AGE_ALARM_SECONDS[name],
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

    this.addAlarm('AppErrorsAlarm', {
      alarmName: 'dsa-judge-app-errors',
      description: `More than ${APP_ERRORS_PER_5_MINUTES} unexpected app errors (API 5xx or an unplanned pipeline error) in 5 minutes.`,
      metric: new Metric({
        namespace: METRIC_NAMESPACE,
        metricName: APP_ERROR_METRIC,
        statistic: 'Sum',
        period: Duration.minutes(5),
      }),
      threshold: APP_ERRORS_PER_5_MINUTES,
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
