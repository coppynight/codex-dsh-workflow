const isNonnegSafeInt = (v) => Number.isSafeInteger(v) && v >= 0;

/** Compact observation is opt-in. Ownership, terminal evidence and blockers are never omitted. */
export function observationView(full, { detail = 'full', afterCursor } = {}) {
  if (detail === 'full') return full;

  if (!isNonnegSafeInt(full.cursor)) {
    throw new RangeError('observationView: full.cursor must be a nonnegative safe integer in summary mode');
  }
  if (afterCursor !== undefined && (!isNonnegSafeInt(afterCursor) || afterCursor > full.cursor)) {
    throw new RangeError('observationView: afterCursor must be a nonnegative safe integer not greater than full.cursor');
  }

  const { messages = [], toolEvents = [], recentEventTypes, observationNote, ...essential } = full;
  const changed = afterCursor === undefined || afterCursor !== full.cursor;
  const omitted = (Number.isSafeInteger(full.toolEventsOmitted) && full.toolEventsOmitted > 0) ? full.toolEventsOmitted : 0;
  const result = { ...essential, changed, viewDetail: 'summary', evidenceAvailable: { messages: messages.length, toolEvents: toolEvents.length + omitted } };
  delete result.toolEventsOmitted;
  if (changed) {
    const last = messages.at(-1);
    const value = last?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '';
    if (value && (afterCursor === undefined || last.seq > afterCursor)) result.latestMessage = { seq: last.seq, text: value.slice(0, 600), truncated: value.length > 600 };
  }
  const failures = toolEvents.filter((e) => e.data?.isError || e.data?.error);
  if (failures.length) {
    result.failureSeen = true;
    const fresh = failures.filter((e) => afterCursor === undefined || e.seq > afterCursor);
    if (fresh.length) result.recentToolFailures = fresh;
  }
  result.failureCoverage = omitted > 0 ? 'partial' : 'complete';
  result.next = 'Fetch detail=full once when terminal, blocked, or more evidence is needed; verify files and idle ownership before handoff.';
  return result;
}
