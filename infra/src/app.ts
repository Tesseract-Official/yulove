import { App } from 'aws-cdk-lib';
import { readConfig, REGION } from './config.js';
import { ApiStack } from './stacks/api-stack.js';
import { AuthStack } from './stacks/auth-stack.js';
import { DataStack } from './stacks/data-stack.js';
import { QueueStack } from './stacks/queue-stack.js';

const app = new App();
const { collegeDomain, webOrigins } = readConfig(app.node);
const env = { account: process.env['CDK_DEFAULT_ACCOUNT'], region: REGION };

const data = new DataStack(app, 'DsaJudgeData', { env, webOrigins });

const auth = new AuthStack(app, 'DsaJudgeAuth', {
  env,
  collegeDomain,
  webOrigins,
  usersTable: data.tables.Users,
});

const queues = new QueueStack(app, 'DsaJudgeQueues', { env });

new ApiStack(app, 'DsaJudgeApi', {
  env,
  webOrigins,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  tables: data.tables,
  queues: queues.queues,
  bucket: data.bucket,
});
