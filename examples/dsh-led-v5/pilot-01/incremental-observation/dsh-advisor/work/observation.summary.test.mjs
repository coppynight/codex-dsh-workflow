import test from 'node:test';
import assert from 'node:assert/strict';
import { observationView } from './observation.mjs';

const failure = (seq, over = {}) => ({ seq, data: { isError: true, ...over } });
const ok = (seq) => ({ seq, data: {} });
const msg = (seq, text) => ({ seq, content: [{ type: 'text', text }] });

test('detail=full returns the same reference and skips summary validation', () => {
  const full = { cursor: 'bogus', state: 'running' };
  assert.equal(observationView(full, { detail: 'full', afterCursor: 5 }), full);
  assert.equal(observationView(full), full);
});

test('recentToolFailures lists only fresh failures; failureSeen covers already-reported ones', () => {
  const full = { cursor: 5, state: 'running', toolEvents: [ok(1), failure(2), failure(4), ok(5)] };
  const r = observationView(full, { detail: 'summary', afterCursor: 3 });
  assert.equal(r.changed, true);
  assert.deepEqual(r.recentToolFailures.map((e) => e.seq), [4]);
  assert.equal(r.recentToolFailures[0], full.toolEvents[2]); // same event object, no copy
  assert.equal(r.failureSeen, true);
  assert.equal(r.failureCoverage, 'complete');
});

test('recentToolFailures omitted when failures exist but none are new; failureSeen still true', () => {
  const full = { cursor: 5, state: 'running', toolEvents: [failure(2), failure(3)] };
  const r = observationView(full, { detail: 'summary', afterCursor: 3 });
  assert.equal(r.changed, true);
  assert.ok(!('recentToolFailures' in r));
  assert.equal(r.failureSeen, true);
});

test('unchanged observation (afterCursor == cursor) keeps failureSeen but no fresh failures', () => {
  const full = { cursor: 4, state: 'running', toolEvents: [failure(3)] };
  const r = observationView(full, { detail: 'summary', afterCursor: 4 });
  assert.equal(r.changed, false);
  assert.notEqual(r, full);
  assert.ok(!('recentToolFailures' in r));
  assert.equal(r.failureSeen, true);
});

test('no cursor reports every supplied failure', () => {
  const full = { cursor: 5, state: 'running', toolEvents: [failure(1), ok(2), failure(3)] };
  const r = observationView(full, { detail: 'summary' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.recentToolFailures.map((e) => e.seq), [1, 3]);
  assert.equal(r.failureSeen, true);
});

test('no failures: recentToolFailures and failureSeen are both omitted', () => {
  const full = { cursor: 2, state: 'running', toolEvents: [ok(1), ok(2)] };
  const r = observationView(full, { detail: 'summary', afterCursor: 1 });
  assert.ok(!('recentToolFailures' in r));
  assert.ok(!('failureSeen' in r));
  assert.equal(r.failureCoverage, 'complete');
});

test('failureCoverage is partial when toolEventsOmitted > 0, complete otherwise', () => {
  const a = observationView({ cursor: 6, state: 'running', toolEvents: [failure(6)], toolEventsOmitted: 3 }, { detail: 'summary', afterCursor: 5 });
  assert.equal(a.failureCoverage, 'partial');
  assert.equal(a.evidenceAvailable.toolEvents, 4);
  assert.ok(!('toolEventsOmitted' in a)); // raw count stays folded into evidenceAvailable/failureCoverage

  const b = observationView({ cursor: 6, state: 'running', toolEvents: [failure(6)], toolEventsOmitted: 0 }, { detail: 'summary', afterCursor: 5 });
  assert.equal(b.failureCoverage, 'complete');

  const c = observationView({ cursor: 6, state: 'running', toolEvents: [ok(6)] }, { detail: 'summary', afterCursor: 5 });
  assert.equal(c.failureCoverage, 'complete');

  // 'partial' means we must not pretend omitted history was checked.
  const d = observationView({ cursor: 3, state: 'running', toolEvents: [ok(3)], toolEventsOmitted: 1 }, { detail: 'summary', afterCursor: 2 });
  assert.equal(d.failureCoverage, 'partial');
  assert.ok(!('recentToolFailures' in d));
});

test('failure detection honors data.isError or data.error only', () => {
  const full = {
    cursor: 5,
    state: 'running',
    toolEvents: [
      { seq: 1, data: { isError: true } },                 // failure
      { seq: 2, data: { error: 'boom' } },                 // failure
      { seq: 3, data: { isError: false, error: '' } },     // not a failure
      { seq: 4, data: {} },                                // not a failure
      { seq: 5 },                                          // no data: not a failure
    ],
  };
  const r = observationView(full, { detail: 'summary' });
  assert.deepEqual(r.recentToolFailures.map((e) => e.seq), [1, 2]);
  assert.equal(r.failureSeen, true);
});

test('fresh filter requires event.seq > afterCursor; seq-less failures are not fresh', () => {
  const full = {
    cursor: 6,
    state: 'running',
    toolEvents: [{ seq: 2, data: { error: 'old' } }, { data: { isError: true } }],
  };
  const r = observationView(full, { detail: 'summary', afterCursor: 3 });
  assert.ok(!('recentToolFailures' in r));
  assert.equal(r.failureSeen, true); // both supplied failures still count as seen
});

test('empty observation summaries cleanly', () => {
  const r = observationView({ cursor: 0, state: 'running' }, { detail: 'summary', afterCursor: 0 });
  assert.equal(r.changed, false);
  assert.equal(r.failureCoverage, 'complete');
  assert.ok(!('recentToolFailures' in r));
  assert.ok(!('failureSeen' in r));
  assert.ok(!('latestMessage' in r));
  assert.deepEqual(r.evidenceAvailable, { messages: 0, toolEvents: 0 });
});

test('afterCursor validation throws RangeError in summary mode', () => {
  const base = { cursor: 5, state: 'running', toolEvents: [] };
  for (const bad of [-1, NaN, 1.5, 2 ** 53, '3', null, {}, true]) {
    assert.throws(() => observationView(base, { detail: 'summary', afterCursor: bad }), RangeError, `afterCursor ${String(bad)}`);
  }
  assert.throws(() => observationView(base, { detail: 'summary', afterCursor: 6 }), RangeError); // > cursor
  assert.doesNotThrow(() => observationView(base, { detail: 'summary', afterCursor: 5 }));
  assert.doesNotThrow(() => observationView(base, { detail: 'summary', afterCursor: 0 }));
  assert.doesNotThrow(() => observationView(base, { detail: 'summary' }));
});

test('full.cursor validation throws RangeError in summary mode', () => {
  for (const bad of [undefined, -1, NaN, 1.5, 2 ** 53, '4', null]) {
    assert.throws(() => observationView({ cursor: bad }, { detail: 'summary' }), RangeError, `cursor ${String(bad)}`);
  }
  assert.doesNotThrow(() => observationView({ cursor: 0 }, { detail: 'summary' }));
});

test('pending approvals/questions and terminal state survive unchanged and changed summaries', () => {
  const unchanged = { cursor: 4, state: 'terminal', pendingApprovals: [{ id: 'a' }], pendingQuestions: [{ id: 'q' }], ownership: { id: 7 } };
  const ru = observationView(unchanged, { detail: 'summary', afterCursor: 4 });
  assert.equal(ru.changed, false);
  assert.equal(ru.state, 'terminal');
  assert.deepEqual(ru.pendingApprovals, [{ id: 'a' }]);
  assert.deepEqual(ru.pendingQuestions, [{ id: 'q' }]);
  assert.deepEqual(ru.ownership, { id: 7 });

  const changed = { cursor: 4, state: 'terminal', pendingApprovals: [], pendingQuestions: [] };
  const rc = observationView(changed, { detail: 'summary', afterCursor: 3 });
  assert.equal(rc.changed, true);
  assert.deepEqual(rc.pendingApprovals, []);
  assert.deepEqual(rc.pendingQuestions, []);
});

test('summary does not mutate the supplied observation or nested arrays', () => {
  const freezeDeep = (value) => {
    if (value && typeof value === 'object') {
      Object.freeze(value);
      for (const key of Object.keys(value)) freezeDeep(value[key]);
    }
    return value;
  };
  const full = freezeDeep({
    cursor: 4,
    state: 'running',
    toolEvents: [failure(2), failure(4)],
    messages: [msg(3, 'hi')],
    toolEventsOmitted: 1,
    pendingApprovals: [1],
  });
  const before = structuredClone(full);
  const r = observationView(full, { detail: 'summary', afterCursor: 2 });
  assert.deepEqual(full, before);
  assert.equal(r.changed, true);
  assert.deepEqual(r.recentToolFailures.map((e) => e.seq), [4]);
});

test('latestMessage truncates to 600 chars with explicit flag', () => {
  const long = 'x'.repeat(700);
  const r = observationView({ cursor: 1, state: 'running', messages: [msg(1, long)] }, { detail: 'summary' });
  assert.equal(r.latestMessage.seq, 1);
  assert.equal(r.latestMessage.text.length, 600);
  assert.equal(r.latestMessage.truncated, true);

  const exact = 'y'.repeat(600);
  const r2 = observationView({ cursor: 1, state: 'running', messages: [msg(1, exact)] }, { detail: 'summary' });
  assert.equal(r2.latestMessage.text.length, 600);
  assert.equal(r2.latestMessage.truncated, false);
});

test('latestMessage joins text parts only', () => {
  const r = observationView(
    { cursor: 1, state: 'running', messages: [{ seq: 1, content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] }] },
    { detail: 'summary' },
  );
  assert.equal(r.latestMessage.text, 'a\nb');
});

test('already-consumed latest message is not repeated', () => {
  const r = observationView({ cursor: 5, state: 'running', messages: [msg(3, 'old')] }, { detail: 'summary', afterCursor: 4 });
  assert.equal(r.changed, true);
  assert.ok(!('latestMessage' in r));
});

test('unchanged observation never reports a latestMessage', () => {
  const r = observationView({ cursor: 3, state: 'running', messages: [msg(3, 'seen')] }, { detail: 'summary', afterCursor: 3 });
  assert.equal(r.changed, false);
  assert.ok(!('latestMessage' in r));
});

test('no text messages means no latestMessage', () => {
  const r = observationView({ cursor: 1, state: 'running', messages: [] }, { detail: 'summary' });
  assert.ok(!('latestMessage' in r));
});

test('changed reflects cursor presence and comparison', () => {
  assert.equal(observationView({ cursor: 3, state: 'running' }, { detail: 'summary' }).changed, true);
  assert.equal(observationView({ cursor: 3, state: 'running' }, { detail: 'summary', afterCursor: 2 }).changed, true);
  assert.equal(observationView({ cursor: 3, state: 'running' }, { detail: 'summary', afterCursor: 3 }).changed, false);
});
