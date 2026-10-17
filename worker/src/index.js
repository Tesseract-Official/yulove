// The worker's entry point: `node src/index.js` polls the execute queue and runs jobs.
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createConsumer, consoleLog } from './consumer.js';
import { judge } from './judge.js';
import { prepareWorkRoot, SLOT_COUNT } from './sandbox.js';
import { runSetup } from './setup.js';

export const WORKER_NAME = 'execution-worker';

export { compareOutputs, COMPARE_MODES } from './compare.js';
export { judge } from './judge.js';
export { LANGUAGES, getLanguage } from './languages.js';
export { runSetup } from './setup.js';

/** min(CPU count, 8) jobs at once, one runner slot each; WORKER_CONCURRENCY overrides the CPU count. */
export function concurrencyFrom(env, cpus = availableParallelism()) {
  const wanted = env.WORKER_CONCURRENCY ? Number(env.WORKER_CONCURRENCY) : cpus;
  if (!Number.isInteger(wanted) || wanted < 1) {
    throw new Error(`WORKER_CONCURRENCY must be a positive integer, got ${env.WORKER_CONCURRENCY}`);
  }
  return Math.min(wanted, SLOT_COUNT);
}

export function configFrom(env, cpus) {
  const missing = ['EXECUTE_QUEUE_URL', 'RESULTS_QUEUE_URL', 'BUCKET_NAME'].filter(
    (name) => !env[name],
  );
  if (missing.length > 0) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  return {
    executeQueueUrl: env.EXECUTE_QUEUE_URL,
    resultsQueueUrl: env.RESULTS_QUEUE_URL,
    bucket: env.BUCKET_NAME,
    concurrency: concurrencyFrom(env, cpus),
  };
}

/**
 * SIGTERM and SIGINT stop polling and let the running jobs finish. A second signal gives up
 * waiting and exits at once.
 */
export function installSignalHandlers(consumer, proc = process, log = consoleLog) {
  let signalled = false;
  const onSignal = (signal) => {
    if (signalled) {
      log({ level: 'error', event: 'forced-exit', signal });
      proc.exit(1);
      return;
    }
    signalled = true;
    log({ level: 'info', event: 'signal', signal, inFlight: consumer.inFlight });
    consumer.stop();
  };
  proc.on('SIGTERM', onSignal);
  proc.on('SIGINT', onSignal);
}

export async function main(env = process.env, proc = process) {
  const config = configFrom(env);
  if (proc.getuid?.() !== 0)
    throw new Error('The worker must run as root so it can start jobs as runner users');
  await prepareWorkRoot();

  const consumer = createConsumer({
    sqs: new SQSClient({}),
    s3: new S3Client({}),
    config,
    runJudge: judge,
    runSetup,
  });
  installSignalHandlers(consumer, proc);
  await consumer.run();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (error) => {
      consoleLog({ level: 'error', event: 'fatal', error: String(error?.message ?? error) });
      process.exit(1);
    },
  );
}
