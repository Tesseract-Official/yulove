import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { readConfig } from './config.js';
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

export const TEST_CONTEXT = {
  collegeDomain: 'college.edu',
  webOrigin: 'https://app.college.edu',
  geminiTestgenModel: 'gemini-testgen-test-model',
  geminiTranscribeModel: 'gemini-transcribe-test-model',
  budgetEmail: 'alerts@college.edu',
  superAdminEmails: ['founder@gmail.com', 'cofounder@gmail.com'],
};

/** Builds the stacks the way app.ts does, without running esbuild. */
export function buildApp(
  context: Record<string, string | string[]> = TEST_CONTEXT,
  options: { routes?: boolean; worker?: boolean; budget?: boolean; webDeploy?: boolean } = {},
) {
  const app = new App({ context: { ...context, 'aws:cdk:bundling-stacks': [] } });
  const {
    collegeDomain,
    webOrigins: devOrigins,
    geminiTestgenModel,
    geminiTranscribeModel,
    budgetEmail,
    superAdminEmails,
  } = readConfig(app.node);
  const env = { account: '123456789012', region: 'ap-south-1' };

  const hosting = new WebHostingStack(app, 'WebHosting', { env });
  const webOrigins = [...devOrigins, hosting.siteUrl];

  const data = new DataStack(app, 'Data', { env, webOrigins });
  const auth = new AuthStack(app, 'Auth', {
    env,
    collegeDomain,
    superAdminEmails,
    webOrigins,
    usersTable: data.tables.Users,
  });
  const queues = new QueueStack(app, 'Queues', { env });
  const pipeline = new PipelineStack(app, 'Pipeline', {
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
  const api = new ApiStack(app, 'Api', {
    env,
    webOrigins,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    tables: data.tables,
    queues: queues.queues,
    bucket: data.bucket,
    functions: { testGeneration: pipeline.testGenerationFunction },
  });

  if (options.routes) registerRoutes(api, { collegeDomain });

  const budget = options.budget ? new BudgetStack(app, 'Budget', { env, budgetEmail }) : undefined;

  // Synthesising the worker stages its Docker build context, so tests ask for it explicitly.
  const worker = options.worker
    ? new WorkerStack(app, 'Worker', {
        env,
        executeQueue: queues.queues.execute,
        resultsQueue: queues.queues.results,
        bucket: data.bucket,
      })
    : undefined;

  // The deploy stack uploads a folder, so it gets a stand-in for web/dist.
  let webDeploy: WebDeployStack | undefined;
  if (options.webDeploy) {
    const dist = mkdtempSync(join(tmpdir(), 'web-dist-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>test</title>');
    webDeploy = new WebDeployStack(app, 'WebDeploy', {
      env,
      hosting,
      userPoolClient: auth.userPoolClient,
      userPoolDomain: auth.userPoolDomain,
      httpApi: api.httpApi,
      webDistPath: dist,
    });
  }

  return {
    app,
    hosting,
    webDeploy,
    data,
    auth,
    queues,
    pipeline,
    worker,
    budget,
    api,
    // Kept out of `templates`: its deployment helper Lambdas are CDK's own, not Node.js 22 code.
    webDeployTemplate: () => {
      if (!webDeploy) throw new Error('Build the app with { webDeploy: true } first');
      return Template.fromStack(webDeploy);
    },
    // Lazy: synthesising freezes a stack, so routes must be added before the first access.
    templates: {
      get hosting() {
        return Template.fromStack(hosting);
      },
      get data() {
        return Template.fromStack(data);
      },
      get auth() {
        return Template.fromStack(auth);
      },
      get queues() {
        return Template.fromStack(queues);
      },
      get pipeline() {
        return Template.fromStack(pipeline);
      },
      get api() {
        return Template.fromStack(api);
      },
    },
  };
}
