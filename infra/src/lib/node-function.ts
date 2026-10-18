import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { NodejsFunction, type NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import { REPO_LOCK_FILE } from './handler-paths.js';

export type NodeFunctionProps = Omit<
  NodejsFunctionProps,
  'runtime' | 'depsLockFilePath' | 'logGroup' | 'logRetention'
> & {
  entry: string;
};

/** How long every log group in the app keeps its logs. */
export const LOG_RETENTION = RetentionDays.ONE_MONTH;

/**
 * The only way this app creates Lambdas: Node.js 22, bundled with esbuild, writing to a log group
 * of its own that keeps logs for 30 days. (A function without a log group gets one made by Lambda
 * that never expires, and `logRetention` would add a custom-resource Lambda per stack.)
 */
export function createNodeFunction(
  scope: Construct,
  id: string,
  props: NodeFunctionProps,
): NodejsFunction {
  return new NodejsFunction(scope, id, {
    timeout: Duration.seconds(30),
    memorySize: 256,
    logGroup: new LogGroup(scope, `${id}-logs`, {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.RETAIN,
    }),
    ...props,
    runtime: Runtime.NODEJS_22_X,
    depsLockFilePath: REPO_LOCK_FILE,
    bundling: {
      target: 'node22',
      sourceMap: true,
      ...props.bundling,
    },
  });
}
