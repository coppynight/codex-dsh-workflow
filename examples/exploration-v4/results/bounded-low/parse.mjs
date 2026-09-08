const ID_RE = /^[A-Za-z0-9_\-]+$/;
const VALID_STATUS = new Set(['succeeded', 'failed', 'skipped']);

/**
 * Validate and normalize a single parsed JSON value as a job record.
 * Returns the normalized record or null when schema-invalid.
 */
function toJob(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const { id, durationMs, status } = value;
  if (typeof id !== 'string' || id.length < 1 || id.length > 32 || !ID_RE.test(id)) {
    return null;
  }
  if (
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    !Number.isInteger(durationMs) ||
    durationMs < 0
  ) {
    return null;
  }
  if (!VALID_STATUS.has(status)) {
    return null;
  }
  // Omit extra fields: build a fresh object with only these three.
  return { id, durationMs, status };
}

/**
 * Parse newline-delimited job JSON.
 * Returns { jobs, errors } where jobs are normalized valid records
 * (first occurrence per id) and errors are { line, code } objects.
 */
export function parseJobs(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseJobs expects a string');
  }
  let body = text;
  if (body.charCodeAt(0) === 0xfeff) {
    body = body.slice(1); // leading BOM removal applies only at the start
  }
  const lines = body.split(/\r\n|\r|\n/);
  const jobs = [];
  const errors = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') {
      continue; // blank lines are ignored but still advance the line index
    }
    const line = i + 1; // physical 1-based line number

    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      errors.push({ line, code: 'INVALID_JSON' });
      continue;
    }

    const job = toJob(value);
    if (job === null) {
      errors.push({ line, code: 'SCHEMA' });
      continue;
    }

    if (seen.has(job.id)) {
      errors.push({ line, code: 'DUPLICATE_ID' });
      continue;
    }

    seen.add(job.id);
    jobs.push(job);
  }

  return { jobs, errors };
}
