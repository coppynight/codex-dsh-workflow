export function parseJobs(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Expected a string');
  }

  const jobs = [];
  const errors = [];
  const seen = new Set();
  const lines = text.replace(/^\uFEFF/, '').split('\n');

  for (let index = 0; index < lines.length; index++) {
    const source = lines[index];
    if (source.trim() === '') continue;

    const line = index + 1;
    let value;
    try {
      value = JSON.parse(source);
    } catch {
      errors.push({ line, code: 'INVALID_JSON' });
      continue;
    }

    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.id !== 'string' ||
      value.id.length < 1 ||
      value.id.length > 32 ||
      /[^A-Za-z0-9_-]/.test(value.id) ||
      typeof value.durationMs !== 'number' ||
      !Number.isFinite(value.durationMs) ||
      !Number.isInteger(value.durationMs) ||
      value.durationMs < 0 ||
      !['succeeded', 'failed', 'skipped'].includes(value.status)
    ) {
      errors.push({ line, code: 'SCHEMA' });
      continue;
    }

    if (seen.has(value.id)) {
      errors.push({ line, code: 'DUPLICATE_ID' });
      continue;
    }

    seen.add(value.id);
    jobs.push({
      id: value.id,
      durationMs: value.durationMs,
      status: value.status
    });
  }

  return { jobs, errors };
}
