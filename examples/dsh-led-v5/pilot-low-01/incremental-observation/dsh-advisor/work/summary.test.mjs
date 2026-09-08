import test from 'node:test';
import assert from 'node:assert/strict';
import { observationView } from './observation.mjs';

const fail = (seq) => ({ seq, data: { isError: true } });

test('recentToolFailures filters to seq > afterCursor only', () => {
  const r = observationView(
    { cursor: 5, state: 'running', toolEvents: [fail(2), fail(4), fail(5)] },
    { detail: 'summary', afterCursor: 3 },
  );
  assert.deepEqual(r.recentToolFailures.map((e) => e.seq), [4, 5]);
});

test('no cursor includes all failures', () => {
  const r = observationView(
    { cursor: 5, state: 'running', toolEvents: [fail(1), fail(3)] },
    { detail: 'summary' },
  );
  assert.deepEqual(r.recentToolFailures.map((e) => e.seq), [1, 3]);
});

test('recentToolFailures omitted when none are new', () => {
  const r = observationView(
    { cursor: 5, state: 'running', toolEvents: [fail(2), fail(3)] },
    { detail: 'summary', afterCursor: 3 },
  );
  assert.ok(!('recentToolFailures' in r));
});

test('failureSeen true even when failure already reported (below cursor)', () => {
  const r = observationView(
    { cursor: 5, state: 'running', toolEvents: [fail(2)] },
    { detail: 'summary', afterCursor: 3 },
  );
  assert.equal(r.failureSeen, true);
  assert.ok(!('recentToolFailures' in r));
});

test('failureSeen absent when no supplied tool event failed', () => {
  const r = observationView(
    { cursor: 1, state: 'running', toolEvents: [{ seq: 1, data: { ok: true } }] },
    { detail: 'summary', afterCursor: 0 },
  );
  assert.ok(!('failureSeen' in r));
});

test('failureCoverage partial when toolEventsOmitted > 0', () => {
  const r = observationView(
    { cursor: 3, state: 'running', toolEventsOmitted: 5, toolEvents: [] },
    { detail: 'summary', afterCursor: 2 },
  );
  assert.equal(r.failureCoverage, 'partial');
});

test('failureCoverage complete when no toolEventsOmitted', () => {
  const r = observationView({ cursor: 3, state: 'running', toolEvents: [] }, { detail: 'summary', afterCursor: 2 });
  assert.equal(r.failureCoverage, 'complete');
});

test('pending approvals/questions and terminal state preserved on unchanged observation', () => {
  const full = {
    cursor: 3,
    state: 'waiting',
    pendingApprovals: [{ id: 'p1' }],
    questions: ['q?'],
    terminal: false,
    terminalReason: null,
    toolEvents: [],
  };
  const r = observationView(full, { detail: 'summary', afterCursor: 3 });
  assert.equal(r.changed, false);
  assert.deepEqual(r.pendingApprovals, [{ id: 'p1' }]);
  assert.deepEqual(r.questions, ['q?']);
  assert.equal(r.terminal, false);
  assert.equal(r.terminalReason, null);
});

test('terminal state preserved on changed observation', () => {
  const full = {
    cursor: 4,
    state: 'terminated',
    terminal: true,
    terminalReason: 'success',
    toolEvents: [],
  };
  const r = observationView(full, { detail: 'summary', afterCursor: 3 });
  assert.equal(r.terminal, true);
  assert.equal(r.terminalReason, 'success');
});

test('afterCursor greater than full.cursor throws RangeError', () => {
  assert.throws(
    () => observationView({ cursor: 3, state: 'running', toolEvents: [] }, { detail: 'summary', afterCursor: 4 }),
    RangeError,
  );
});

test('afterCursor negative throws RangeError', () => {
  assert.throws(
    () => observationView({ cursor: 3, state: 'running', toolEvents: [] }, { detail: 'summary', afterCursor: -1 }),
    RangeError,
  );
});

test('afterCursor non-integer throws RangeError', () => {
  assert.throws(
    () => observationView({ cursor: 3, state: 'running', toolEvents: [] }, { detail: 'summary', afterCursor: 2.5 }),
    RangeError,
  );
});

test('afterCursor above MAX_SAFE_INTEGER throws RangeError', () => {
  assert.throws(
    () => observationView({ cursor: 3, state: 'running', toolEvents: [] }, { detail: 'summary', afterCursor: Number.MAX_SAFE_INTEGER + 1 }),
    RangeError,
  );
});

test('full.cursor negative throws RangeError in summary mode', () => {
  assert.throws(() => observationView({ cursor: -1, state: 'running', toolEvents: [] }, { detail: 'summary' }), RangeError);
});

test('full.cursor non-integer throws RangeError in summary mode', () => {
  assert.throws(() => observationView({ cursor: 1.5, state: 'running', toolEvents: [] }, { detail: 'summary' }), RangeError);
});

test('full.cursor not a safe integer throws RangeError in summary mode', () => {
  assert.throws(
    () => observationView({ cursor: Number.MAX_SAFE_INTEGER + 1, state: 'running', toolEvents: [] }, { detail: 'summary' }),
    RangeError,
  );
});

test('validation is skipped in full detail mode', () => {
  const full = { cursor: -5, state: 'running', toolEvents: [] };
  assert.equal(observationView(full, { detail: 'full', afterCursor: 99 }), full);
});

test('summary does not mutate supplied object or arrays', () => {
  const full = {
    cursor: 5,
    state: 'running',
    messages: [{ seq: 5, content: [{ type: 'text', text: 'x' }] }],
    toolEvents: [fail(2), fail(4)],
    toolEventsOmitted: 3,
  };
  const snapshot = JSON.parse(JSON.stringify(full));
  observationView(full, { detail: 'summary', afterCursor: 3 });
  assert.deepEqual(full, snapshot);
});

test('latestMessage at most 600 chars with truncation flag', () => {
  const long = 'a'.repeat(700);
  const full = {
    cursor: 1,
    state: 'running',
    messages: [{ seq: 1, content: [{ type: 'text', text: long }] }],
    toolEvents: [],
  };
  const r = observationView(full, { detail: 'summary' });
  assert.equal(r.latestMessage.text.length, 600);
  assert.equal(r.latestMessage.truncated, true);
});

test('latestMessage not repeated when old relative to afterCursor', () => {
  const full = {
    cursor: 5,
    state: 'running',
    messages: [{ seq: 2, content: [{ type: 'text', text: 'old' }] }],
    toolEvents: [],
  };
  const r = observationView(full, { detail: 'summary', afterCursor: 3 });
  assert.ok(!('latestMessage' in r));
});

test('full detail returns the same reference (identity preserved)', () => {
  const a = { cursor: 4, state: 'running' };
  assert.equal(observationView(a), a);
});
