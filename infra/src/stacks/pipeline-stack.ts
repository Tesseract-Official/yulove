import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
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

export interface PipelineStackProps extends StackProps {
  geminiModel: string;
  questionsTable: Table;
  bucket: Bucket;
  executeQueue: Queue;
  geminiApiKeySecret: Secret;
}

/** The grading pipeline's Lambdas. For now: test generation. */
export class PipelineStack extends Stack {
  readonly testGenerationFunction: NodejsFunction;

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
        GEMINI_MODEL: props.geminiModel,
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
  }
}
