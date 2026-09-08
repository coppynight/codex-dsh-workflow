import test from 'node:test';
import assert from 'node:assert/strict';
import { observationView } from './observation.mjs';

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

const base = (extra = {}) => ({
  cursor: 10,
  state: 'running',
  toolEvents: [
    { seq: 1, data: { isError: true } },       // old failure (already reported at cursor 10)
    { seq: 5, data: { ok: true } },
    { seq: 7, data: { error: 'boom' } },        // new failure
    { seq: 9, data: {} },
  ],
  messages: [{ seq: 8, content: [{ type: 'text', text: 'hello' }] }],
  toolEventsOmitted: 0,
  ...extra,
});

test('recentToolFailures keeps only failures with seq > afterCursor', () => {
  const full = base();
  const r = observationView(full, { detail: 'summary', afterCursor: 5 });
  assert.deepEqual(r.recentToolFailures.map((e) => e.seq), [7]);
});

test('recentToolFailures includes all failures when no cursor', () => {
  const full = base();
  const r = observationView(full, { detail: 'summary' });
  assert.deepEqual(r.recentToolFailures.map((e) => e.seq).sort(), [1, 7]);
});

test('recentToolFailures omitted when no failures are new', () => {
  const full = base({ cursor: 7 }); // cursor high enough that failure seq 7 is not "new"
  const r = observationView(full, { detail: 'summary', afterCursor: 7 });
  assert.equal('recentToolFailures' in r, false);
  assert.equal(r.recentToolFailures, undefined);
});

test('recentToolFailures omitted when there are no failures at all', () => {
  const full = { cursor: 3, state: 'running', toolEvents: [{ seq: 3, data: { ok: true } }], messages: [] };
  const r = observationView(full, { detail: 'summary' });
  assert.equal('recentToolFailures' in r, false);
});

test('failureSeen=true when any supplied event failed, even if already reported', () => {
  // failure seq 1 is <= afterCursor (already reported) but still counts.
  const full = base();
  const r = observationView(full, { detail: 'summary', afterCursor: 7 });
  assert.equal(r.failureSeen, true);
  // and no *new* failures should be listed
  assert.equal('recentToolFailures' in r, false);
});

test('failureSeen omitted when no supplied event failed', () => {
  const full = { cursor: 3, state: 'running', toolEvents: [{ seq: 3, data: { ok: true } }], messages: [] };
  const r = observationView(full, { detail: 'summary' });
  assert.equal('failureSeen' in r, false);
});

test('failureCoverage partial when toolEventsOmitted > 0, complete otherwise', () => {
  assert.equal(observationView(base({ toolEventsOmitted: 3 }), { detail: 'summary' }).failureCoverage, 'partial');
  assert.equal(observationView(base({ toolEventsOmitted: 0 }), { detail: 'summary' }).failureCoverage, 'complete');
  assert.equal(observationView(base(), { detail: 'summary' }).failureCoverage, 'complete');
});

test('failureCoverage reflects only supplied window (no claim omitted history checked)', () => {
  const r = observationView(base({ toolEventsOmitted: 5 }), { detail: 'summary', afterCursor: 0 });
  assert.equal(r.failureCoverage, 'partial');
  assert.equal('toolEventsOmitted' in r, false);
});

test('preserves pending approvals/questions and terminal state (unchanged observation)', () => {
  const full = base({
    cursor: 7,
    pendingApprovals: ['grantRead', 'grantWrite'],
    pendingQuestions: ['which path?'],
    status: 'blocked',
    blockerReason: 'needs approval',
    toolEventsOmitted: 0,
  });
  const r = observationView(full, { detail: 'summary', afterCursor: 7 }); // unchanged (afterCursor === cursor)
  assert.equal(r.changed, false);
  assert.deepEqual(r.pendingApprovals, ['grantRead', 'grantWrite']);
  assert.deepEqual(r.pendingQuestions, ['which path?']);
  assert.equal(r.status, 'blocked');
  assert.equal(r.blockerReason, 'needs approval');
  assert.equal(r.state, 'running');
  assert.equal(r.cursor, 7);
});

test('summary does not mutate supplied object or arrays', () => {
  const full = deepFreeze({
    cursor: 3,
    state: 'running',
    toolEvents: [{ seq: 3, data: { isError: true } }],
    messages: [{ seq: 3, content: [{ type: 'text', text: 'hi' }] }],
    toolEventsOmitted: 0,
    pendingApprovals: ['x'],
  });
  assert.doesNotThrow(() => observationView(full, { detail: 'summary', afterCursor: 2 }));
});

test('afterCursor validation throws RangeError', () => {
  const full = base({ cursor: 5 });
  const opts = (ac) => ({ detail: 'summary', afterCursor: ac });
  assert.throws(() => observationView(full, opts(6)), RangeError); // > cursor
  assert.throws(() => observationView(full, opts(-1)), RangeError);
  assert.throws(() => observationView(full, opts(1.5)), RangeError);
  assert.throws(() => observationView(full, opts(NaN)), RangeError);
  assert.throws(() => observationView(full, opts('3')), RangeError);
  // equal to cursor is allowed
  assert.doesNotThrow(() => observationView(full, opts(5)));
});

test('full.cursor validation throws RangeError in summary mode', () => {
  for (const bad of [-1, 1.5, NaN, undefined, null, '3']) {
    const full = { cursor: bad, state: 'running', toolEvents: [], messages: [] };
    assert.throws(() => observationView(full, { detail: 'summary' }), RangeError, `cursor=${bad}`);
  }
  assert.doesNotThrow(() => observationView({ cursor: 0, state: 'running', toolEvents: [], messages: [] }, { detail: 'summary' }));
});

test('detail=full returns the object unchanged and skips validation', () => {
  const a = { cursor: -5, state: 'running', toolEvents: [{ seq: 1, data: { isError: true } }] };
  assert.equal(observationView(a), a);
  assert.equal(observationView(a, { afterCursor: 999 }), a); // invalid cursor not checked in full mode
});

test('latest message: 600 char cap with explicit truncated flag', () => {
  const text = 'a'.repeat(700);
  const full = { cursor: 1, state: 'running', toolEvents: [], messages: [{ seq: 1, content: [{ type: 'text', text }] }] };
  const r = observationView(full, { detail: 'summary' });
  assert.equal(r.latestMessage.text.length, 600);
  assert.equal(r.latestMessage.truncated, true);
  assert.equal(r.latestMessage.seq, 1);
});

test('no repeated old message when afterCursor already covers the latest seq', () => {
  const full = { cursor: 1, state: 'running', toolEvents: [], messages: [{ seq: 1, content: [{ type: 'text', text: 'old' }] }] };
  const r = observationView(full, { detail: 'summary', afterCursor: 1 });
  assert.equal('latestMessage' in r, false);
});

test('no latestMessage when latest message is non-text only', () => {
  const full = { cursor: 1, state: 'running', toolEvents: [], messages: [{ seq: 1, content: [{ type: 'tool_use', id: 'x' }] }] };
  const r = observationView(full, { detail: 'summary' });
  assert.equal('latestMessage' in r, false);
});
