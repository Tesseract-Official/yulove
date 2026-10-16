import { Duration } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, type NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import { REPO_LOCK_FILE } from './handler-paths.js';

export type NodeFunctionProps = Omit<NodejsFunctionProps, 'runtime' | 'depsLockFilePath'> & {
  entry: string;
};

/** The only way this app creates Lambdas: Node.js 22, bundled with esbuild. */
export function createNodeFunction(
  scope: Construct,
  id: string,
  props: NodeFunctionProps,
): NodejsFunction {
  return new NodejsFunction(scope, id, {
    timeout: Duration.seconds(30),
    memorySize: 256,
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
