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
import { WorkerStack } from './stacks/worker-stack.js';

export const TEST_CONTEXT = {
  collegeDomain: 'college.edu',
  webOrigin: 'https://app.college.edu',
  geminiTestgenModel: 'gemini-testgen-test-model',
  geminiTranscribeModel: 'gemini-transcribe-test-model',
  budgetEmail: 'alerts@college.edu',
};

/** Builds all four stacks the way app.ts does, without running esbuild. */
export function buildApp(
  context: Record<string, string> = TEST_CONTEXT,
  options: { routes?: boolean; worker?: boolean; budget?: boolean } = {},
) {
  const app = new App({ context: { ...context, 'aws:cdk:bundling-stacks': [] } });
  const { collegeDomain, webOrigins, geminiTestgenModel, budgetEmail } = readConfig(app.node);
  const env = { account: '123456789012', region: 'ap-south-1' };

  const data = new DataStack(app, 'Data', { env, webOrigins });
  const auth = new AuthStack(app, 'Auth', {
    env,
    collegeDomain,
    webOrigins,
    usersTable: data.tables.Users,
  });
  const queues = new QueueStack(app, 'Queues', { env });
  const pipeline = new PipelineStack(app, 'Pipeline', {
    env,
    geminiTestgenModel,
    questionsTable: data.tables.Questions,
    bucket: data.bucket,
    executeQueue: queues.queues.execute,
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

  return {
    app,
    data,
    auth,
    queues,
    pipeline,
    worker,
    budget,
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
      get pipeline() {
        return Template.fromStack(pipeline);
      },
      get api() {
        return Template.fromStack(api);
      },
    },
  };
}
