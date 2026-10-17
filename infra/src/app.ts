import { App } from 'aws-cdk-lib';
import { readConfig, REGION } from './config.js';
import { registerRoutes } from './routes.js';
import { ApiStack } from './stacks/api-stack.js';
import { AuthStack } from './stacks/auth-stack.js';
import { BudgetStack } from './stacks/budget-stack.js';
import { DataStack } from './stacks/data-stack.js';
import { PipelineStack } from './stacks/pipeline-stack.js';
import { QueueStack } from './stacks/queue-stack.js';
import { WorkerStack } from './stacks/worker-stack.js';

const app = new App();
const { collegeDomain, webOrigins, geminiTestgenModel, budgetEmail } = readConfig(app.node);
const env = { account: process.env['CDK_DEFAULT_ACCOUNT'], region: REGION };

const data = new DataStack(app, 'DsaJudgeData', { env, webOrigins });

const auth = new AuthStack(app, 'DsaJudgeAuth', {
  env,
  collegeDomain,
  webOrigins,
  usersTable: data.tables.Users,
});

const queues = new QueueStack(app, 'DsaJudgeQueues', { env });

new BudgetStack(app, 'DsaJudgeBudget', { env, budgetEmail });

new WorkerStack(app, 'DsaJudgeWorker', {
  env,
  executeQueue: queues.queues.execute,
  resultsQueue: queues.queues.results,
  bucket: data.bucket,
});

const pipeline = new PipelineStack(app, 'DsaJudgePipeline', {
  env,
  geminiTestgenModel,
  questionsTable: data.tables.Questions,
  bucket: data.bucket,
  executeQueue: queues.queues.execute,
  geminiApiKeySecret: data.geminiApiKeySecret,
});

const api = new ApiStack(app, 'DsaJudgeApi', {
  env,
  webOrigins,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  tables: data.tables,
  queues: queues.queues,
  bucket: data.bucket,
  functions: { testGeneration: pipeline.testGenerationFunction },
});

registerRoutes(api, { collegeDomain });
