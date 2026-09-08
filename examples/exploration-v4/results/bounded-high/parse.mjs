const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const STATUSES = new Set(['succeeded', 'failed', 'skipped']);

/**
 * Parse newline-delimited job JSON text into normalized records and errors.
 * @param {string} text
 * @returns {{jobs: Array<{id: string, durationMs: number, status: string}>, errors: Array<{line: number, code: string}>}}
 */
export function parseJobs(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseJobs expects a string');
  }

  // Strip a leading byte-order mark only (at position 0).
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Split on LF or CRLF. Physical line number = index + 1 regardless of blank lines.
  const lines = src.split(/\r\n|\n/);

  const jobs = [];
  const errors = [];
  const seenIds = new Set();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Blank lines (empty or whitespace-only) are ignored but still advance the line count.
    if (raw.trim() === '') continue;
    const line = i + 1;

    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      errors.push({ line, code: 'INVALID_JSON' });
      continue;
    }

    // A valid record must be a plain (non-null, non-array) object.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push({ line, code: 'SCHEMA' });
      continue;
    }

    const { id, durationMs, status } = value;
    const idOk =
      typeof id === 'string' && ID_RE.test(id);
    const durationOk =
      typeof durationMs === 'number' &&
      Number.isFinite(durationMs) &&
      Number.isInteger(durationMs) &&
      durationMs >= 0;
    const statusOk = STATUSES.has(status);

    // Schema validation precedes duplicate detection.
    if (!idOk || !durationOk || !statusOk) {
      errors.push({ line, code: 'SCHEMA' });
      continue;
    }

    // Only schema-valid records can collide with an already accepted id.
    if (seenIds.has(id)) {
      errors.push({ line, code: 'DUPLICATE_ID' });
      continue;
    }

    seenIds.add(id);
    jobs.push({ id, durationMs, status });
  }

  return { jobs, errors };
}
