// parse.mjs — parse newline-delimited JSON job reports.
// Pure, dependency-free. Exposes parseJobs(text) -> { jobs, errors }.

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validate an already JSON-parsed value as a job record.
 * Returns a fresh normalized record containing only {id, durationMs, status},
 * or null when the value does not satisfy the schema.
 */
function normalizeRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const { id, durationMs, status } = value;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 32 ||
    !ID_PATTERN.test(id)
  ) {
    return null;
  }
  if (
    typeof durationMs !== 'number' ||
    !Number.isInteger(durationMs) ||
    durationMs < 0
  ) {
    return null;
  }
  if (status !== 'succeeded' && status !== 'failed' && status !== 'skipped') {
    return null;
  }
  return {
    id,
    // Normalize -0 (JSON text "-0") to +0 for stable equality.
    durationMs: durationMs === 0 ? 0 : durationMs,
    status,
  };
}

/**
 * Parse newline-delimited JSON job reports.
 *
 * @param {string} text input text (UTF-8 decoded by the caller)
 * @returns {{jobs: Array<{id: string, durationMs: number, status: string}>, errors: Array<{line: number, code: string}>}}
 * @throws {TypeError} when text is not a string
 */
export function parseJobs(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseJobs expects a string');
  }
  // Strip exactly one leading BOM, if present.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const jobs = [];
  const errors = [];
  const acceptedIds = new Set();

  const rawLines = source.split('\n');
  for (let index = 0; index < rawLines.length; index++) {
    // Allow CRLF by dropping a trailing carriage return; a lone \r is not a
    // line terminator for JSON text anyway.
    const line = rawLines[index].replace(/\r+$/, '');
    if (line.trim() === '') {
      continue; // blank lines are ignored but still occupy their line number
    }
    const lineNumber = index + 1;

    let value;
    try {
      value = JSON.parse(line);
    } catch {
      errors.push({ line: lineNumber, code: 'INVALID_JSON' });
      continue;
    }

    const record = normalizeRecord(value);
    if (record === null) {
      errors.push({ line: lineNumber, code: 'SCHEMA' });
      continue;
    }

    if (acceptedIds.has(record.id)) {
      errors.push({ line: lineNumber, code: 'DUPLICATE_ID' });
      continue;
    }

    acceptedIds.add(record.id);
    jobs.push(record);
  }

  return { jobs, errors };
}
