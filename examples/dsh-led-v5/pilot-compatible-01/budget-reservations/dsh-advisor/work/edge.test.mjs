import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBudget,
  reserve,
  settle,
  release,
  snapshot,
} from './budget.mjs';

function throws(fn, re) {
  assert.throws(fn, re);
}

test('reserve exceeds available throws without change', () => {
  const s = createBudget(100);
  reserve(s, 'a', 60);
  const before = snapshot(s);
  throws(() => reserve(s, 'b', 60), /exceeds available/);
  assert.deepEqual(snapshot(s), before);
});

test('reserve equal to available is allowed', () => {
  const s = createBudget(100);
  reserve(s, 'a', 60);
  reserve(s, 'b', 40);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 100, available: 0, overdrawn: false });
});

test('reserve idempotent replay same id+amount', () => {
  const s = createBudget(100);
  reserve(s, 'x', 30);
  const snap1 = snapshot(s);
  reserve(s, 'x', 30); // replay
  assert.deepEqual(snapshot(s), snap1);
});

test('reserve replay after settle does not re-add a hold', () => {
  const s = createBudget(100);
  reserve(s, 'x', 30);
  settle(s, 'x', 20);
  reserve(s, 'x', 30); // replay, no new hold
  assert.deepEqual(snapshot(s), { limit: 100, spent: 20, reserved: 0, available: 80, overdrawn: false });
});

test('reserve replay after release does not re-add a hold', () => {
  const s = createBudget(100);
  reserve(s, 'x', 30);
  release(s, 'x');
  reserve(s, 'x', 30); // replay, no new hold
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 0, available: 100, overdrawn: false });
});

test('changed amount on same id throws', () => {
  const s = createBudget(100);
  reserve(s, 'x', 30);
  throws(() => reserve(s, 'x', 31), /different amount/);
});

test('settle idempotent only for same actual', () => {
  const s = createBudget(100);
  reserve(s, 'x', 30);
  settle(s, 'x', 20);
  const snap = snapshot(s);
  settle(s, 'x', 20); // same actual -> no-op
  assert.deepEqual(snapshot(s), snap);
  throws(() => settle(s, 'x', 25), /different amount/);
});

test('settle rejects unknown and released', () => {
  const s = createBudget(100);
  reserve(s, 'a', 10);
  release(s, 'a');
  throws(() => settle(s, 'a', 5), /released/);
  throws(() => settle(s, 'nope', 5), /unknown/);
});

test('release frees hold and rejects already-settled id; repeats idempotent', () => {
  const s = createBudget(100);
  reserve(s, 'a', 40);
  release(s, 'a');
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 0, available: 100, overdrawn: false });
  release(s, 'a'); // idempotent repeat
  assert.deepEqual(snapshot(s).available, 100);
  reserve(s, 'b', 20);
  settle(s, 'b', 10);
  throws(() => release(s, 'b'), /settled/);
  throws(() => release(s, 'unknown'), /unknown/);
});

test('actual may exceed reservation and total limit (overdrawn)', () => {
  const s = createBudget(100);
  reserve(s, 'one', 30);
  settle(s, 'one', 150);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 150, reserved: 0, available: 0, overdrawn: true });
});

test('overdrawn from spent+reserved blocks new reservations incl zero', () => {
  const s = createBudget(100);
  reserve(s, 'a', 80);
  reserve(s, 'b', 20);
  // settle a with large actual -> overdrawn while b still held
  settle(s, 'a', 200);
  assert.equal(snapshot(s).overdrawn, true);
  throws(() => reserve(s, 'c', 0), /overdrawn/);
  throws(() => reserve(s, 'c', 5), /overdrawn/);
});

test('settle frees hold; another remaining hold plus spent pushes overdrawn', () => {
  const s = createBudget(100);
  reserve(s, 'a', 40); // available -> 60
  reserve(s, 'b', 30); // available -> 30
  // settle 'a' for 90: spent 90 + reserved 30 = 120 > 100 => overdrawn
  settle(s, 'a', 90);
  assert.equal(snapshot(s).overdrawn, true);
  assert.equal(snapshot(s).reserved, 30);
  assert.equal(snapshot(s).available, 0);
  // new reservations (incl zero) rejected
  throws(() => reserve(s, 'c', 0), /overdrawn/);
  throws(() => reserve(s, 'c', 5), /overdrawn/);
});

test('settle exactly at limit leaves not overdrawn, available zero', () => {
  const s = createBudget(50);
  reserve(s, 'h', 50);
  settle(s, 'h', 50);
  assert.deepEqual(snapshot(s), { limit: 50, spent: 50, reserved: 0, available: 0, overdrawn: false });
  // not overdrawn, but available is 0 so a nonzero new reserve is rejected
  throws(() => reserve(s, 'g', 10), /exceeds available/);
  // a zero-value reserve is allowed while not overdrawn
  reserve(s, 'g', 0);
});

test('settle while a different reservation still held -> overdrawn via spent', () => {
  const s = createBudget(100);
  reserve(s, 'x', 40);
  reserve(s, 'y', 30);
  // x settled for 90: spent 90 + reserved(y 30) = 120 > 100 -> overdrawn
  settle(s, 'x', 90);
  assert.equal(snapshot(s).overdrawn, true);
  assert.equal(snapshot(s).reserved, 30);
  assert.equal(snapshot(s).available, 0);
});

test('release restores available under overdrawn-residual not relevant', () => {
  const s = createBudget(100);
  reserve(s, 'x', 100);
  release(s, 'x');
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 0, available: 100, overdrawn: false });
});

test('invalid inputs rejected without state change', () => {
  const s = createBudget(100);
  const before = snapshot(s);
  throws(() => reserve(s, '', 10), TypeError);
  throws(() => reserve(s, 5, 10), TypeError);
  throws(() => reserve(s, 'a', -1), TypeError);
  throws(() => reserve(s, 'a', 1.5), TypeError);
  throws(() => reserve(s, 'a', NaN), TypeError);
  throws(() => reserve(s, 'a', Infinity), TypeError);
  throws(() => settle(s, 'a', -5), TypeError);
  throws(() => release(s, ''), TypeError);
  assert.deepEqual(snapshot(s), before);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 0, available: 100, overdrawn: false });
});

test('snapshot does not expose mutable internals', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  const snap = snapshot(s);
  assert.ok(!('records' in snap));
  assert.ok(!('holds' in snap));
  // Mutating the snapshot copy does not affect the budget.
  snap.spent = 9999;
  snap.available = 0;
  assert.equal(snapshot(s).spent, 0);
  assert.equal(snapshot(s).available, 70);
});

test('state is JSON-serializable and unresolved reservation survives restart', () => {
  const s = createBudget(100);
  reserve(s, 'remote', 40);
  const json = JSON.stringify(s);
  const restored = JSON.parse(json);
  // After restart the unresolved hold still blocks spend.
  assert.equal(restored.reserved, 40);
  assert.equal(restored.available, 60);
  // record integrity
  assert.equal(restored.records['remote'].reserve, 40);
  assert.equal(restored.records['remote'].active, true);
});

test('idempotent reserve across serialization keeps working', () => {
  const s = createBudget(100);
  reserve(s, 'r', 30);
  const restored = JSON.parse(JSON.stringify(s));
  reserve(restored, 'r', 30); // replay
  assert.equal(restored.reserved, 30);
  settle(restored, 'r', 25);
  assert.deepEqual(snapshot(restored), { limit: 100, spent: 25, reserved: 0, available: 75, overdrawn: false });
});

test('createBudget validates limit', () => {
  throws(() => createBudget(-1), TypeError);
  throws(() => createBudget(1.5), TypeError);
  throws(() => createBudget('100'), TypeError);
  const s = createBudget(0);
  assert.deepEqual(snapshot(s), { limit: 0, spent: 0, reserved: 0, available: 0, overdrawn: false });
  reserve(s, 'z', 0); // zero reservation on zero limit (not overdrawn) allowed
  assert.equal(snapshot(s).available, 0);
  settle(s, 'z', 0);
  assert.equal(snapshot(s).overdrawn, false);
});
