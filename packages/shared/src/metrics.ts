/**
 * CloudWatch embedded metric format (EMF): a Lambda that prints one of these JSON lines to its log
 * makes CloudWatch record a custom metric, with no API call and no extra permission. Browser-safe.
 */
export const METRIC_NAMESPACE = 'DsaJudge';

/** One count each time an answer ends as FAILED_TO_GRADE. The alarm sums it per hour. */
export const FAILED_TO_GRADE_METRIC = 'FailedToGrade';

/** One count each time the app itself fails unexpectedly. The alarm sums it over 5 minutes. */
export const APP_ERROR_METRIC = 'AppError';

/** One EMF line: a count of 1 for `metric`, no dimensions, and `fields` as plain log properties. */
function metricLine(metric: string, fields: Record<string, string>, now: number): string {
  return JSON.stringify({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [[]],
          Metrics: [{ Name: metric, Unit: 'Count' }],
        },
      ],
    },
    [metric]: 1,
    ...fields,
  });
}

/**
 * The EMF line for one answer that could not be graded. There are no dimensions, so there is one
 * metric to alarm on; the reason is an ordinary log field you can search for, not a dimension.
 */
export function failedToGradeLine(reason: string, now: number = Date.now()): string {
  return metricLine(FAILED_TO_GRADE_METRIC, { reason }, now);
}

/** Prints the line for one failed answer. */
export function emitFailedToGrade(reason: string): void {
  console.log(failedToGradeLine(reason));
}

/**
 * The EMF line for one unexpected failure of the app: a 5xx from the API, or an error a pipeline
 * Lambda caught that it did not plan for. `source` says where (a route, or a Lambda's name) and is
 * a plain log field, not a dimension. It is deliberately not used for handled outcomes such as
 * FAILED_TO_GRADE, or for the redelivery a Lambda asks for when Gemini is busy.
 */
export function appErrorLine(source: string, now: number = Date.now()): string {
  return metricLine(APP_ERROR_METRIC, { source }, now);
}

/** Prints the line for one unexpected failure. */
export function emitAppError(source: string): void {
  console.log(appErrorLine(source));
}
