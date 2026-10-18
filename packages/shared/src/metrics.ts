/**
 * CloudWatch embedded metric format (EMF): a Lambda that prints one of these JSON lines to its log
 * makes CloudWatch record a custom metric, with no API call and no extra permission. Browser-safe.
 */
export const METRIC_NAMESPACE = 'DsaJudge';

/** One count each time an answer ends as FAILED_TO_GRADE. The alarm sums it per hour. */
export const FAILED_TO_GRADE_METRIC = 'FailedToGrade';

/**
 * The EMF line for one answer that could not be graded. There are no dimensions, so there is one
 * metric to alarm on; the reason is an ordinary log field you can search for, not a dimension.
 */
export function failedToGradeLine(reason: string, now: number = Date.now()): string {
  return JSON.stringify({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [[]],
          Metrics: [{ Name: FAILED_TO_GRADE_METRIC, Unit: 'Count' }],
        },
      ],
    },
    [FAILED_TO_GRADE_METRIC]: 1,
    reason,
  });
}

/** Prints the line for one failed answer. */
export function emitFailedToGrade(reason: string): void {
  console.log(failedToGradeLine(reason));
}
