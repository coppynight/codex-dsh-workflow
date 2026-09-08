// aggregate.mjs — summarize normalized job records.
// Pure, dependency-free. Exposes summarizeJobs(jobs).

/**
 * Summarize normalized job records (as produced by parseJobs).
 * Never mutates the input array or its objects.
 *
 * @param {Array<{id: string, durationMs: number, status: string}>} jobs
 * @returns {{total: number, succeeded: number, failed: number, skipped: number,
 *            durationMs: number, medianSuccessMs: number, slowest: Array}}
 */
export function summarizeJobs(jobs) {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let durationMs = 0;

  const successDurations = [];
  const ranked = [];

  for (const job of jobs) {
    if (job.status === 'succeeded') {
      succeeded += 1;
      successDurations.push(job.durationMs);
      durationMs += job.durationMs;
      ranked.push(job);
    } else if (job.status === 'failed') {
      failed += 1;
      durationMs += job.durationMs;
      ranked.push(job);
    } else if (job.status === 'skipped') {
      skipped += 1;
    }
  }

  // Median of succeeded durations only. Sort a scratch copy, never the input.
  successDurations.sort((a, b) => a - b);
  let medianSuccessMs = 0;
  const count = successDurations.length;
  if (count > 0) {
    const middle = count >> 1;
    if (count % 2 === 1) {
      medianSuccessMs = successDurations[middle];
    } else {
      // Arithmetic mean of the middle pair without overflowing the addition
      // of two finite doubles (each half is at most MAX_VALUE / 2).
      medianSuccessMs =
        successDurations[middle - 1] / 2 + successDurations[middle] / 2;
    }
  }

  // Top three non-skipped jobs: duration descending, ASCII id ascending on
  // ties. Return fresh copies so callers can never corrupt the inputs.
  const slowest = ranked
    .map((job) => ({ id: job.id, durationMs: job.durationMs, status: job.status }))
    .sort(
      (x, y) =>
        y.durationMs - x.durationMs || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    )
    .slice(0, 3);

  return {
    total: jobs.length,
    succeeded,
    failed,
    skipped,
    durationMs,
    medianSuccessMs,
    slowest,
  };
}
