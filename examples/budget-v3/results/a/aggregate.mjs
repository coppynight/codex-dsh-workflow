export function summarizeJobs(jobs) {
  const summary = {
    total: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    medianSuccessMs: 0,
    slowest: []
  };
  const successDurations = [];
  const candidates = [];

  for (const job of jobs) {
    summary.total++;
    summary[job.status]++;
    if (job.status === 'succeeded') {
      successDurations.push(job.durationMs);
    }
    if (job.status !== 'skipped') {
      summary.durationMs += job.durationMs;
      candidates.push({
        id: job.id,
        durationMs: job.durationMs,
        status: job.status
      });
    }
  }

  successDurations.sort((a, b) => a - b);
  const count = successDurations.length;
  if (count > 0) {
    const middle = Math.floor(count / 2);
    if (count % 2 === 1) {
      summary.medianSuccessMs = successDurations[middle];
    } else {
      const lower = successDurations[middle - 1];
      const upper = successDurations[middle];
      summary.medianSuccessMs = lower + (upper - lower) / 2;
    }
  }

  candidates.sort((a, b) => {
    if (a.durationMs !== b.durationMs) return b.durationMs - a.durationMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  summary.slowest = candidates.slice(0, 3);
  return summary;
}
