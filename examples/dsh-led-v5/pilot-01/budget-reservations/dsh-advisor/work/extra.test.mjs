// Extra edge-case tests for budget.mjs (kept separate from visible.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBudget,
  reserve,
  settle,
  release,
  snapshot,
} from './budget.mjs';

test('idempotent reserve replay never double-holds', () => {
  const s = createBudget(100);
  reserve(s, 'op', 30);
  reserve(s, 'op', 30); // replay while held
  assert.equal(snapshot(s).reserved, 30);
  assert.equal(snapshot(s).available, 70);
});

test('reserve replay after settle and after release are no-ops', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  settle(s, 'a', 25);
  reserve(s, 'a', 30); // replay after settle
  assert.deepEqual(snapshot(s), { limit: 100, spent: 25, reserved: 0, available: 75, overdrawn: false });

  reserve(s, 'b', 40);
  release(s, 'b');
  reserve(s, 'b', 40); // replay after release: does NOT re-hold
  assert.deepEqual(snapshot(s), { limit: 100, spent: 25, reserved: 0, available: 75, overdrawn: false });
});

test('changed amount on replay is reuse for a different operation and throws', () => {
  const s = createBudget(100);
  reserve(s, 'op', 30);
  assert.throws(() => reserve(s, 'op', 31), /different operation/);
  // state untouched
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 30, available: 70, overdrawn: false });
  // same rule after settle / release
  settle(s, 'op', 20);
  assert.throws(() => reserve(s, 'op', 21), /different/);
  reserve(s, 'op2', 10);
  release(s, 'op2');
  assert.throws(() => reserve(s, 'op2', 11), /different/);
});

test('new reservation exceeding available throws without changing state', () => {
  const s = createBudget(100);
  reserve(s, 'a', 70);
  const before = snapshot(s);
  assert.throws(() => reserve(s, 'b', 31), /exceeds available/);
  assert.throws(() => reserve(s, 'b', 1000), /exceeds available/);
  assert.deepEqual(snapshot(s), before);
});

test('multiple holds reduce available additively', () => {
  const s = createBudget(100);
  reserve(s, 'a', 40);
  reserve(s, 'b', 60);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 100, available: 0, overdrawn: false });
  assert.throws(() => reserve(s, 'c', 1), /exceeds available/);
});

test('zero-value new reservation allowed while not overdrawn', () => {
  const s = createBudget(100);
  reserve(s, 'z', 0);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 0, available: 100, overdrawn: false });
  settle(s, 'z', 0);
  assert.equal(snapshot(s).spent, 0);
});

test('settle may exceed reservation and total limit; overdrawn set; zero reserve rejected', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  settle(s, 'a', 250); // far over both reservation and limit
  assert.deepEqual(snapshot(s), { limit: 100, spent: 250, reserved: 0, available: 0, overdrawn: true });
  assert.throws(() => reserve(s, 'b', 0), /overdrawn/); // even zero rejected
  assert.throws(() => reserve(s, 'b', 5), /overdrawn/);
  assert.throws(() => reserve(s, 'c', 100), /overdrawn/);
  assert.deepEqual(snapshot(s).reserved, 0); // still nothing held
});

test('overdrawn from settle + other active holds, then release un-overdraws', () => {
  const s = createBudget(100);
  reserve(s, 'a', 40);
  reserve(s, 'b', 60);
  settle(s, 'a', 70); // spent 70, reserved 60 => overdrawn
  assert.deepEqual(snapshot(s), { limit: 100, spent: 70, reserved: 60, available: 0, overdrawn: true });
  release(s, 'b');
  assert.deepEqual(snapshot(s), { limit: 100, spent: 70, reserved: 0, available: 30, overdrawn: false });
  reserve(s, 'c', 30); // fits again
  assert.equal(snapshot(s).available, 0);
});

test('settle frees only its own hold and records full actual', () => {
  const s = createBudget(100);
  reserve(s, 'a', 80);
  reserve(s, 'b', 20);
  settle(s, 'a', 5); // actual below reservation frees the whole 80 hold
  assert.deepEqual(snapshot(s), { limit: 100, spent: 5, reserved: 20, available: 75, overdrawn: false });
});

test('settle idempotent only for the exact same actual', () => {
  const s = createBudget(100);
  reserve(s, 'op', 40);
  settle(s, 'op', 33);
  const after = snapshot(s);
  settle(s, 'op', 33); // replay ok
  assert.deepEqual(snapshot(s), after);
  assert.throws(() => settle(s, 'op', 34), /already settled/);
  assert.throws(() => settle(s, 'op', 32), /already settled/);
  assert.deepEqual(snapshot(s), after); // unchanged
  // replay reserve between settles does not disturb idempotency
  reserve(s, 'op', 40);
  settle(s, 'op', 33);
  assert.deepEqual(snapshot(s), after);
});

test('settle rejects released or unknown ids', () => {
  const s = createBudget(100);
  reserve(s, 'gone', 10);
  release(s, 'gone');
  assert.throws(() => settle(s, 'gone', 10), /released/);
  assert.throws(() => settle(s, 'never-reserved', 1), /unknown/);
  assert.throws(() => release(s, 'never-reserved'), /unknown/);
  assert.throws(() => settle(s, 'never-reserved', 0), /unknown/);
});

test('release frees hold, repeats idempotently, rejects settled', () => {
  const s = createBudget(100);
  reserve(s, 'a', 25);
  reserve(s, 'b', 25);
  release(s, 'a');
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 25, available: 75, overdrawn: false });
  release(s, 'a'); // idempotent
  assert.equal(snapshot(s).reserved, 25);
  settle(s, 'b', 25);
  assert.throws(() => release(s, 'b'), /already settled/);
});

test('settled id cannot be released and released id cannot be settled (both directions)', () => {
  const s = createBudget(100);
  reserve(s, 'x', 10);
  settle(s, 'x', 9);
  assert.throws(() => release(s, 'x'), /already settled/);
  reserve(s, 'y', 10);
  release(s, 'y');
  assert.throws(() => settle(s, 'y', 9), /released/);
});

test('JSON round-trip preserves unresolved holds and full behavior', () => {
  const s = createBudget(100);
  reserve(s, 'in-flight', 60);
  const revived = JSON.parse(JSON.stringify(s));
  assert.deepEqual(snapshot(revived), { limit: 100, spent: 0, reserved: 60, available: 40, overdrawn: false });
  // unresolved reservation still blocks spend after "restart"
  assert.throws(() => reserve(revived, 'other', 41), /exceeds available/);
  settle(revived, 'in-flight', 60);
  assert.deepEqual(snapshot(revived), { limit: 100, spent: 60, reserved: 0, available: 40, overdrawn: false });
  // replay messages across a restart are still recognized
  settle(revived, 'in-flight', 60);
  reserve(revived, 'in-flight', 60);
  assert.deepEqual(snapshot(revived), { limit: 100, spent: 60, reserved: 0, available: 40, overdrawn: false });
});

test('exotic ids survive JSON and never corrupt state', () => {
  const s = createBudget(100);
  for (const id of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
    reserve(s, id, 10);
  }
  const revived = JSON.parse(JSON.stringify(s));
  assert.equal(snapshot(revived).reserved, 40);
  settle(revived, '__proto__', 10);
  release(revived, 'hasOwnProperty');
  assert.deepEqual(JSON.parse(JSON.stringify({ a: 1 })), { a: 1 }); // no pollution
  const recs = revived.reservations.filter((r) => r.status === 'held');
  assert.equal(recs.length, 2);
});

test('snapshot exposes no mutable internals', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  const snap1 = snapshot(s);
  snap1.limit = 0;
  snap1.spent = 0;
  snap1.reserved = 0;
  snap1.available = 1000;
  snap1.overdrawn = false;
  snap1.extra = 'hack';
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 30, available: 70, overdrawn: false });
  assert.deepEqual(Object.keys(snapshot(s)), ['limit', 'spent', 'reserved', 'available', 'overdrawn']);
});

test('createBudget rejects invalid limits', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '100', null, undefined, {}, []]) {
    assert.throws(() => createBudget(bad), TypeError);
  }
  assert.doesNotThrow(() => createBudget(0));
  assert.doesNotThrow(() => createBudget(Number.MAX_SAFE_INTEGER));
});

test('invalid ids and amounts are rejected without changing state', () => {
  const s = createBudget(100);
  const before = snapshot(s);
  for (const badId of ['', null, undefined, 42, {}, [], Symbol('x')]) {
    assert.throws(() => reserve(s, badId, 10), TypeError);
    assert.throws(() => settle(s, badId, 10), TypeError);
    assert.throws(() => release(s, badId), TypeError);
  }
  for (const badAmount of [-1, 1.5, NaN, Infinity, '10', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => reserve(s, 'op', badAmount), TypeError);
    assert.throws(() => settle(s, 'op', badAmount), TypeError);
  }
  assert.deepEqual(snapshot(s), before);
  assert.equal(s.reservations.length, 0);
});

test('unsafe arithmetic on settle is rejected without changing state', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const s = createBudget(max);
  reserve(s, 'x', 0);
  settle(s, 'x', max - 1); // spent = MAX_SAFE - 1
  reserve(s, 'y', 1);
  settle(s, 'y', 1); // spent = MAX_SAFE
  reserve(s, 'z', 0);
  const before = snapshot(s);
  assert.throws(() => settle(s, 'z', 1), RangeError); // would push spent past MAX_SAFE
  assert.deepEqual(snapshot(s), before);
  settle(s, 'z', 0); // still usable
  assert.equal(snapshot(s).spent, max);
});

test('whitespace id is still a valid nonempty string', () => {
  const s = createBudget(50);
  reserve(s, ' ', 1);
  assert.equal(snapshot(s).reserved, 1);
});

test('available stays floored at zero while overdrawn', () => {
  const s = createBudget(10);
  reserve(s, 'a', 5);
  reserve(s, 'b', 5);
  settle(s, 'a', 20); // overdrawn: spent 20 + reserved 5 > 10
  const snap = snapshot(s);
  assert.equal(snap.available, 0);
  assert.equal(snap.overdrawn, true);
  settle(s, 'b', 5); // settle a pre-existing hold -> even more overdrawn
  const snap2 = snapshot(s);
  assert.equal(snap2.available, 0);
  assert.equal(snap2.spent, 25);
  assert.equal(snap2.overdrawn, true);
});

test('replayed reserve while overdrawn is still idempotent (not a new hold)', () => {
  const s = createBudget(100);
  reserve(s, 'a', 100);
  settle(s, 'a', 150); // overdrawn, spent 150
  reserve(s, 'a', 100); // replay of the settled reservation
  assert.deepEqual(snapshot(s), { limit: 100, spent: 150, reserved: 0, available: 0, overdrawn: true });
});

test('all operations are pure functions over the passed state object', () => {
  const s = createBudget(200);
  reserve(s, 'one', 50);
  reserve(s, 'two', 70);
  assert.equal(snapshot(s).available, 80);
  settle(s, 'one', 40);
  assert.equal(snapshot(s).available, 90);
  release(s, 'two');
  assert.deepEqual(snapshot(s), { limit: 200, spent: 40, reserved: 0, available: 160, overdrawn: false });
});
