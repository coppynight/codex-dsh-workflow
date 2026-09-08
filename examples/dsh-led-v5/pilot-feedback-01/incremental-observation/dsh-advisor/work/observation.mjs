/** Compact observation is opt-in. Ownership, terminal evidence and blockers are never omitted. */

const isNonNegSafeInt = (n) => Number.isSafeInteger(n) && n >= 0;

/**
 * Build a compact summary of an observation.
 * detail='full' returns the supplied observation unchanged.
 * detail='summary' returns a reduced view. Essential top-level fields
 * (cursor, state, pending approvals/questions, terminal evidence, blockers,
 * ownership) are preserved; bulk history (messages, toolEvents,
 * recentEventTypes, observationNote) is not copied out wholesale.
 *
 * Failure reporting is incremental: recentToolFailures holds only failures
 * whose seq is strictly after afterCursor (all failures when there is no
 * cursor) and is omitted when none are new. failureSeen=true reflects any
 * supplied tool event that failed, even one already reported at or before
 * afterCursor. failureCoverage says whether omitted tool history means the
 * failure set could be incomplete.
 */
export function observationView(full, { detail = 'full', afterCursor } = {}) {
  if (detail === 'full') return full;

  if (!isNonNegSafeInt(full.cursor)) {
    throw new RangeError('full.cursor must be a nonnegative safe integer in summary mode');
  }
  const noCursor = afterCursor === undefined || afterCursor === null;
  if (!noCursor) {
    if (!isNonNegSafeInt(afterCursor)) {
      throw new RangeError('afterCursor must be a nonnegative safe integer in summary mode');
    }
    if (afterCursor > full.cursor) {
      throw new RangeError('afterCursor must not be greater than full.cursor in summary mode');
    }
  }

  const { messages = [], toolEvents = [], recentEventTypes, observationNote, toolEventsOmitted, ...essential } = full;

  const changed = noCursor || afterCursor !== full.cursor;

  const result = {
    ...essential,
    changed,
    viewDetail: 'summary',
    failureCoverage: (toolEventsOmitted || 0) > 0 ? 'partial' : 'complete',
    evidenceAvailable: {
      messages: messages.length,
      toolEvents: toolEvents.length + (toolEventsOmitted || 0),
    },
  };

  const isFailure = (e) => Boolean(e?.data?.isError || e?.data?.error);
  const failures = toolEvents.filter(isFailure);
  if (failures.length) result.failureSeen = true;

  const newFailures = noCursor ? failures : failures.filter((e) => e.seq > afterCursor);
  if (newFailures.length) result.recentToolFailures = newFailures;

  if (changed) {
    const last = messages.at(-1);
    const value = last?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '';
    if (value && (noCursor || last.seq > afterCursor)) {
      result.latestMessage = { seq: last.seq, text: value.slice(0, 600), truncated: value.length > 600 };
    }
  }

  result.next = 'Fetch detail=full once when terminal, blocked, or more evidence is needed; verify files and idle ownership before handoff.';
  return result;
}
