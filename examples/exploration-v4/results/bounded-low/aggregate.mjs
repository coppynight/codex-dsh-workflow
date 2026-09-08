/**
 * Summarize normalized valid job records.
 * Returns { total, succeeded, failed, skipped, durationMs,
 *           medianSuccessMs, slowest }.
 */
export function summarizeJobs(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let durationMs = 0;
  const successDurations = [];

  for (const job of list) {
    switch (job.status) {
      case 'succeeded':
        succeeded++;
        successDurations.push(job.durationMs);
        durationMs += job.durationMs;
        break;
      case 'failed':
        failed++;
        durationMs += job.durationMs;
        break;
      default:
        skipped++;
        break;
    }
  }

  const medianSuccessMs = median(successDurations);

  // Top three non-skipped jobs, sorted duration descending then ASCII id ascending.
  // Sort copies; never mutate inputs.
  const slowest = list
    .filter((j) => j.status !== 'skipped')
    .map((j) => ({ id: j.id, durationMs: j.durationMs, status: j.status }))
    .sort((a, b) => {
      if (b.durationMs !== a.durationMs) return b.durationMs - a.durationMs;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, 3);

  return {
    total: list.length,
    succeeded,
    failed,
    skipped,
    durationMs,
    medianSuccessMs,
    slowest,
  };
}

function median(sortedOrRaw) {
  if (sortedOrRaw.length === 0) return 0;
  const sorted = sortedOrRaw.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  if (n % 2 === 1) return sorted[mid];
  // Arithmetic mean of the middle pair without overflowing the addition
  // of two finite durations.
  const low = sorted[mid - 1];
  const high = sorted[mid];
  return low + (high - low) / 2;
}
