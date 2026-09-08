const REDACTED = '[REDACTED]';

export function redactLog(text) {
  if (typeof text !== 'string') {
    throw new TypeError('redactLog expects a string argument');
  }

  const ranges = [];
  const strings = [];
  const stringRE = /"(?:[^"\\]|\\[\s\S])*"/g;
  let match;

  while ((match = stringRE.exec(text)) !== null) {
    strings.push({ start: match.index, end: stringRE.lastIndex });
  }

  function add(start, end) {
    if (end > start) ranges.push([start, end]);
  }

  // Keep matches inside quoted text from consuming the closing quote.
  function boundedEnd(start, end) {
    let low = 0;
    let high = strings.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (strings[middle].start < start) low = middle + 1;
      else high = middle;
    }
    const enclosing = strings[low - 1];
    return enclosing && start < enclosing.end
      ? Math.min(end, enclosing.end - 1)
      : end;
  }

  // Tokenizing strings avoids mistaking escaped text inside a JSON
  // string for another JSON member.
  const sensitiveKeys = new Set([
    '"token"', '"api_key"', '"apiKey"', '"password"', '"secret"'
  ]);
  for (let i = 0; i + 1 < strings.length; i++) {
    const key = strings[i];
    const value = strings[i + 1];
    if (sensitiveKeys.has(text.slice(key.start, key.end)) &&
        /^\s*:\s*$/.test(text.slice(key.end, value.start))) {
      add(value.start + 1, value.end - 1);
    }
  }

  // Query values have different delimiters from assignment values.
  // Record empty query values too, so assignments cannot consume '&'.
  const queryKeys = new Set();
  const queryRE = /[?&](token|api_key|key|access_token)=([^\s&#]*)/g;
  while ((match = queryRE.exec(text)) !== null) {
    const keyStart = match.index + 1;
    const valueStart = keyStart + match[1].length + 1;
    queryKeys.add(keyStart);
    add(valueStart, boundedEnd(valueStart, queryRE.lastIndex));
  }

  const assignmentRE = /(?<![\p{L}\p{N}\p{M}_$])(token|api_key|password)=([^\s]*)/gu;
  while ((match = assignmentRE.exec(text)) !== null) {
    if (queryKeys.has(match.index)) continue;
    const valueStart = match.index + match[1].length + 1;
    add(valueStart, boundedEnd(valueStart, assignmentRE.lastIndex));
  }

  const bearerRE = /\bbearer\s+([A-Za-z0-9._~+/=\-]+)/gi;
  while ((match = bearerRE.exec(text)) !== null) {
    add(bearerRE.lastIndex - match[1].length, bearerRE.lastIndex);
  }

  // Merge overlapping detections against the original input, avoiding
  // replacement-order effects when one credential contains another.
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] < previous[1]) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      merged.push(range.slice());
    }
  }

  const output = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    output.push(text.slice(cursor, start), REDACTED);
    cursor = end;
  }
  output.push(text.slice(cursor));
  return output.join('');
}
