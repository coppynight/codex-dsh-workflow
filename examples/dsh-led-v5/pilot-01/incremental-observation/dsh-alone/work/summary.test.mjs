import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationView } from './observation.mjs';

test('summary keeps only failure events newer than afterCursor', () => {
  const events = [
    { seq: 1, data: { isError: true } }, // old failure, already reported
    { seq: 2, data: { ok: true } }, // not a failure
    { seq: 3, data: { error: 'boom' } }, // new failure
    { seq: 4, data: { isError: true } }, // new failure
    { seq: 5, data: { done: true } }, // not a failure
  ];
  const full = { cursor: 5, state: 'running', toolEvents: events };
  const r = observationView(full, { detail: 'summary', afterCursor: 2 });
  assert.deepEqual(r.recentToolFailures, [events[2], events[3]]);
  assert.equal(r.failureSeen, true);
  assert.equal(r.changed, true);
});

test('summary keeps all failures when no cursor is supplied', () => {
  const events = [
    { seq: 1, data: { isError: true } },
    { seq: 2, data: { ok: true } },
    { seq: 3, data: { error: 'x' } },
  ];
  const r = observationView({ cursor: 3, toolEvents: events }, { detail: 'summary' });
  assert.deepEqual(r.recentToolFailures, [events[0], events[2]]);
  assert.equal(r.failureSeen, true);
});

test('omits recentToolFailures when no supplied failure is newer than afterCursor', () => {
  const events = [
    { seq: 1, data: { isError: true } }, // old failure, already reported
    { seq: 3, data: { ok: true } }, // newer but not a failure
  ];
  const r = observationView({ cursor: 3, toolEvents: events }, { detail: 'summary', afterCursor: 2 });
  assert.equal('recentToolFailures' in r, false);
  assert.equal(r.failureSeen, true); // supplied failure is still seen
});

test('failureSeen reflects any supplied failure even when none are new', () => {
  const r = observationView(
    { cursor: 2, toolEvents: [{ seq: 1, data: { isError: true } }] },
    { detail: 'summary', afterCursor: 2 },
  );
  assert.equal(r.changed, false);
  assert.equal('recentToolFailures' in r, false);
  assert.equal(r.failureSeen, true);
});

test('omits failureSeen and recentToolFailures when nothing failed', () => {
  const r = observationView(
    { cursor: 2, toolEvents: [{ seq: 1, data: { ok: 1 } }, { seq: 2 }] },
    { detail: 'summary', afterCursor: 0 },
  );
  assert.equal('failureSeen' in r, false);
  assert.equal('recentToolFailures' in r, false);
  assert.equal(r.failureCoverage, 'complete');
});

test('failureCoverage is complete unless tool events were omitted', () => {
  const complete = observationView(
    { cursor: 4, state: 'running', toolEvents: [{ seq: 4, data: { isError: true } }] },
    { detail: 'summary', afterCursor: 3 },
  );
  assert.equal(complete.failureCoverage, 'complete');
  assert.equal('toolEventsOmitted' in complete, false);
  assert.equal(complete.failureSeen, true);

  const partial = observationView(
    { cursor: 4, state: 'running', toolEventsOmitted: 3, toolEvents: [{ seq: 4, data: { isError: true } }] },
    { detail: 'summary', afterCursor: 3 },
  );
  assert.equal(partial.failureCoverage, 'partial'); // omitted history was not checked
  assert.equal('toolEventsOmitted' in partial, false);
  assert.equal(partial.failureSeen, true);
  assert.deepEqual(partial.recentToolFailures, [{ seq: 4, data: { isError: true } }]);
});

test('failureCoverage stays partial even when no tool event failed', () => {
  const r = observationView(
    { cursor: 2, toolEventsOmitted: 5, toolEvents: [{ seq: 2, data: { ok: 1 } }] },
    { detail: 'summary', afterCursor: 1 },
  );
  assert.equal(r.failureCoverage, 'partial');
  assert.equal('failureSeen' in r, false);
});

test('afterCursor must be a nonnegative safe integer not greater than full.cursor', () => {
  const full = () => ({ cursor: 5, state: 'running', toolEvents: [] });
  for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, '3', 2 ** 53, null, {}]) {
    assert.throws(() => observationView(full(), { detail: 'summary', afterCursor: bad }), RangeError, `afterCursor ${String(bad)}`);
  }
  assert.throws(() => observationView(full(), { detail: 'summary', afterCursor: 6 }), RangeError); // exceeds cursor
  assert.doesNotThrow(() => observationView(full(), { detail: 'summary', afterCursor: 5 })); // equal is fine
  assert.doesNotThrow(() => observationView(full(), { detail: 'summary', afterCursor: 0 })); // zero is fine
});

test('full.cursor must be a nonnegative safe integer in summary mode too', () => {
  for (const cursor of [-1, 1.5, NaN, Infinity, '4', 2 ** 53]) {
    assert.throws(() => observationView({ cursor, state: 'running' }, { detail: 'summary' }), RangeError, `cursor ${String(cursor)}`);
  }
  assert.throws(() => observationView({ state: 'running' }, { detail: 'summary' }), RangeError); // missing cursor
  assert.doesNotThrow(() => observationView({ cursor: 0, state: 'running' }, { detail: 'summary' }));
  assert.doesNotThrow(() => observationView({ cursor: 5 }, { detail: 'summary', afterCursor: 5 }));
});

test('detail=full returns the observation unchanged without summary validation', () => {
  const full = { cursor: 5, state: 'running' };
  assert.equal(observationView(full, { detail: 'full', afterCursor: 99 }), full);
  assert.equal(observationView(full, { detail: 'full', afterCursor: -1 }), full);
  assert.equal(observationView(full), full); // default detail is full
  const bad = { cursor: -1 }; // invalid cursor is fine in full mode
  assert.equal(observationView(bad, { detail: 'full' }), bad);
});

test('summary mode does not mutate the supplied observation or arrays', () => {
  const full = {
    cursor: 4,
    state: 'running',
    toolEventsOmitted: 2,
    messages: [{ seq: 3, content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'x' }] }],
    toolEvents: [
      { seq: 2, data: { isError: true } },
      { seq: 4, data: { ok: 1 } },
    ],
  };
  const freeze = (v) => {
    if (v && typeof v === 'object') {
      Object.freeze(v);
      for (const k of Object.keys(v)) freeze(v[k]);
    }
    return v;
  };
  const frozen = freeze(full);
  const before = JSON.stringify(frozen);
  const r = observationView(frozen, { detail: 'summary', afterCursor: 2 });
  assert.notEqual(r, frozen);
  assert.equal(JSON.stringify(frozen), before);
  assert.deepEqual(frozen.messages, full.messages);
  assert.deepEqual(frozen.toolEvents, full.toolEvents);
});

test('latestMessage truncates at 600 characters with an explicit flag', () => {
  const r = observationView(
    { cursor: 1, messages: [{ seq: 1, content: [{ type: 'text', text: 'a'.repeat(700) }] }] },
    { detail: 'summary', afterCursor: 0 },
  );
  assert.deepEqual(r.latestMessage, { seq: 1, text: 'a'.repeat(600), truncated: true });
});

test('latestMessage is not flagged truncated at 600 characters or fewer', () => {
  const text = 'b'.repeat(600);
  const r = observationView(
    { cursor: 1, messages: [{ seq: 1, content: [{ type: 'text', text }] }] },
    { detail: 'summary' },
  );
  assert.equal(r.latestMessage.truncated, false);
  assert.equal(r.latestMessage.text, text);
});

test('latestMessage is not repeated when afterCursor already covers the cursor', () => {
  const full = { cursor: 3, state: 'awaitingUser', messages: [{ seq: 3, content: [{ type: 'text', text: 'Approve?' }] }] };
  const r = observationView(full, { detail: 'summary', afterCursor: 3 });
  assert.equal(r.changed, false);
  assert.equal('latestMessage' in r, false);
});

test('latestMessage only surfaces a message newer than afterCursor', () => {
  const full = {
    cursor: 5,
    messages: [{ seq: 3, content: [{ type: 'text', text: 'old text' }] }],
    toolEvents: [{ seq: 5, data: { ok: 1 } }], // newer event advanced the cursor
  };
  const r = observationView(full, { detail: 'summary', afterCursor: 3 });
  assert.equal(r.changed, true);
  assert.equal('latestMessage' in r, false); // the newest message (seq 3) is not new
});

test('latestMessage carries the newest message with text-only content joined', () => {
  const r = observationView(
    { cursor: 2, messages: [{ seq: 2, content: [{ type: 'tool_result', text: 'ignored' }, { type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }] },
    { detail: 'summary' },
  );
  assert.equal(r.latestMessage.seq, 2);
  assert.equal(r.latestMessage.text, 'first\nsecond');
  assert.equal(r.latestMessage.truncated, false);
});

test('unchanged observations preserve pending approvals, questions and terminal state', () => {
  const full = {
    cursor: 6,
    state: 'awaitingUserApproval',
    pendingApproval: { id: 'a1', message: 'Approve file write?' },
    terminal: false,
    toolEvents: [{ seq: 6, data: { isError: true } }], // failure already reported at the cursor
  };
  const r = observationView(full, { detail: 'summary', afterCursor: 6 });
  assert.equal(r.changed, false);
  assert.equal(r.state, 'awaitingUserApproval');
  assert.deepEqual(r.pendingApproval, { id: 'a1', message: 'Approve file write?' });
  assert.equal(r.terminal, false);
  assert.equal(r.failureSeen, true); // supplied failure is still reported as seen
  assert.equal('recentToolFailures' in r, false); // but not as new
  assert.equal('latestMessage' in r, false);
});

test('terminal state survives an unchanged summary', () => {
  const full = { cursor: 8, state: 'done', terminal: true, messages: [{ seq: 8, content: [{ type: 'text', text: 'Finished.' }] }] };
  const r = observationView(full, { detail: 'summary', afterCursor: 8 });
  assert.equal(r.changed, false);
  assert.equal(r.terminal, true);
  assert.equal(r.state, 'done');
  assert.equal('latestMessage' in r, false);
});

test('evidenceAvailable counts supplied messages and kept plus omitted tool events', () => {
  const r = observationView(
    {
      cursor: 3,
      toolEventsOmitted: 7,
      messages: [{ seq: 1, content: [] }, { seq: 2, content: [] }],
      toolEvents: [{ seq: 3, data: { ok: 1 } }],
    },
    { detail: 'summary' },
  );
  assert.deepEqual(r.evidenceAvailable, { messages: 2, toolEvents: 8 });
  assert.equal('toolEventsOmitted' in r, false);
});

test('summary preserves other essential fields and keeps the summary shape', () => {
  const full = { cursor: 2, state: 'running', sessionId: 's-1', toolEvents: [], recentEventTypes: ['tool'], observationNote: 'note' };
  const r = observationView(full, { detail: 'summary' });
  assert.equal(r.sessionId, 's-1');
  assert.equal(r.cursor, 2);
  assert.equal(r.viewDetail, 'summary');
  assert.equal(r.changed, true);
  assert.equal('recentEventTypes' in r, false);
  assert.equal('observationNote' in r, false);
  assert.equal(typeof r.next, 'string');
});
