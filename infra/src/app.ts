import { existsSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { readConfig, REGION } from './config.js';
import { WEB_DIST_DIR } from './lib/handler-paths.js';
import { registerRoutes } from './routes.js';
import { ApiStack } from './stacks/api-stack.js';
import { AuthStack } from './stacks/auth-stack.js';
import { BudgetStack } from './stacks/budget-stack.js';
import { DataStack } from './stacks/data-stack.js';
import { PipelineStack } from './stacks/pipeline-stack.js';
import { QueueStack } from './stacks/queue-stack.js';
import { WebDeployStack } from './stacks/web-deploy-stack.js';
import { WebHostingStack } from './stacks/web-hosting-stack.js';
import { WorkerStack } from './stacks/worker-stack.js';

const app = new App();
const {
  collegeDomain,
  webOrigins: devOrigins,
  geminiTestgenModel,
  geminiTranscribeModel,
  budgetEmail,
  superAdminEmails,
} = readConfig(app.node);
const env = { account: process.env['CDK_DEFAULT_ACCOUNT'], region: REGION };

// The CloudFront site depends on nothing, so the stacks that need its URL can take it without a
// cycle. The localhost origins from cdk.json stay for local development.
const hosting = new WebHostingStack(app, 'DsaJudgeWebHosting', { env });
const webOrigins = [...devOrigins, hosting.siteUrl];

const data = new DataStack(app, 'DsaJudgeData', { env, webOrigins });

const auth = new AuthStack(app, 'DsaJudgeAuth', {
  env,
  collegeDomain,
  superAdminEmails,
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
  geminiTranscribeModel,
  questionsTable: data.tables.Questions,
  answersTable: data.tables.Answers,
  examsTable: data.tables.Exams,
  examStudentsTable: data.tables.ExamStudents,
  bucket: data.bucket,
  transcribeQueue: queues.queues.transcribe,
  executeQueue: queues.queues.execute,
  resultsQueue: queues.queues.results,
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

// Uploads web/dist, so the web app has to be built before `cdk synth` or `cdk deploy`.
if (!existsSync(WEB_DIST_DIR)) {
  throw new Error(
    `The web app is not built (${WEB_DIST_DIR} is missing). Run: pnpm --filter @yulove/web build`,
  );
}
new WebDeployStack(app, 'DsaJudgeWebDeploy', {
  env,
  hosting,
  userPoolClient: auth.userPoolClient,
  userPoolDomain: auth.userPoolDomain,
  httpApi: api.httpApi,
});
