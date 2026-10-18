import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appErrorLine,
  APP_ERROR_METRIC,
  emitAppError,
  emitFailedToGrade,
  failedToGradeLine,
  FAILED_TO_GRADE_METRIC,
  METRIC_NAMESPACE,
} from './metrics.js';

describe('failedToGradeLine', () => {
  it('is one JSON line in CloudWatch embedded metric format with no dimensions', () => {
    const line = failedToGradeLine('GEMINI_ERROR', 1_700_000_000_000);

    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      _aws: {
        Timestamp: 1_700_000_000_000,
        CloudWatchMetrics: [
          {
            Namespace: 'DsaJudge',
            Dimensions: [[]],
            Metrics: [{ Name: 'FailedToGrade', Unit: 'Count' }],
          },
        ],
      },
      FailedToGrade: 1,
      reason: 'GEMINI_ERROR',
    });
  });

  it('names the metric the alarm reads', () => {
    expect(METRIC_NAMESPACE).toBe('DsaJudge');
    expect(FAILED_TO_GRADE_METRIC).toBe('FailedToGrade');
  });
});

describe('emitFailedToGrade', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints the line once', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    emitFailedToGrade('UNREADABLE');
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ reason: 'UNREADABLE' });
  });
});

describe('appErrorLine', () => {
  it('is one EMF line counting an AppError in the DsaJudge namespace, with no dimensions', () => {
    const line = appErrorLine('api GET /me', 1_700_000_000_000);

    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      _aws: {
        Timestamp: 1_700_000_000_000,
        CloudWatchMetrics: [
          {
            Namespace: 'DsaJudge',
            Dimensions: [[]],
            Metrics: [{ Name: 'AppError', Unit: 'Count' }],
          },
        ],
      },
      AppError: 1,
      source: 'api GET /me',
    });
    expect(APP_ERROR_METRIC).toBe('AppError');
  });

  it('is printed once by emitAppError', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    emitAppError('record');
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      AppError: 1,
      source: 'record',
    });
    log.mockRestore();
  });
});
