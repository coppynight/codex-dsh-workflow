const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const STATUSES = new Set(['succeeded', 'failed', 'skipped']);

/**
 * Parse newline-delimited JSON job records.
 * @param {string} text - Input text (LF/CRLF), optional leading BOM.
 * @returns {{jobs: Array<{id:string,durationMs:number,status:string}>, errors: Array<{line:number,code:string}>}}
 */
export function parseJobs(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseJobs expects a string input');
  }

  let body = text;
  if (body.charCodeAt(0) === 0xfeff) {
    // Strip leading BOM only at the very start.
    body = body.slice(1);
  }

  const jobs = [];
  const errors = [];
  const seen = new Set();

  // Split into physical lines handling CRLF, LF, and lone CR. The BOM (if
  // present) was never a newline so line numbering is unaffected.
  const lines = body.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNumber = i + 1;
    // Blank / whitespace-only lines are ignored but still advance the number.
    if (raw.trim() === '') continue;

    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      errors.push({ line: lineNumber, code: 'INVALID_JSON' });
      continue;
    }

    // Schema validation precedes duplicate detection.
    const record = normalize(value);
    if (record === null) {
      errors.push({ line: lineNumber, code: 'SCHEMA' });
      continue;
    }

    if (seen.has(record.id)) {
      errors.push({ line: lineNumber, code: 'DUPLICATE_ID' });
      continue;
    }

    seen.add(record.id);
    jobs.push(record);
  }

  return { jobs, errors };
}

/**
 * Validate and normalize a parsed JSON value into a clean job record, dropping
 * any extra fields. Returns null when the value does not satisfy the schema.
 * @param {*} value
 * @returns {null | {id:string,durationMs:number,status:string}}
 */
function normalize(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const { id, durationMs, status } = value;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
  if (typeof durationMs !== 'number') return null;
  if (!Number.isInteger(durationMs) || durationMs < 0) return null;
  if (typeof status !== 'string' || !STATUSES.has(status)) return null;
  return { id, durationMs, status };
}
