import test from 'node:test';
import assert from 'node:assert/strict';
import { observationView } from './observation.mjs';

const summary = (full, afterCursor) => observationView(full, { detail: 'summary', afterCursor });
const toolEvents = [
  { seq: 0, data: { isError: true } },
  { seq: 2, data: { error: 'failed' } },
  { seq: 3, data: { isError: false } },
  { seq: 4, data: { isError: true } },
  { seq: 5 },
];

test('failures are incremental, while failureSeen covers all supplied events', () => {
  const full = { cursor: 5, toolEvents };
  assert.deepEqual(summary(full).recentToolFailures, [toolEvents[0], toolEvents[1], toolEvents[3]]);
  assert.deepEqual(summary(full, 0).recentToolFailures, [toolEvents[1], toolEvents[3]]);
  assert.deepEqual(summary(full, 2).recentToolFailures, [toolEvents[3]]);
  for (const cursor of [4, 5]) {
    const result = summary(full, cursor);
    assert.equal(Object.hasOwn(result, 'recentToolFailures'), false);
    assert.equal(result.failureSeen, true);
  }
});

test('coverage describes omitted history without inventing failures', () => {
  for (const omitted of [undefined, 0, 3]) {
    for (const events of [undefined, [], [toolEvents[2]], [toolEvents[0]]]) {
      const result = summary({ cursor: 5, toolEvents: events, toolEventsOmitted: omitted }, 5);
      assert.equal(result.failureCoverage, omitted > 0 ? 'partial' : 'complete');
      assert.equal(result.failureSeen === true, events?.[0] === toolEvents[0]);
      assert.equal(Object.hasOwn(result, 'recentToolFailures'), false);
      assert.equal(Object.hasOwn(result, 'toolEventsOmitted'), false);
      assert.equal(result.evidenceAvailable.toolEvents, (events?.length ?? 0) + (omitted ?? 0));
    }
  }
});

test('summary validates both cursors', () => {
  const invalid = [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null, true, {}, 2n];
  for (const cursor of [...invalid, undefined]) {
    assert.throws(() => summary({ cursor }), RangeError);
  }
  for (const afterCursor of [...invalid, 6]) {
    assert.throws(() => summary({ cursor: 5 }, afterCursor), RangeError);
  }
  for (const cursor of [0, Number.MAX_SAFE_INTEGER]) {
    assert.equal(summary({ cursor }, cursor).changed, false);
    assert.equal(summary({ cursor }).changed, true);
  }
});

test('full detail preserves identity and bypasses summary validation', () => {
  const full = { cursor: -1, toolEvents };
  assert.equal(observationView(full), full);
  assert.equal(observationView(full, { detail: 'full', afterCursor: Infinity }), full);
});

test('unchanged summary preserves essential fields, blockers, and terminal evidence', () => {
  const full = {
    cursor: 5, state: 'completed', owner: 'worker', terminalEvidence: { exitCode: 0 },
    pendingApprovals: [{ id: 'approval' }], pendingQuestions: [{ id: 'question' }],
    messages: [], toolEvents, recentEventTypes: ['tool'], observationNote: 'verbose',
  };
  const result = summary(full, 5);
  for (const key of ['cursor', 'state', 'owner', 'terminalEvidence', 'pendingApprovals', 'pendingQuestions']) {
    assert.deepEqual(result[key], full[key]);
  }
  assert.equal(result.changed, false);
  assert.equal(result.viewDetail, 'summary');
  assert.equal(result.failureSeen, true);
  for (const key of ['messages', 'toolEvents', 'recentEventTypes', 'observationNote', 'latestMessage']) {
    assert.equal(Object.hasOwn(result, key), false);
  }
});

test('latest message is bounded with explicit truncation and is not repeated', () => {
  for (const length of [1, 600, 601]) {
    const full = { cursor: 8, messages: [{ seq: 7, content: [{ type: 'text', text: 'x'.repeat(length) }] }] };
    for (const cursor of [undefined, 6]) {
      assert.deepEqual(summary(full, cursor).latestMessage, {
        seq: 7, text: 'x'.repeat(Math.min(length, 600)), truncated: length > 600,
      });
    }
    for (const cursor of [7, 8]) assert.equal(Object.hasOwn(summary(full, cursor), 'latestMessage'), false);
  }
  assert.equal(Object.hasOwn(summary({ cursor: 0, messages: [] }), 'latestMessage'), false);
});

test('summary does not mutate frozen inputs or arrays', () => {
  const full = {
    cursor: 5, toolEvents: structuredClone(toolEvents), toolEventsOmitted: 2,
    messages: [{ seq: 5, content: [{ type: 'text', text: 'hello' }] }],
    pendingApprovals: [{ id: 'a' }], pendingQuestions: [{ id: 'q' }],
  };
  const before = structuredClone(full);
  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }
  freeze(full);
  for (const cursor of [undefined, 0, 4, 5]) summary(full, cursor);
  assert.deepEqual(full, before);
});
