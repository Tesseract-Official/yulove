import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { readConfig } from './config.js';
import { ApiStack } from './stacks/api-stack.js';
import { AuthStack } from './stacks/auth-stack.js';
import { DataStack } from './stacks/data-stack.js';
import { QueueStack } from './stacks/queue-stack.js';

export const TEST_CONTEXT = {
  collegeDomain: 'college.edu',
  webOrigin: 'https://app.college.edu',
};

/** Builds all four stacks the way app.ts does, without running esbuild. */
export function buildApp(context: Record<string, string> = TEST_CONTEXT) {
  const app = new App({ context: { ...context, 'aws:cdk:bundling-stacks': [] } });
  const { collegeDomain, webOrigins } = readConfig(app.node);
  const env = { account: '123456789012', region: 'ap-south-1' };

  const data = new DataStack(app, 'Data', { env, webOrigins });
  const auth = new AuthStack(app, 'Auth', {
    env,
    collegeDomain,
    webOrigins,
    usersTable: data.tables.Users,
  });
  const queues = new QueueStack(app, 'Queues', { env });
  const api = new ApiStack(app, 'Api', {
    env,
    webOrigins,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    tables: data.tables,
    queues: queues.queues,
    bucket: data.bucket,
  });

  return {
    app,
    data,
    auth,
    queues,
    api,
    // Lazy: synthesising freezes a stack, so routes must be added before the first access.
    templates: {
      get data() {
        return Template.fromStack(data);
      },
      get auth() {
        return Template.fromStack(auth);
      },
      get queues() {
        return Template.fromStack(queues);
      },
      get api() {
        return Template.fromStack(api);
      },
    },
  };
}
