import test from 'node:test';
import assert from 'node:assert/strict';
import { observationView } from './observation.mjs';

const fail = (seq) => ({ seq, data: { isError: true } });
const ok = (seq) => ({ seq, data: { ok: true } });

test('recentToolFailures keeps only failures with seq>afterCursor', () => {
  const full = { cursor: 9, state: 'running', toolEvents: [fail(4), ok(5), fail(7), fail(9)] };
  const r = observationView(full, { detail: 'summary', afterCursor: 6 });
  assert.equal(r.recentToolFailures.length, 2);
  assert.deepEqual(r.recentToolFailures.map((e) => e.seq).sort(), [7, 9]);
});

test('recentToolFailures lists all failures when no cursor', () => {
  const full = { cursor: 9, state: 'running', toolEvents: [fail(1), ok(2), fail(3)] };
  const r = observationView(full, { detail: 'summary' });
  assert.deepEqual(r.recentToolFailures.map((e) => e.seq).sort(), [1, 3]);
  assert.equal(r.failureSeen, true);
});

test('recentToolFailures omitted when none are new, failureSeen still true', () => {
  const full = { cursor: 9, state: 'running', toolEvents: [fail(4), fail(2)] };
  const r = observationView(full, { detail: 'summary', afterCursor: 5 });
  assert.equal('recentToolFailures' in r, false);
  assert.equal(r.failureSeen, true);
});

test('recentToolFailures omitted when no failures; failureSeen absent', () => {
  const full = { cursor: 9, state: 'running', toolEvents: [ok(1)] };
  const r = observationView(full, { detail: 'summary' });
  assert.equal('recentToolFailures' in r, false);
  assert.equal('failureSeen' in r, false);
});

test('failureCoverage partial when toolEventsOmitted>0 else complete', () => {
  const a = observationView({ cursor: 9, state: 'running', toolEventsOmitted: 3, toolEvents: [fail(9)] }, { detail: 'summary' });
  assert.equal(a.failureCoverage, 'partial');
  const b = observationView({ cursor: 9, state: 'running', toolEvents: [fail(9)] }, { detail: 'summary' });
  assert.equal(b.failureCoverage, 'complete');
  const c = observationView({ cursor: 9, state: 'running', toolEventsOmitted: 0, toolEvents: [fail(9)] }, { detail: 'summary' });
  assert.equal(c.failureCoverage, 'complete');
});

test('afterCursor validation throws RangeError in summary mode', () => {
  const full = { cursor: 5, state: 'running' };
  assert.throws(() => observationView(full, { detail: 'summary', afterCursor: -1 }), RangeError);
  assert.throws(() => observationView(full, { detail: 'summary', afterCursor: 1.5 }), RangeError);
  assert.throws(() => observationView(full, { detail: 'summary', afterCursor: Infinity }), RangeError);
  assert.throws(() => observationView(full, { detail: 'summary', afterCursor: NaN }), RangeError);
  assert.throws(() => observationView(full, { detail: 'summary', afterCursor: 6 }), RangeError);
  assert.throws(() => observationView(full, { detail: 'summary', afterCursor: null }), RangeError);
});

test('full.cursor must be nonnegative safe integer in summary mode', () => {
  assert.throws(() => observationView({ state: 'running' }, { detail: 'summary' }), RangeError);
  assert.throws(() => observationView({ cursor: -2, state: 'running' }, { detail: 'summary' }), RangeError);
  assert.throws(() => observationView({ cursor: 2.5, state: 'running' }, { detail: 'summary' }), RangeError);
  assert.throws(() => observationView({ cursor: Infinity, state: 'running' }, { detail: 'summary' }), RangeError);
  assert.doesNotThrow(() => observationView({ cursor: 0, state: 'running' }, { detail: 'summary', afterCursor: 0 }));
});

test('summary does not mutate supplied object or arrays', () => {
  const full = {
    cursor: 9, state: 'running', toolEventsOmitted: 2, pendingApprovals: ['a'], question: 'hi', terminal: false,
    toolEvents: [fail(4), fail(8)],
    messages: [{ seq: 8, content: [{ type: 'text', text: 'x'.repeat(700) }] }],
  };
  const snapshot = JSON.parse(JSON.stringify(full));
  observationView(full, { detail: 'summary', afterCursor: 5 });
  assert.deepEqual(JSON.parse(JSON.stringify(full)), snapshot);
  assert.equal(full.toolEvents[0].data.isError, true);
  assert.equal(full.messages[0].content[0].text.length, 700);
});

test('latest message truncated at 600 with explicit flag', () => {
  const full = { cursor: 2, state: 'running', messages: [{ seq: 2, content: [{ type: 'text', text: 'y'.repeat(700) }] }] };
  const r = observationView(full, { detail: 'summary' });
  assert.equal(r.latestMessage.text.length, 600);
  assert.equal(r.latestMessage.truncated, true);
  assert.equal(r.latestMessage.seq, 2);
});

test('no repeated old message and no latest when unchanged', () => {
  const full = { cursor: 2, state: 'running', messages: [{ seq: 2, content: [{ type: 'text', text: 'old' }] }] };
  const r = observationView(full, { detail: 'summary', afterCursor: 2 });
  assert.equal('latestMessage' in r, false);
});

test('unchanged observation preserves pending approvals and terminal state', () => {
  const full = { cursor: 2, state: 'running', pendingApprovals: ['open'], question: 'ask?', done: false, blockedReason: undefined };
  const r = observationView(full, { detail: 'summary', afterCursor: 2 });
  assert.equal(r.changed, false);
  assert.deepEqual(r.pendingApprovals, ['open']);
  assert.equal(r.question, 'ask?');
  assert.equal(r.done, false);
  assert.equal('latestMessage' in r, false);
});

test('changed summary still carries essential fields', () => {
  const full = { cursor: 3, state: 'blocked', blockedReason: 'x', owner: 'me', pendingApprovals: ['y'] };
  const r = observationView(full, { detail: 'summary', afterCursor: 1 });
  assert.equal(r.state, 'blocked');
  assert.equal(r.blockedReason, 'x');
  assert.equal(r.owner, 'me');
  assert.equal(r.changed, true);
});
