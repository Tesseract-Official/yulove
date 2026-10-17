import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { concurrencyFrom, configFrom, installSignalHandlers, WORKER_NAME } from './index.js';

describe('worker', () => {
  it('loads', () => {
    expect(WORKER_NAME).toBe('execution-worker');
  });
});

describe('concurrencyFrom', () => {
  it('is the number of CPUs, at most 8', () => {
    expect(concurrencyFrom({}, 2)).toBe(2);
    expect(concurrencyFrom({}, 8)).toBe(8);
    expect(concurrencyFrom({}, 24)).toBe(8);
    expect(concurrencyFrom({}, 1)).toBe(1);
  });

  it('can be set with WORKER_CONCURRENCY, still at most 8', () => {
    expect(concurrencyFrom({ WORKER_CONCURRENCY: '4' }, 24)).toBe(4);
    expect(concurrencyFrom({ WORKER_CONCURRENCY: '12' }, 24)).toBe(8);
  });

  it.each(['0', '-1', 'two', '1.5'])('rejects WORKER_CONCURRENCY=%s', (value) => {
    expect(() => concurrencyFrom({ WORKER_CONCURRENCY: value }, 4)).toThrow(/WORKER_CONCURRENCY/);
  });

  it('uses the machine’s CPU count when nothing is passed', () => {
    expect(concurrencyFrom({})).toBeGreaterThanOrEqual(1);
    expect(concurrencyFrom({})).toBeLessThanOrEqual(8);
  });
});

describe('configFrom', () => {
  const env = { EXECUTE_QUEUE_URL: 'e', RESULTS_QUEUE_URL: 'r', BUCKET_NAME: 'b' };

  it('reads the queues, the bucket and the concurrency', () => {
    expect(configFrom({ ...env, WORKER_CONCURRENCY: '4' }, 16)).toEqual({
      executeQueueUrl: 'e',
      resultsQueueUrl: 'r',
      bucket: 'b',
      concurrency: 4,
    });
  });

  it.each(['EXECUTE_QUEUE_URL', 'RESULTS_QUEUE_URL', 'BUCKET_NAME'])(
    'names the missing %s',
    (name) => {
      const incomplete = { ...env, [name]: undefined };
      expect(() => configFrom(incomplete, 4)).toThrow(new RegExp(name));
    },
  );
});

describe('installSignalHandlers', () => {
  function setup() {
    const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
    const consumer = { stop: vi.fn(), inFlight: 2 };
    const log = vi.fn();
    installSignalHandlers(consumer, proc, log);
    return { proc, consumer, log };
  }

  it.each(['SIGTERM', 'SIGINT'])('%s stops the consumer, which then drains', (signal) => {
    const { proc, consumer, log } = setup();
    proc.emit(signal, signal);

    expect(consumer.stop).toHaveBeenCalledTimes(1);
    expect(proc.exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'signal', signal, inFlight: 2 }),
    );
  });

  it('a second signal gives up waiting and exits', () => {
    const { proc, consumer } = setup();
    proc.emit('SIGTERM', 'SIGTERM');
    proc.emit('SIGTERM', 'SIGTERM');

    expect(consumer.stop).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(1);
  });
});
