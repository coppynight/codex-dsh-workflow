/**
 * Summarize normalized job records without mutating the input.
 * @param {Array<{id: string, durationMs: number, status: string}>} jobs
 * @returns {{total: number, succeeded: number, failed: number, skipped: number, durationMs: number, medianSuccessMs: number, slowest: Array<{id: string, durationMs: number, status: string}>}}
 */
export function summarizeJobs(jobs) {
  let total = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let durationMs = 0;
  const successDurations = [];

  for (const job of jobs) {
    total++;
    if (job.status === 'succeeded') {
      succeeded++;
      durationMs += job.durationMs;
      successDurations.push(job.durationMs);
    } else if (job.status === 'failed') {
      failed++;
      durationMs += job.durationMs;
    } else {
      skipped++;
    }
  }

  // Median over succeeded durations only; arithmetic mean of the middle pair
  // for an even count, computed as a/2 + b/2 to avoid intermediate overflow.
  let medianSuccessMs = 0;
  if (successDurations.length > 0) {
    const sorted = [...successDurations].sort((a, b) => a - b);
    const n = sorted.length;
    const mid = n >> 1;
    if (n % 2 === 1) {
      medianSuccessMs = sorted[mid];
    } else {
      medianSuccessMs = sorted[mid - 1] / 2 + sorted[mid] / 2;
    }
  }

  // Top three non-skipped jobs: duration descending, ties by ASCII id ascending.
  // Work on fresh copies; never mutate the input array or its objects.
  const slowest = jobs
    .filter((job) => job.status !== 'skipped')
    .map((job) => ({ ...job }))
    .sort((a, b) => b.durationMs - a.durationMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 3);

  return {
    total,
    succeeded,
    failed,
    skipped,
    durationMs,
    medianSuccessMs,
    slowest,
  };
}
