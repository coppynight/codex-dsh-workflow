import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBudget, reserve, settle, release, snapshot,
} from './budget.mjs';

// --- Lifecycle / math ---------------------------------------------------

test('hold reduces available and settle frees it', () => {
  const s = createBudget(100);
  reserve(s, 'one', 30);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 30, available: 70, overdrawn: false });
  settle(s, 'one', 20);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 20, reserved: 0, available: 80, overdrawn: false });
});

test('multiple simultaneous holds reduce reserved accordingly', () => {
  const s = createBudget(100);
  reserve(s, 'a', 40);
  reserve(s, 'b', 25);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 65, available: 35, overdrawn: false });
  settle(s, 'a', 40);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 40, reserved: 25, available: 35, overdrawn: false });
});

test('reservation exceeding available throws and leaves state unchanged', () => {
  const s = createBudget(50);
  reserve(s, 'a', 30);
  const before = snapshot(s);
  assert.throws(() => reserve(s, 'b', 21), /exceeds available/);
  assert.deepEqual(snapshot(s), before);
  // exactly at the limit still fits
  reserve(s, 'b', 20);
  assert.equal(snapshot(s).available, 0);
});

// --- Reserve idempotency / changed amount --------------------------------

test('same id+amount replay while held is a no-op', () => {
  const s = createBudget(100);
  reserve(s, 'one', 30);
  reserve(s, 'one', 30); // replay, still held
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 30, available: 70, overdrawn: false });
});

test('terminal ids cannot be resurrected: reserve after settle throws', () => {
  const s = createBudget(100);
  reserve(s, 'one', 30);
  settle(s, 'one', 20);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 20, reserved: 0, available: 80, overdrawn: false });
  // same amount: still rejected (no resurrection)
  assert.throws(() => reserve(s, 'one', 30), /cannot reserve again/);
  assert.throws(() => reserve(s, 'one', 31), /changed amount/);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 20, reserved: 0, available: 80, overdrawn: false });
});

test('terminal ids cannot be resurrected: reserve after release throws', () => {
  const s = createBudget(100);
  reserve(s, 'one', 30);
  release(s, 'one');
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 0, available: 100, overdrawn: false });
  assert.throws(() => reserve(s, 'one', 30), /cannot reserve again/);
  assert.equal(snapshot(s).reserved, 0);
});

test('changed amount for an active id throws', () => {
  const s = createBudget(100);
  reserve(s, 'one', 30);
  assert.throws(() => reserve(s, 'one', 31), /changed amount/);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 30, available: 70, overdrawn: false });
});

test('terminal idempotency: settle same actual and repeated release are no-ops', () => {
  const s = createBudget(100);
  reserve(s, 'x', 30);
  settle(s, 'x', 25);
  settle(s, 'x', 25); // terminal idempotent
  assert.equal(snapshot(s).spent, 25);
  assert.throws(() => release(s, 'x'), /settled/);
  const t = createBudget(100);
  reserve(t, 'y', 30);
  release(t, 'y');
  release(t, 'y'); // terminal idempotent
  assert.deepEqual(snapshot(t), { limit: 100, spent: 0, reserved: 0, available: 100, overdrawn: false });
  assert.throws(() => settle(t, 'y', 30), /released/);
});

// --- Settle semantics ----------------------------------------------------

test('settle actual may exceed reservation but stay under limit', () => {
  const s = createBudget(50);
  reserve(s, 'x', 20);
  settle(s, 'x', 40);
  assert.deepEqual(snapshot(s), { limit: 50, spent: 40, reserved: 0, available: 10, overdrawn: false });
});

test('settle may push total past the limit -> overdrawn', () => {
  const s = createBudget(100);
  reserve(s, 'x', 10);
  settle(s, 'x', 150);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 150, reserved: 0, available: 0, overdrawn: true });
});

test('settle idempotent only for the exact same actual', () => {
  const s = createBudget(100);
  reserve(s, 'x', 30);
  settle(s, 'x', 20);
  settle(s, 'x', 20); // exact replay: no-op, no double count
  assert.equal(snapshot(s).spent, 20);
  assert.throws(() => settle(s, 'x', 21), /differs from already-settled/);
  assert.equal(snapshot(s).spent, 20);
});

test('settle rejects released or unknown ids', () => {
  const s = createBudget(100);
  reserve(s, 'x', 30);
  release(s, 'x');
  assert.throws(() => settle(s, 'x', 30), /released/);
  assert.throws(() => settle(s, 'ghost', 5), /unknown/);
});

// --- Release semantics ---------------------------------------------------

test('release frees a hold and repeats idempotently', () => {
  const s = createBudget(100);
  reserve(s, 'x', 30);
  release(s, 'x');
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 0, available: 100, overdrawn: false });
  release(s, 'x'); // idempotent
  assert.throws(() => release(s, 'ghost'), /unknown/);
});

test('release rejects an already-settled id', () => {
  const s = createBudget(100);
  reserve(s, 'x', 30);
  settle(s, 'x', 30);
  assert.throws(() => release(s, 'x'), /settled/);
});

// --- Overdrawn gating ----------------------------------------------------

test('when overdrawn every new reservation is rejected, including zero', () => {
  const s = createBudget(100);
  reserve(s, 'a', 90);
  settle(s, 'a', 120); // spent=120, overdrawn, hold freed
  assert.equal(snapshot(s).overdrawn, true);
  assert.equal(snapshot(s).reserved, 0);
  assert.throws(() => reserve(s, 'b', 0), /overdrawn/);
  assert.throws(() => reserve(s, 'b', 1), /overdrawn/);
  assert.equal(snapshot(s).reserved, 0);
});

test('at capacity but not overdrawn a zero reserve is allowed', () => {
  const s = createBudget(100);
  reserve(s, 'a', 100);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 100, available: 0, overdrawn: false });
  reserve(s, 'b', 0); // non-overdrawn so zero allowed
  assert.equal(snapshot(s).reserved, 100);
  assert.throws(() => reserve(s, 'c', 1), /exceeds available/);
});

test('overdrawn gating vs active replay and terminal reuse', () => {
  const s = createBudget(100);
  reserve(s, 'a', 40);
  reserve(s, 'b', 50); // both held, spent 0, not overdrawn
  settle(s, 'a', 120); // overdrawn; a freed/settled, b remains actively held
  assert.equal(snapshot(s).overdrawn, true);
  assert.equal(snapshot(s).reserved, 50);
  reserve(s, 'b', 50); // active replay adds no capacity -> silent no-op
  assert.equal(snapshot(s).reserved, 50);
  // once b is released (terminal), any re-reserve is rejected
  release(s, 'b');
  assert.throws(() => reserve(s, 'b', 50), /cannot reserve again/);
  // and overdrawn still rejects every genuinely new reservation, incl. zero
  assert.throws(() => reserve(s, 'c', 0), /overdrawn/);
});

// --- Validation / safety --------------------------------------------------

test('invalid inputs are rejected without mutating state', () => {
  const s = createBudget(100);
  const before = snapshot(s);
  for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 53, '3', null, undefined]) {
    assert.throws(() => reserve(s, 'x', bad), TypeError);
  }
  assert.throws(() => reserve(s, '', 5), /non-empty string/);
  assert.throws(() => reserve(s, 123, 5));
  assert.throws(() => settle(s, 'never', 5), /unknown/);
  assert.throws(() => release(s, 'never'), /unknown/);
  assert.deepEqual(snapshot(s), before);
});

test('negative/oversized actual on settle is rejected', () => {
  const s = createBudget(100);
  reserve(s, 'x', 50);
  assert.throws(() => settle(s, 'x', -1));
  assert.throws(() => settle(s, 'x', Number.MAX_SAFE_INTEGER + 1));
  assert.equal(snapshot(s).spent, 0);
});

test('createBudget rejects an invalid limit', () => {
  assert.throws(() => createBudget(-1));
  assert.throws(() => createBudget(1.5));
  assert.throws(() => createBudget('100'));
});

test('snapshot returns a fresh object of primitives (no mutable internals)', () => {
  const s = createBudget(100);
  reserve(s, 'x', 30);
  const snap = snapshot(s);
  const snap2 = snapshot(s);
  assert.notEqual(snap, snap2);
  assert.equal(snap.reserved, 30);
  assert.equal(typeof snap.limit, 'number');
});

// --- JSON persistence -----------------------------------------------------

test('an unresolved hold survives JSON round-trip and keeps blocking', () => {
  const s = createBudget(100);
  reserve(s, 'x', 40);
  const restored = JSON.parse(JSON.stringify(s));
  assert.equal(snapshot(restored).reserved, 40);
  assert.equal(snapshot(restored).available, 60);
  assert.throws(() => reserve(restored, 'y', 70), /exceeds available/);
});

test('JSON round-trip preserves settled and released states', () => {
  const s = createBudget(100);
  reserve(s, 'x', 30);
  settle(s, 'x', 25);
  reserve(s, 'y', 30);
  release(s, 'y');
  const restored = JSON.parse(JSON.stringify(s));
  assert.deepEqual(snapshot(restored), { limit: 100, spent: 25, reserved: 0, available: 75, overdrawn: false });
  // idempotency semantics survive a reload
  assert.throws(() => settle(restored, 'x', 26), /differs/);
  settle(restored, 'x', 25); // exact idempotent replay works
  assert.equal(snapshot(restored).spent, 25);
});

// --- Special ids ----------------------------------------------------------

test('prototype-colliding ids behave like ordinary ids', () => {
  for (const id of ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf', 'prototype']) {
    const s = createBudget(100);
    reserve(s, id, 30);
    assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 30, available: 70, overdrawn: false }, `reserve ${id}`);
    reserve(s, id, 30); // active replay no-op
    assert.equal(snapshot(s).reserved, 30, `replay ${id}`);
    assert.throws(() => reserve(s, id, 31), /changed amount/, `changed ${id}`);
    settle(s, id, 20);
    assert.deepEqual(snapshot(s), { limit: 100, spent: 20, reserved: 0, available: 80, overdrawn: false }, `settle ${id}`);
    settle(s, id, 20); // terminal idempotency
    assert.equal(snapshot(s).spent, 20, `re-settle ${id}`);
    assert.throws(() => reserve(s, id, 30), /cannot reserve again/, `no resurrection ${id}`);
  }
});

test('special ids survive JSON round-trip and keep idempotency', () => {
  const s = createBudget(100);
  reserve(s, '__proto__', 30);
  settle(s, '__proto__', 25);
  const restored = JSON.parse(JSON.stringify(s));
  assert.equal(snapshot(restored).spent, 25);
  settle(restored, '__proto__', 25); // idempotent after restart
  assert.equal(snapshot(restored).spent, 25);
  assert.throws(() => settle(restored, '__proto__', 26), /differs/);
});

test('unknown ids including prototype keys are rejected by settle/release', () => {
  const s = createBudget(100);
  assert.throws(() => settle(s, 'constructor', 5), /unknown/);
  assert.throws(() => settle(s, 'toString', 5), /unknown/);
  assert.throws(() => release(s, 'constructor'), /unknown/);
  assert.throws(() => release(s, '__proto__'), /unknown/);
  // and afterwards the state is untouched
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 0, available: 100, overdrawn: false });
});
