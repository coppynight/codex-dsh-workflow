/** Compact observation is opt-in. Ownership, terminal evidence and blockers are never omitted. */
export function observationView(full, { detail = 'full', afterCursor } = {}) {
  if (detail === 'full') return full;
  const {messages = [], toolEvents = [], recentEventTypes, observationNote, ...essential} = full;
  const changed = afterCursor === undefined || afterCursor !== full.cursor;
  const result = {...essential, changed, viewDetail: 'summary', evidenceAvailable: {messages: messages.length, toolEvents: toolEvents.length + (full.toolEventsOmitted || 0)}};
  delete result.toolEventsOmitted;
  if (changed) {
    const last = messages.at(-1);
    const value = last?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
    if (value && (afterCursor === undefined || last.seq > afterCursor)) result.latestMessage = {seq: last.seq, text: value.slice(0, 600), truncated: value.length > 600};
  }
  const failures = toolEvents.filter(e => e.data?.isError || e.data?.error);
  if (failures.length) result.recentToolFailures = failures;
  result.next = 'Fetch detail=full once when terminal, blocked, or more evidence is needed; verify files and idle ownership before handoff.';
  return result;
}
