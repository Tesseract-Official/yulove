import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

export const QUEUE_NAMES = ['transcribe', 'execute', 'results'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

const VISIBILITY_MINUTES: Record<QueueName, number> = {
  transcribe: 12,
  execute: 10,
  results: 3,
};

export class QueueStack extends Stack {
  readonly queues: Record<QueueName, Queue>;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const queues = {} as Record<QueueName, Queue>;
    for (const name of QUEUE_NAMES) {
      // No dead-letter queue by design: each stage catches its own errors (docs/DESIGN.md).
      queues[name] = new Queue(this, `${name}Queue`, {
        queueName: `${name}.fifo`,
        fifo: true,
        contentBasedDeduplication: false,
        visibilityTimeout: Duration.minutes(VISIBILITY_MINUTES[name]),
      });
    }
    this.queues = queues;
  }
}
