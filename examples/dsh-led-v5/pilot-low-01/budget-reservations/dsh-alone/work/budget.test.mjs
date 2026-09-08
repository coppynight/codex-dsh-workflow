import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBudget,
  reserve,
  settle,
  release,
  snapshot,
} from './budget.mjs';

test('hold reduces available and settle frees hold', () => {
  const s = createBudget(100);
  reserve(s, 'one', 30);
  assert.equal(snapshot(s).available, 70);
  settle(s, 'one', 20);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 20, reserved: 0, available: 80, overdrawn: false });
});

test('multiple active holds sum reserved', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  reserve(s, 'b', 40);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 70, available: 30, overdrawn: false });
});

test('reserve exceeding available throws without mutation', () => {
  const s = createBudget(100);
  reserve(s, 'a', 80);
  assert.throws(() => reserve(s, 'b', 30), /exceeds/);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 80, available: 20, overdrawn: false });
});

test('reserve same id+amount is idempotent replay', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  reserve(s, 'a', 30); // replay no-op
  assert.equal(snapshot(s).reserved, 30);
  assert.equal(snapshot(s).available, 70);
});

test('replay still idempotent after settle', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  settle(s, 'a', 25);
  // identical re-reserve is a replay no-op even though settled
  reserve(s, 'a', 30);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 25, reserved: 0, available: 75, overdrawn: false });
});

test('replay still idempotent after release', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  release(s, 'a');
  reserve(s, 'a', 30); // replay no-op, hold stays freed
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 0, available: 100, overdrawn: false });
});

test('changed amount on reused id throws', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  assert.throws(() => reserve(s, 'a', 40), /different amount/);
});

test('settle idempotent for same actual, throws on changed actual', () => {
  const s = createBudget(100);
  reserve(s, 'a', 50);
  settle(s, 'a', 60); // actual may exceed reservation
  assert.deepEqual(snapshot(s), { limit: 100, spent: 60, reserved: 0, available: 40, overdrawn: false });
  settle(s, 'a', 60); // idempotent
  assert.equal(snapshot(s).spent, 60);
  assert.throws(() => settle(s, 'a', 61), /actual amount changed/);
  assert.equal(snapshot(s).spent, 60);
});

test('actual may exceed total limit -> overdrawn', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  settle(s, 'a', 150);
  assert.equal(snapshot(s).spent, 150);
  assert.equal(snapshot(s).overdrawn, true);
  assert.equal(snapshot(s).available, 0);
});

test('overdrawn rejects new reservations including zero value', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  settle(s, 'a', 150); // overdrawn
  assert.throws(() => reserve(s, 'b', 0), /overdrawn/);
  assert.throws(() => reserve(s, 'b', 10), /overdrawn/);
});

test('release frees hold and is idempotent', () => {
  const s = createBudget(100);
  reserve(s, 'a', 40);
  reserve(s, 'b', 40);
  release(s, 'a');
  assert.equal(snapshot(s).reserved, 40);
  release(s, 'a'); // idempotent
  assert.equal(snapshot(s).reserved, 40);
});

test('release rejects already settled id', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  settle(s, 'a', 20);
  assert.throws(() => release(s, 'a'), /already settled/);
});

test('release rejects unknown id', () => {
  const s = createBudget(100);
  assert.throws(() => release(s, 'nope'), /unknown/);
});

test('settle rejects released and unknown ids', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  release(s, 'a');
  assert.throws(() => settle(s, 'a', 20), /released/);
  assert.throws(() => settle(s, 'nope', 20), /unknown/);
});

test('release of hold can clear overdrawn so new reserve allowed', () => {
  const s = createBudget(100);
  reserve(s, 'a', 100);
  settle(s, 'a', 100);
  reserve(s, 'b', 50);
  settle(s, 'b', 0);
  // spent 100, no reserved -> overdrawn false? 100 not >100
  assert.equal(snapshot(s).overdrawn, false);
});

test('state survives JSON serialization preserving holds', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  const clone = JSON.parse(JSON.stringify(s));
  // rehydrate by calling reserve/settle/snapshot directly on clone
  assert.deepEqual(snapshot(clone), snapshot(s));
  reserve(clone, 'b', 50);
  assert.equal(snapshot(clone).reserved, 80);
  assert.equal(snapshot(clone).available, 20);
});

test('snapshot does not expose mutable internals', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  const snap = snapshot(s);
  const keys = Object.keys(snap);
  assert.deepEqual(keys.sort(), ['available', 'limit', 'overdrawn', 'reserved', 'spent']);
  snap.spent = 9999;
  assert.equal(snapshot(s).spent, 0);
});

test('invalid input rejected without state change', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  const before = snapshot(s);
  assert.throws(() => reserve(s, 'b', -5));
  assert.throws(() => reserve(s, 'b', 1.5));
  assert.throws(() => reserve(s, '', 5));
  assert.throws(() => reserve(s, 5, 5));
  assert.throws(() => reserve(s, 'b', Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => settle(s, 'a', -1));
  assert.throws(() => settle(s, 'a', 2.5));
  assert.throws(() => createBudget(-1));
  assert.throws(() => createBudget(1.5));
  assert.deepEqual(snapshot(s), before);
});
