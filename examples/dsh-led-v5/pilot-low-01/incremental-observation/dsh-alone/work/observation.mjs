/** Compact observation is opt-in. Ownership, terminal evidence and blockers are never omitted. */
export function observationView(full, { detail = 'full', afterCursor } = {}) {
  if (detail === 'full') return full;

  // ---- summary-mode validation (no mutation) ----
  if (full === null || full === undefined || !Number.isSafeInteger(full.cursor) || full.cursor < 0) {
    throw new RangeError('full.cursor must be a nonnegative safe integer');
  }
  if (afterCursor !== undefined) {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new RangeError('afterCursor must be a nonnegative safe integer');
    }
    if (afterCursor > full.cursor) {
      throw new RangeError('afterCursor must not be greater than full.cursor');
    }
  }

  const { messages = [], toolEvents = [], recentEventTypes, observationNote, ...essential } = full;
  const toolEventsOmitted = Number.isSafeInteger(full.toolEventsOmitted) ? full.toolEventsOmitted : 0;
  const changed = afterCursor === undefined || afterCursor !== full.cursor;
  const result = { ...essential, changed, viewDetail: 'summary', evidenceAvailable: { messages: messages.length, toolEvents: toolEvents.length + toolEventsOmitted } };
  delete result.toolEventsOmitted;

  const isFailure = (e) => Boolean(e && e.data && (e.data.isError || e.data.error));
  const failures = toolEvents.filter(isFailure);

  // Any supplied tool event failed (regardless of whether it is already reported).
  if (failures.length) result.failureSeen = true;
  // Coverage reflects only the supplied window; do not claim omitted history was checked.
  result.failureCoverage = toolEventsOmitted > 0 ? 'partial' : 'complete';

  const newFailures = failures.filter((e) => afterCursor === undefined || e.seq > afterCursor);
  if (newFailures.length) result.recentToolFailures = newFailures;

  if (changed) {
    const last = messages.at(-1);
    const value = last?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '';
    if (value && (afterCursor === undefined || last.seq > afterCursor)) result.latestMessage = { seq: last.seq, text: value.slice(0, 600), truncated: value.length > 600 };
  }
  result.next = 'Fetch detail=full once when terminal, blocked, or more evidence is needed; verify files and idle ownership before handoff.';
  return result;
}
