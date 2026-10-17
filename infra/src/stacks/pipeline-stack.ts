import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Bucket } from 'aws-cdk-lib/aws-s3';
import type { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Queue } from 'aws-cdk-lib/aws-sqs';
import { BUCKET_ENV, QUEUE_ENV, TABLE_ENV } from '@yulove/shared';
import type { Construct } from 'constructs';
import { serviceEntry } from '../lib/handler-paths.js';
import { createNodeFunction } from '../lib/node-function.js';
import { grantObjects } from '../lib/s3-grants.js';
import { GEMINI_SECRET_NAME } from './data-stack.js';

/** Most transcriptions that run at the same time. */
export const TRANSCRIBE_MAX_CONCURRENCY = 5;

export interface PipelineStackProps extends StackProps {
  /** Gemini model for generating tests (the Lambda's GEMINI_MODEL). */
  geminiTestgenModel: string;
  /** Gemini model for transcribing answer photos (the Transcribe Lambda's GEMINI_MODEL). */
  geminiTranscribeModel: string;
  questionsTable: Table;
  answersTable: Table;
  bucket: Bucket;
  transcribeQueue: Queue;
  executeQueue: Queue;
  geminiApiKeySecret: Secret;
}

/** The grading pipeline's Lambdas: test generation and transcription. */
export class PipelineStack extends Stack {
  readonly testGenerationFunction: NodejsFunction;
  readonly transcribeFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    // Invoked asynchronously by the generate-tests route (and later by the record Lambda).
    // Gemini can take a while, so the timeout is long; nothing retries on its own because the
    // handler records its own failures.
    this.testGenerationFunction = createNodeFunction(this, 'TestGenerationFunction', {
      entry: serviceEntry('pipeline/src/handlers/generate-tests.ts'),
      description: 'Generates test material for a question with Gemini',
      timeout: Duration.minutes(5),
      memorySize: 512,
      retryAttempts: 0,
      environment: {
        [TABLE_ENV.Questions]: props.questionsTable.tableName,
        [BUCKET_ENV]: props.bucket.bucketName,
        [QUEUE_ENV.execute]: props.executeQueue.queueUrl,
        GEMINI_SECRET_NAME,
        GEMINI_MODEL: props.geminiTestgenModel,
      },
      bundling: {
        // The prompt is read at runtime from next to the bundle.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir, outputDir) => [
            `cp ${inputDir}/prompts/testgen.md ${outputDir}/testgen.md`,
          ],
        },
      },
    });

    // Exactly what the Lambda needs, and nothing else.
    props.geminiApiKeySecret.grantRead(this.testGenerationFunction);
    props.questionsTable.grantReadWriteData(this.testGenerationFunction);
    grantObjects(this.testGenerationFunction, props.bucket, 'readWrite', 'questions/*');
    props.executeQueue.grantSendMessages(this.testGenerationFunction);

    this.transcribeFunction = this.addTranscribe(props);
  }

  /**
   * Reads a photographed answer with Gemini and queues it for the worker. One message at a time
   * (batch size 1); it records its own failures, so a message is always deleted.
   */
  private addTranscribe(props: PipelineStackProps): NodejsFunction {
    const fn = createNodeFunction(this, 'TranscribeFunction', {
      entry: serviceEntry('pipeline/src/handlers/transcribe.ts'),
      description: 'Transcribes an answer photo with Gemini and queues it for the worker',
      timeout: Duration.seconds(120),
      memorySize: 512,
      environment: {
        [TABLE_ENV.Answers]: props.answersTable.tableName,
        [TABLE_ENV.Questions]: props.questionsTable.tableName,
        [BUCKET_ENV]: props.bucket.bucketName,
        [QUEUE_ENV.execute]: props.executeQueue.queueUrl,
        GEMINI_SECRET_NAME,
        GEMINI_MODEL: props.geminiTranscribeModel,
      },
      bundling: {
        // The prompt and the drivers guide are read at runtime from next to the bundle.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir, outputDir) => [
            `cp ${inputDir}/prompts/transcribe.md ${outputDir}/transcribe.md`,
            `cp ${inputDir}/worker/DRIVERS.md ${outputDir}/DRIVERS.md`,
          ],
        },
      },
    });

    // The transcribe queue triggers it: one message per invocation, never more than 5 at once.
    // That bounds Gemini traffic and leaves the rest of the account's Lambda concurrency (a quota
    // of 10 in total, which is too low to reserve any) to the API. This also grants receiving,
    // deleting and reading attributes of that queue, and nothing else on it.
    fn.addEventSource(
      new SqsEventSource(props.transcribeQueue, {
        batchSize: 1,
        maxConcurrency: TRANSCRIBE_MAX_CONCURRENCY,
      }),
    );

    // Exactly what it does, and nothing else.
    props.geminiApiKeySecret.grantRead(fn);
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [props.answersTable.tableArn],
      }),
    );
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [props.questionsTable.tableArn],
      }),
    );
    grantObjects(fn, props.bucket, 'read', 'answers/*');
    props.executeQueue.grantSendMessages(fn);
    return fn;
  }
}
