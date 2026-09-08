/**
 * Compact observation is opt-in. Ownership, terminal evidence and blockers are never omitted.
 * Summary mode reports only failures newer than `afterCursor`, still flags `failureSeen` when any
 * supplied tool event failed (even if already reported), and states how complete that view is via
 * `failureCoverage` ('partial' when `toolEventsOmitted` events exist, otherwise 'complete').
 * The supplied observation is read-only: it is never mutated.
 */
const MAX_LATEST_TEXT_LENGTH = 600;

const isNonnegativeSafeInteger = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isFailureEvent = (event) => Boolean(event && (event.data?.isError || event.data?.error));

export function observationView(full, { detail = 'full', afterCursor } = {}) {
  if (detail === 'full') return full;

  if (!isNonnegativeSafeInteger(full.cursor)) {
    throw new RangeError(
      `observationView: summary mode requires full.cursor to be a nonnegative safe integer, got ${String(full.cursor)}`,
    );
  }
  if (afterCursor !== undefined && !isNonnegativeSafeInteger(afterCursor)) {
    throw new RangeError(`observationView: afterCursor must be a nonnegative safe integer, got ${String(afterCursor)}`);
  }
  if (afterCursor !== undefined && afterCursor > full.cursor) {
    throw new RangeError(
      `observationView: afterCursor (${afterCursor}) must not be greater than full.cursor (${full.cursor})`,
    );
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
  // Summary-derived fields are authoritative here; do not inherit stale copies from `full`.
  delete result.toolEventsOmitted;
  delete result.failureSeen;
  delete result.recentToolFailures;
  delete result.failureCoverage;

  const failures = toolEvents.filter(isFailureEvent);
  if (failures.length) result.failureSeen = true;

  const freshFailures =
    afterCursor === undefined ? failures : failures.filter((event) => event.seq > afterCursor);
  if (freshFailures.length) result.recentToolFailures = freshFailures;

  result.failureCoverage = (full.toolEventsOmitted || 0) > 0 ? 'partial' : 'complete';

  if (changed) {
    const last = messages.at(-1);
    const value = last?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '';
    if (value && (afterCursor === undefined || last.seq > afterCursor)) {
      result.latestMessage = {
        seq: last.seq,
        text: value.slice(0, MAX_LATEST_TEXT_LENGTH),
        truncated: value.length > MAX_LATEST_TEXT_LENGTH,
      };
    }
  }

  result.next = 'Fetch detail=full once when terminal, blocked, or more evidence is needed; verify files and idle ownership before handoff.';
  return result;
}
