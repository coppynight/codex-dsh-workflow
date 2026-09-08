import test from 'node:test';
import assert from 'node:assert/strict';
import { observationView } from './observation.mjs';

const ev = (seq, fail = true, extra = {}) => ({ seq, data: fail ? { isError: true, ...extra } : { ok: true } });

// detail='full' returns identity, never summarized.
test('detail=full returns the same object', () => {
  const full = { cursor: 3, state: 'running', messages: [{ seq: 1, content: [] }] };
  assert.equal(observationView(full, { detail: 'full' }), full);
  assert.equal(observationView(full), full); // default detail
});

// recentToolFailures: only failures with seq > afterCursor.
test('recentToolFailures keeps only failures newer than afterCursor', () => {
  const full = {
    cursor: 6,
    state: 'running',
    toolEvents: [ev(1), ev(3), ev(4, false), ev(5), ev(6, true, { error: 'e' })],
  };
  const r = observationView(full, { detail: 'summary', afterCursor: 3 });
  assert.deepEqual(r.recentToolFailures.map((x) => x.seq), [5, 6]);
  assert.equal(r.failureSeen, true);
});

// No cursor => all supplied failures included.
test('recentToolFailures includes all failures when no cursor', () => {
  const full = { cursor: 6, toolEvents: [ev(1), ev(2, false), ev(5)] };
  const r = observationView(full, { detail: 'summary' });
  assert.deepEqual(r.recentToolFailures.map((x) => x.seq), [1, 5]);
});

// recentToolFailures omitted when none are new.
test('recentToolFailures omitted when no failure is newer than afterCursor', () => {
  const full = { cursor: 6, toolEvents: [ev(1), ev(3)] };
  const r = observationView(full, { detail: 'summary', afterCursor: 3 });
  assert.equal('recentToolFailures' in r, false);
  assert.equal(r.failureSeen, true); // still saw a failure, just already reported
});

// failureSeen true even when failure already reported (seq <= afterCursor).
test('failureSeen true for already-reported failures', () => {
  const full = { cursor: 6, toolEvents: [ev(3)] };
  const r = observationView(full, { detail: 'summary', afterCursor: 5 });
  assert.equal(r.failureSeen, true);
  assert.equal('recentToolFailures' in r, false);
});

// failureSeen absent/false when no supplied event failed.
test('failureSeen not set when no supplied failure', () => {
  const full = { cursor: 2, toolEvents: [ev(1, false), ev(2, false)] };
  const r = observationView(full, { detail: 'summary' });
  assert.equal('failureSeen' in r, false);
  assert.equal('recentToolFailures' in r, false);
});

// failureCoverage reflects toolEventsOmitted.
test('failureCoverage partial when omitted tool events exist', () => {
  const full = { cursor: 4, toolEventsOmitted: 7, toolEvents: [ev(3)] };
  const r = observationView(full, { detail: 'summary' });
  assert.equal(r.failureCoverage, 'partial');
  assert.equal('toolEventsOmitted' in r, false);
});

test('failureCoverage complete when no omitted tool events', () => {
  const r = observationView({ cursor: 4, toolEvents: [] }, { detail: 'summary' });
  assert.equal(r.failureCoverage, 'complete');
});

// Validation in summary mode.
test('afterCursor beyond cursor throws RangeError', () => {
  const full = { cursor: 4 };
  assert.throws(() => observationView(full, { detail: 'summary', afterCursor: 5 }), RangeError);
});

test('negative afterCursor throws RangeError', () => {
  const full = { cursor: 4 };
  assert.throws(() => observationView(full, { detail: 'summary', afterCursor: -1 }), RangeError);
});

test('non-integer afterCursor throws RangeError', () => {
  const full = { cursor: 4 };
  assert.throws(() => observationView(full, { detail: 'summary', afterCursor: 2.5 }), RangeError);
});

test('non-safe-integer afterCursor throws RangeError', () => {
  const full = { cursor: 4 };
  assert.throws(() => observationView(full, { detail: 'summary', afterCursor: Number.MAX_SAFE_INTEGER + 2 }), RangeError);
});

test('afterCursor equal to cursor is allowed (unchanged)', () => {
  const full = { cursor: 4, state: 'running', pendingApprovals: ['a'] };
  const r = observationView(full, { detail: 'summary', afterCursor: 4 });
  assert.equal(r.changed, false);
});

test('invalid full.cursor in summary mode throws RangeError', () => {
  for (const bad of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, '4']) {
    assert.throws(() => observationView({ cursor: bad }, { detail: 'summary' }), RangeError, `cursor=${bad}`);
  }
});

// Non-mutation.
test('summary does not mutate the supplied observation or arrays', () => {
  const full = {
    cursor: 6,
    state: 'running',
    pendingApprovals: ['p1'],
    toolEventsOmitted: 3,
    messages: [{ seq: 2, content: [{ type: 'text', text: 'hi' }] }],
    toolEvents: [ev(1), ev(5)],
  };
  const snapshot = structuredClone(full);
  const r = observationView(full, { detail: 'summary', afterCursor: 0 });
  assert.notEqual(r, full);
  assert.notEqual(r.recentToolFailures, full.toolEvents);
  assert.deepEqual(full, snapshot);
});

// Pending approvals/questions and terminal state preserved on unchanged obs.
test('essential state, approvals, questions preserved on unchanged observation', () => {
  const full = {
    cursor: 5,
    state: 'blocked',
    pendingApprovals: [{ id: 'approve-run' }],
    questions: ['which file?'],
    terminal: true,
    ownership: 'builder',
    messages: [{ seq: 5, content: [{ type: 'text', text: 'need input' }] }],
    toolEvents: [],
  };
  const r = observationView(full, { detail: 'summary', afterCursor: 5 });
  assert.equal(r.changed, false);
  assert.equal(r.state, 'blocked');
  assert.equal(r.terminal, true);
  assert.equal(r.ownership, 'builder');
  assert.deepEqual(r.pendingApprovals, full.pendingApprovals);
  assert.deepEqual(r.questions, full.questions);
  // unchanged => no repeated old latestMessage
  assert.equal('latestMessage' in r, false);
});

// latestMessage truncation.
test('latestMessage truncated at 600 chars with flag', () => {
  const long = 'x'.repeat(700);
  const full = { cursor: 1, messages: [{ seq: 1, content: [{ type: 'text', text: long }] }] };
  const r = observationView(full, { detail: 'summary' });
  assert.equal(r.latestMessage.text.length, 600);
  assert.equal(r.latestMessage.truncated, true);
  assert.equal(r.latestMessage.seq, 1);
});

test('latestMessage not truncated when within 600', () => {
  const full = { cursor: 1, messages: [{ seq: 1, content: [{ type: 'text', text: 'short' }] }] };
  const r = observationView(full, { detail: 'summary' });
  assert.equal(r.latestMessage.text, 'short');
  assert.equal(r.latestMessage.truncated, false);
});

// No repeated old message: newer cursor but no newer message.
test('no old message repeated when last message not newer than afterCursor', () => {
  const full = {
    cursor: 5,
    messages: [{ seq: 3, content: [{ type: 'text', text: 'old' }] }],
    toolEvents: [ev(4)], // new tool activity, but message is old
  };
  const r = observationView(full, { detail: 'summary', afterCursor: 3 });
  assert.equal('latestMessage' in r, false);
});
