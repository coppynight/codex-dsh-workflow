/**
 * Summarize normalized valid job records.
 * Does not mutate the input array or its objects.
 * @param {Array<{id:string,durationMs:number,status:string}>} jobs
 * @returns {{total:number,succeeded:number,failed:number,skipped:number,durationMs:number,medianSuccessMs:number,slowest:Array<object>}}
 */
export function summarizeJobs(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  let total = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let durationMs = 0;
  const successDurations = [];

  for (const job of list) {
    total += 1;
    if (job.status === 'succeeded') {
      succeeded += 1;
      durationMs += job.durationMs;
      successDurations.push(job.durationMs);
    } else if (job.status === 'failed') {
      failed += 1;
      durationMs += job.durationMs;
    } else {
      skipped += 1;
    }
  }

  // Median of succeeded durations only.
  let medianSuccessMs = 0;
  if (successDurations.length > 0) {
    const sorted = successDurations.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const mid = Math.floor(n / 2);
    if (n % 2 === 1) {
      medianSuccessMs = sorted[mid];
    } else {
      // (a + b) / 2 expressed as halves avoids intermediate overflow.
      medianSuccessMs = sorted[mid - 1] / 2 + sorted[mid] / 2;
    }
  }

  // Slowest three non-skipped jobs, descending duration, ties by ASCII id.
  const nonSkipped = [];
  for (const job of list) {
    if (job.status !== 'skipped') nonSkipped.push(job);
  }
  const slowest = nonSkipped
    .map((j) => ({ ...j }))
    .sort((a, b) => {
      if (a.durationMs !== b.durationMs) return b.durationMs - a.durationMs;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, 3);

  return { total, succeeded, failed, skipped, durationMs, medianSuccessMs, slowest };
}
