/** Compact observation is opt-in. Ownership, terminal evidence and blockers are never omitted. */
export function observationView(full, { detail = 'full', afterCursor } = {}) {
  if (detail === 'full') return full;

  // Summary mode only: cursors drive delta reporting, so both ends must be sane.
  if (!Number.isSafeInteger(full.cursor) || full.cursor < 0) {
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
  const changed = afterCursor === undefined || afterCursor !== full.cursor;
  const result = {
    ...essential,
    changed,
    viewDetail: 'summary',
    evidenceAvailable: {
      messages: messages.length,
      toolEvents: toolEvents.length + (full.toolEventsOmitted || 0),
    },
  };
  delete result.toolEventsOmitted;

  const failures = toolEvents.filter((e) => e.data?.isError || e.data?.error);
  if (failures.length) result.failureSeen = true;
  result.failureCoverage = (full.toolEventsOmitted || 0) > 0 ? 'partial' : 'complete';
  const newFailures = afterCursor === undefined ? failures : failures.filter((e) => e.seq > afterCursor);
  if (newFailures.length) result.recentToolFailures = newFailures;

  if (changed) {
    const last = messages.at(-1);
    const value = last?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '';
    if (value && (afterCursor === undefined || last.seq > afterCursor)) result.latestMessage = { seq: last.seq, text: value.slice(0, 600), truncated: value.length > 600 };
  }
  result.next = 'Fetch detail=full once when terminal, blocked, or more evidence is needed; verify files and idle ownership before handoff.';
  return result;
}
