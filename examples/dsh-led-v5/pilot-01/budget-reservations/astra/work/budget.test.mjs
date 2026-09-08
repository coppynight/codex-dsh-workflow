import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudget, reserve, settle, release, snapshot } from './budget.mjs';

function unchangedOnError(state, action) {
  const before = JSON.stringify(state);
  assert.throws(action);
  assert.equal(JSON.stringify(state), before);
}

test('completed IDs replay but never create another hold or charge', () => {
  const state = createBudget(100);
  reserve(state, 'a', 30);
  reserve(state, 'a', 30);
  settle(state, 'a', 20);
  const before = JSON.stringify(state);
  reserve(state, 'a', 30);
  settle(state, 'a', 20);
  assert.equal(JSON.stringify(state), before);
  unchangedOnError(state, () => reserve(state, 'a', 20));
  unchangedOnError(state, () => settle(state, 'a', 21));
  unchangedOnError(state, () => release(state, 'a'));
  reserve(state, 'b', 40);
  release(state, 'b');
  release(state, 'b');
  reserve(state, 'b', 40);
  unchangedOnError(state, () => settle(state, 'b', 0));
  unchangedOnError(state, () => reserve(state, 'b', 0));
  assert.equal(snapshot(state).reserved, 0);
});

test('overruns include unresolved holds and block new zero reservations', () => {
  const state = createBudget(100);
  reserve(state, 'a', 50);
  reserve(state, 'b', 50);
  settle(state, 'a', 80);
  assert.deepEqual(snapshot(state), { limit: 100, spent: 80, reserved: 50, available: 0, overdrawn: true });
  reserve(state, 'a', 50);
  reserve(state, 'b', 50);
  unchangedOnError(state, () => reserve(state, 'zero', 0));
  release(state, 'b');
  reserve(state, 'zero', 0);
  settle(state, 'zero', 70);
  assert.deepEqual(snapshot(state), { limit: 100, spent: 150, reserved: 0, available: 0, overdrawn: true });
});

test('restart preserves unresolved holds and completed operation history', () => {
  let state = createBudget(10);
  reserve(state, '__proto__', 7);
  reserve(state, 'constructor', 1);
  release(state, 'constructor');
  state = JSON.parse(JSON.stringify(state));
  assert.equal(snapshot(state).available, 3);
  unchangedOnError(state, () => reserve(state, 'new', 4));
  reserve(state, 'constructor', 1);
  assert.equal(snapshot(state).reserved, 7);
  settle(state, '__proto__', 9);
  state = JSON.parse(JSON.stringify(state));
  settle(state, '__proto__', 9);
  assert.equal(snapshot(state).spent, 9);
  const view = snapshot(state);
  view.spent = 0;
  assert.equal(snapshot(state).spent, 9);
});

test('invalid inputs and unsafe arithmetic never change state', () => {
  const invalid = [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined, 1n];
  const state = createBudget(10);
  reserve(state, 'a', 1);
  for (const value of invalid) {
    assert.throws(() => createBudget(value));
    unchangedOnError(state, () => reserve(state, 'b', value));
    unchangedOnError(state, () => settle(state, 'a', value));
  }
  for (const id of ['', 1, null, undefined, {}, []]) {
    unchangedOnError(state, () => reserve(state, id, 0));
    unchangedOnError(state, () => settle(state, id, 0));
    unchangedOnError(state, () => release(state, id));
  }
  unchangedOnError(state, () => settle(state, 'missing', 0));
  unchangedOnError(state, () => release(state, 'missing'));
  const huge = createBudget(Number.MAX_SAFE_INTEGER);
  reserve(huge, 'a', 0);
  reserve(huge, 'b', 1);
  unchangedOnError(huge, () => settle(huge, 'a', Number.MAX_SAFE_INTEGER));
  release(huge, 'b');
  settle(huge, 'a', Number.MAX_SAFE_INTEGER);
  reserve(huge, 'c', 0);
  unchangedOnError(huge, () => settle(huge, 'c', 1));
});

test('zero budget and exact exhaustion are not overdrawn', () => {
  const state = createBudget(0);
  reserve(state, 'a', 0);
  settle(state, 'a', 0);
  reserve(state, 'b', 0);
  assert.deepEqual(snapshot(state), { limit: 0, spent: 0, reserved: 0, available: 0, overdrawn: false });
  unchangedOnError(state, () => reserve(state, 'c', 1));
});
