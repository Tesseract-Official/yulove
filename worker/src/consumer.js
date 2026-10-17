// Polls the execute queue and runs jobs, one runner slot per job. The consumer never throws and
// never leaves a message to be retried because of a bug in a job: every failure becomes a failed
// ResultMsg and the message is deleted. The one exception is a result that cannot be sent at all;
// then the execute message stays, so the job is retried instead of silently lost.
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { failedResult, parseExecuteMsg, resultDeduplicationId } from './contract.js';
import { handleAnswer, handleSetup, JobError } from './jobs.js';

const MAX_RECEIVE = 10; // SQS allows at most 10 messages per receive

export const DEFAULTS = Object.freeze({
  waitSeconds: 20, // long polling
  visibilitySeconds: 600, // the execute queue's visibility timeout (10 minutes)
  heartbeatMs: 120_000, // extend the visibility of running jobs this often
  receiveBackoffMs: 5_000, // pause after a failed receive
  releaseWaitMs: 1_000, // on stop, wait this long for a cancelled poll to hand back its messages
});

/** One structured JSON line per event, on stdout (CloudWatch picks it up). */
export function consoleLog(entry) {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * @param {object} options
 * @param {object} options.sqs         an SQS client (only .send is used)
 * @param {object} options.s3          an S3 client
 * @param {{executeQueueUrl:string, resultsQueueUrl:string, bucket:string, concurrency:number}} options.config
 * @param {Function} options.runJudge  judge(job) from judge.js
 * @param {Function} options.runSetup  runSetup(job) from setup.js
 * @param {Function} [options.log]
 */
export function createConsumer({
  sqs,
  s3,
  config,
  runJudge,
  runSetup,
  log = consoleLog,
  ...overrides
}) {
  const settings = { ...DEFAULTS, ...overrides };
  const { executeQueueUrl, resultsQueueUrl, bucket } = config;
  const concurrency = Math.max(1, config.concurrency);

  const freeSlots = Array.from({ length: concurrency }, (_, i) => i + 1);
  const inFlight = new Set();
  const pendingReleases = new Set();
  const stopController = new AbortController();
  let stopping = false;

  /** A receive that can be cancelled even when the client ignores the abort signal. */
  function abortable(promise) {
    const { signal } = stopController;
    let remove = () => {};
    const aborted = new Promise((_, reject) => {
      const abort = () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      remove = () => signal.removeEventListener('abort', abort);
      return undefined;
    });
    return Promise.race([promise, aborted]).finally(() => remove());
  }

  async function release(message) {
    try {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: executeQueueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    } catch (error) {
      log({ level: 'error', event: 'release-failed', error: String(error?.message ?? error) });
    }
  }

  async function extendVisibility(message) {
    try {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: executeQueueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: settings.visibilitySeconds,
        }),
      );
    } catch (error) {
      log({ level: 'error', event: 'heartbeat-failed', error: String(error?.message ?? error) });
    }
  }

  /** Runs one job and returns { result, summary }. Throws only on a bug or an infrastructure error. */
  async function runJob(msg, slot) {
    return msg.type === 'ANSWER'
      ? handleAnswer(msg, { s3, bucket, runJudge, slot })
      : handleSetup(msg, { s3, bucket, runSetup, slot });
  }

  async function processMessage(message, slot) {
    const started = Date.now();
    const attributes = message.Attributes ?? {};
    const heartbeat = setInterval(() => extendVisibility(message), settings.heartbeatMs);
    heartbeat.unref?.();

    const entry = {
      event: 'job',
      slot,
      receiveCount: Number(attributes.ApproximateReceiveCount ?? 1),
    };

    try {
      const parsed = parseExecuteMsg(message.Body);
      let type;
      let ref;
      let result;
      let summary;

      if (!parsed.ok) {
        if (!parsed.partial) {
          // We cannot even tell whose job this was, so there is nobody to tell. Drop it.
          log({ level: 'error', event: 'unreadable-message', error: parsed.error });
          await deleteMessage(message);
          return;
        }
        ({ type, ref } = parsed.partial);
        result = failedResult(type, ref, parsed.code, parsed.error);
        summary = { failReason: parsed.code, detail: parsed.error };
      } else {
        type = parsed.msg.type;
        ref = parsed.msg;
        try {
          ({ result, summary } = await runJob(parsed.msg, slot));
        } catch (error) {
          const code = error instanceof JobError ? error.code : 'WORKER_ERROR';
          const detail =
            error instanceof JobError
              ? error.message
              : `${error?.name ?? 'Error'}: ${String(error?.message ?? error)}`;
          result = failedResult(type, ref, code, detail);
          summary = { failReason: code, detail };
          log({ level: 'error', event: 'job-error', type, error: detail });
        }
      }

      Object.assign(entry, describeKeys(type, ref), { type, attempt: ref.attempt });
      Object.assign(entry, { outcome: result.outcome, summary });

      await sendResult(message, result);
      await deleteMessage(message);
    } catch (error) {
      // The result could not be sent (or the delete failed). Leave the message: it will be retried.
      entry.leftForRetry = true;
      log({
        level: 'error',
        event: 'message-left-for-retry',
        error: String(error?.message ?? error),
      });
    } finally {
      clearInterval(heartbeat);
      entry.durationMs = Date.now() - started;
      if (entry.type) log({ level: 'info', ...entry });
    }
  }

  async function sendResult(message, result) {
    const attributes = message.Attributes ?? {};
    const groupId = attributes.MessageGroupId;
    const dedupId = attributes.MessageDeduplicationId;
    if (!groupId || !dedupId) throw new Error('The message has no group or deduplication id');
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: resultsQueueUrl,
        MessageBody: JSON.stringify(result),
        MessageGroupId: groupId,
        MessageDeduplicationId: resultDeduplicationId(dedupId),
      }),
    );
  }

  async function deleteMessage(message) {
    await sqs.send(
      new DeleteMessageCommand({ QueueUrl: executeQueueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  function start(message) {
    const slot = freeSlots.shift();
    const job = processMessage(message, slot).finally(() => {
      freeSlots.push(slot);
      freeSlots.sort((a, b) => a - b);
      inFlight.delete(job);
    });
    inFlight.add(job);
  }

  async function run() {
    log({ level: 'info', event: 'started', concurrency, executeQueueUrl });

    while (!stopping) {
      if (freeSlots.length === 0) {
        await Promise.race(inFlight);
        continue;
      }

      let response;
      const receive = sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: executeQueueUrl,
          MaxNumberOfMessages: Math.min(MAX_RECEIVE, freeSlots.length),
          WaitTimeSeconds: settings.waitSeconds,
          MessageSystemAttributeNames: [
            'MessageGroupId',
            'MessageDeduplicationId',
            'ApproximateReceiveCount',
          ],
        }),
        { abortSignal: stopController.signal },
      );
      try {
        response = await abortable(receive);
      } catch (error) {
        if (stopping) {
          // The poll was cut short. If SQS had already handed us messages, give them back.
          const giveBack = receive
            .then((late) => Promise.all((late?.Messages ?? []).map(release)))
            .catch(() => {})
            .finally(() => pendingReleases.delete(giveBack));
          pendingReleases.add(giveBack);
          break;
        }
        log({ level: 'error', event: 'receive-failed', error: String(error?.message ?? error) });
        await sleep(settings.receiveBackoffMs, stopController.signal);
        continue;
      }

      const messages = response.Messages ?? [];
      if (stopping) {
        // Stopped while the receive was finishing: give the messages straight back.
        await Promise.all(messages.map(release));
        break;
      }
      for (const message of messages) start(message);
    }

    log({ level: 'info', event: 'draining', inFlight: inFlight.size });
    await Promise.allSettled([...inFlight]);
    // A cancelled poll normally settles at once; do not wait forever for one that does not.
    await Promise.race([Promise.allSettled([...pendingReleases]), sleep(settings.releaseWaitMs)]);
    log({ level: 'info', event: 'stopped' });
  }

  /** Stop polling; run() resolves once the running jobs have finished. */
  function stop() {
    if (stopping) return;
    stopping = true;
    stopController.abort();
  }

  return {
    run,
    stop,
    get inFlight() {
      return inFlight.size;
    },
  };
}

/** The identifying fields of a job for the log line. */
function describeKeys(type, ref) {
  return type === 'ANSWER'
    ? { examId: ref.examId, studentEmail: ref.studentEmail, questionNumber: ref.questionNumber }
    : { questionId: ref.questionId, version: ref.version };
}
