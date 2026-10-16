import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Bucket } from 'aws-cdk-lib/aws-s3';
import type { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { BUCKET_ENV, QUEUE_ENV, TABLE_ENV } from '@yulove/shared';
import { createNodeFunction } from '../lib/node-function.js';
import type { TableName } from './data-stack.js';
import type { QueueName } from './queue-stack.js';

export type Access = 'read' | 'write' | 'readWrite';

/** What a route's Lambda may touch. Anything not listed is not granted. */
export interface RoutePermissions {
  tables?: Partial<Record<TableName, Access>>;
  queues?: Partial<Record<QueueName, 'send'>>;
  bucket?: Access;
}

/** Extras for a single route's Lambda. */
export interface RouteOptions {
  /** Plain (non-secret) environment variables, e.g. COLLEGE_DOMAIN. */
  environment?: Record<string, string>;
  timeout?: Duration;
  memorySize?: number;
}

export interface ApiStackProps extends StackProps {
  webOrigins: string[];
  userPool: UserPool;
  userPoolClient: UserPoolClient;
  tables: Record<TableName, Table>;
  queues: Record<QueueName, Queue>;
  bucket: Bucket;
}

export class ApiStack extends Stack {
  readonly httpApi: HttpApi;
  private readonly props: ApiStackProps;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    this.props = props;

    const authorizer = new HttpJwtAuthorizer(
      'CognitoJwtAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
      { jwtAudience: [props.userPoolClient.userPoolClientId] },
    );

    // Every route is behind the JWT authorizer. Role and batch checks happen in the handlers.
    this.httpApi = new HttpApi(this, 'HttpApi', {
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: props.webOrigins,
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
    });
  }

  /**
   * Adds an authorised route backed by a new Node.js 22 Lambda.
   * `permissions` become least-privilege IAM grants plus the matching env vars.
   */
  addRoute(
    method: HttpMethod,
    path: string,
    handlerEntry: string,
    permissions: RoutePermissions = {},
    options: RouteOptions = {},
  ): NodejsFunction {
    const id = `${method}${path}`.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const environment: Record<string, string> = { ...options.environment };
    const grants: Array<(fn: NodejsFunction) => void> = [];

    for (const [name, access] of Object.entries(permissions.tables ?? {}) as [
      TableName,
      Access,
    ][]) {
      const table = this.props.tables[name];
      environment[TABLE_ENV[name]] = table.tableName;
      grants.push((fn) => {
        if (access === 'read') table.grantReadData(fn);
        else if (access === 'write') table.grantWriteData(fn);
        else table.grantReadWriteData(fn);
      });
    }

    for (const name of Object.keys(permissions.queues ?? {}) as QueueName[]) {
      const queue = this.props.queues[name];
      environment[QUEUE_ENV[name]] = queue.queueUrl;
      grants.push((fn) => queue.grantSendMessages(fn));
    }

    if (permissions.bucket) {
      const { bucket } = this.props;
      const access = permissions.bucket;
      environment[BUCKET_ENV] = bucket.bucketName;
      grants.push((fn) => {
        if (access === 'read') bucket.grantRead(fn);
        else if (access === 'write') bucket.grantWrite(fn);
        else bucket.grantReadWrite(fn);
      });
    }

    const fn = createNodeFunction(this, `${id}-fn`, {
      entry: handlerEntry,
      environment,
      description: `${method} ${path}`,
      ...(options.timeout ? { timeout: options.timeout } : {}),
      ...(options.memorySize ? { memorySize: options.memorySize } : {}),
    });
    for (const grant of grants) grant(fn);

    this.httpApi.addRoutes({
      path,
      methods: [method],
      integration: new HttpLambdaIntegration(`${id}-integration`, fn),
    });
    return fn;
  }
}
