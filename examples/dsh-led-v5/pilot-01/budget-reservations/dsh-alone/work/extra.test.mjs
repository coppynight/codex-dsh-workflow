// extra.test.mjs — additional checks beyond visible.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBudget,
  reserve,
  settle,
  release,
  snapshot,
} from './budget.mjs';

const roundtrip = (s) => JSON.parse(JSON.stringify(s));

test('invalid limits are rejected by createBudget', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER + 1, '100', null, undefined, true, {}, [], 5n]) {
    assert.throws(() => createBudget(bad), undefined, `limit ${String(bad)}`);
  }
  assert.deepEqual(snapshot(createBudget(0)), {
    limit: 0, spent: 0, reserved: 0, available: 0, overdrawn: false,
  });
  assert.deepEqual(snapshot(createBudget(Number.MAX_SAFE_INTEGER)), {
    limit: Number.MAX_SAFE_INTEGER, spent: 0, reserved: 0,
    available: Number.MAX_SAFE_INTEGER, overdrawn: false,
  });
});

test('holds reduce available; replay of an active reserve is a no-op', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  assert.deepEqual(snapshot(s), {
    limit: 100, spent: 0, reserved: 30, available: 70, overdrawn: false,
  });
  reserve(s, 'a', 30); // duplicate of in-flight reserve
  assert.deepEqual(snapshot(s), {
    limit: 100, spent: 0, reserved: 30, available: 70, overdrawn: false,
  });
  reserve(s, 'b', 70); // fills exactly the remaining budget
  assert.deepEqual(snapshot(s), {
    limit: 100, spent: 0, reserved: 100, available: 0, overdrawn: false,
  });
});

test('changed amount on a known id throws without changing state', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  const before = JSON.stringify(s);
  assert.throws(() => reserve(s, 'a', 31));
  assert.throws(() => reserve(s, 'a', 0));
  assert.equal(JSON.stringify(s), before);
});

test('new reserve exceeding available throws without changing state', () => {
  const s = createBudget(100);
  reserve(s, 'a', 60);
  const before = JSON.stringify(s);
  assert.throws(() => reserve(s, 'b', 41));
  assert.throws(() => reserve(s, 'b', 100));
  assert.equal(JSON.stringify(s), before);
  reserve(s, 'b', 40); // exactly available
  assert.equal(snapshot(s).reserved, 100);
});

test('reserve replay after settle/release with same amount is accepted and inert', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  settle(s, 'a', 20);
  const afterSettle = JSON.stringify(s);
  reserve(s, 'a', 30); // straggler replay of the original reserve
  assert.equal(JSON.stringify(s), afterSettle);
  assert.deepEqual(snapshot(s), {
    limit: 100, spent: 20, reserved: 0, available: 80, overdrawn: false,
  });

  const t = createBudget(100);
  reserve(t, 'b', 30);
  release(t, 'b');
  const afterRelease = JSON.stringify(t);
  reserve(t, 'b', 30); // straggler replay
  assert.equal(JSON.stringify(t), afterRelease);
  assert.equal(snapshot(t).reserved, 0);
});

test('reserve with changed amount after finalization throws', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  settle(s, 'a', 20);
  assert.throws(() => reserve(s, 'a', 25));
  const t = createBudget(100);
  reserve(t, 'b', 30);
  release(t, 'b');
  assert.throws(() => reserve(t, 'b', 25));
  assert.equal(snapshot(s).spent, 20);
  assert.equal(snapshot(t).reserved, 0);
});

test('settle records actual, frees hold; actual may exceed limit -> overdrawn', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  settle(s, 'a', 250); // remote overrun far above limit
  assert.deepEqual(snapshot(s), {
    limit: 100, spent: 250, reserved: 0, available: 0, overdrawn: true,
  });
});

test('overdrawn rejects every new reservation, including zero', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  settle(s, 'a', 200); // overdrawn: spent 200 > limit 100
  assert.equal(snapshot(s).overdrawn, true);
  assert.throws(() => reserve(s, 'new', 0));
  assert.throws(() => reserve(s, 'new2', 5));
  // replay of an already-recorded id is still tolerated and inert
  reserve(s, 'a', 30);
  assert.deepEqual(snapshot(s), {
    limit: 100, spent: 200, reserved: 0, available: 0, overdrawn: true,
  });
});

test('overdrawn is exactly spent + reserved > limit', () => {
  const s = createBudget(100);
  reserve(s, 'a', 40);
  settle(s, 'a', 40); // spent == limit exactly -> not overdrawn, available 0
  assert.deepEqual(snapshot(s), {
    limit: 100, spent: 40, reserved: 0, available: 60, overdrawn: false,
  });
  reserve(s, 'b', 60); // reserved 60, available 0, not overdrawn
  assert.deepEqual(snapshot(s), {
    limit: 100, spent: 40, reserved: 60, available: 0, overdrawn: false,
  });
  // a zero-value new reservation is fine while not overdrawn
  reserve(s, 'c', 0);
  assert.equal(snapshot(s).reserved, 60);
  settle(s, 'b', 61); // spent 101 > 100 -> overdrawn
  assert.deepEqual(snapshot(s), {
    limit: 100, spent: 101, reserved: 0, available: 0, overdrawn: true,
  });
});

test('settle replay only for exactly the same actual', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  settle(s, 'a', 22);
  const after = JSON.stringify(s);
  settle(s, 'a', 22); // idempotent replay
  assert.equal(JSON.stringify(s), after);
  assert.throws(() => settle(s, 'a', 23));
  assert.equal(JSON.stringify(s), after);
  assert.equal(snapshot(s).spent, 22);
});

test('settle rejects unknown and released ids; release rejects settled and unknown ids', () => {
  const s = createBudget(100);
  assert.throws(() => settle(s, 'ghost', 5));
  assert.throws(() => release(s, 'ghost'));

  reserve(s, 'a', 30);
  release(s, 'a');
  assert.throws(() => settle(s, 'a', 10));
  release(s, 'a'); // repeat release idempotent
  assert.deepEqual(snapshot(s), {
    limit: 100, spent: 0, reserved: 0, available: 100, overdrawn: false,
  });

  reserve(s, 'b', 30);
  settle(s, 'b', 25);
  assert.throws(() => release(s, 'b'));
  assert.deepEqual(snapshot(s), {
    limit: 100, spent: 25, reserved: 0, available: 75, overdrawn: false,
  });
});

test('release frees an active hold and repeats idempotently', () => {
  const s = createBudget(100);
  reserve(s, 'a', 40);
  reserve(s, 'b', 30);
  assert.equal(snapshot(s).available, 30);
  release(s, 'a');
  assert.deepEqual(snapshot(s), {
    limit: 100, spent: 0, reserved: 30, available: 70, overdrawn: false,
  });
  release(s, 'a'); // idempotent repeat
  assert.equal(snapshot(s).reserved, 30);
});

test('a released then settled ordering is rejected both ways', () => {
  const s = createBudget(50);
  reserve(s, 'x', 10);
  release(s, 'x');
  assert.throws(() => settle(s, 'x', 10));
  const t = createBudget(50);
  reserve(t, 'y', 10);
  settle(t, 'y', 9);
  assert.throws(() => release(t, 'y'));
});

test('unresolved holds survive JSON serialization and keep blocking spend', () => {
  const s = createBudget(100);
  reserve(s, 'persist', 45);
  const restored = roundtrip(s);
  assert.deepEqual(snapshot(restored), {
    limit: 100, spent: 0, reserved: 45, available: 55, overdrawn: false,
  });
  assert.throws(() => reserve(restored, 'other', 60));
  assert.throws(() => reserve(restored, 'other', 56));
  reserve(restored, 'other', 55);
  settle(restored, 'persist', 40);
  assert.deepEqual(snapshot(restored), {
    limit: 100, spent: 40, reserved: 55, available: 5, overdrawn: false,
  });
  // settled/released facts also survive serialization
  settle(restored, 'other', 55);
  const restored2 = roundtrip(restored);
  settle(restored2, 'other', 55); // idempotent after restart
  assert.throws(() => settle(restored2, 'other', 54));
  assert.throws(() => release(restored2, 'persist'));
});

test('snapshot never exposes mutable internals', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  const first = snapshot(s);
  first.limit = 999999;
  first.spent = 123;
  first.reserved = 0;
  first.available = 0;
  first.overdrawn = true;
  assert.notDeepEqual(snapshot(s), first);
  assert.deepEqual(snapshot(s), {
    limit: 100, spent: 0, reserved: 30, available: 70, overdrawn: false,
  });
});

test('invalid ids and amounts are rejected without changing state', () => {
  const s = createBudget(100);
  reserve(s, 'ok', 10);
  const before = JSON.stringify(s);
  for (const badId of ['', 5, null, undefined, {}, [], true]) {
    assert.throws(() => reserve(s, badId, 5));
    assert.throws(() => settle(s, badId, 5));
    assert.throws(() => release(s, badId));
  }
  for (const badAmount of [-1, -0.5, 1.5, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER + 1, '10', null, undefined, 5n]) {
    assert.throws(() => reserve(s, 'new', badAmount));
    assert.throws(() => reserve(s, 'ok', badAmount));
    assert.throws(() => settle(s, 'ok', badAmount));
  }
  assert.equal(JSON.stringify(s), before);
});

test('unsafe cumulative spend is rejected without state change', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const s = createBudget(max);
  reserve(s, 'a', max - 5);
  settle(s, 'a', max - 5); // spent = max - 5
  assert.equal(snapshot(s).spent, max - 5);
  assert.equal(snapshot(s).available, 5);
  reserve(s, 'b', 5); // holds the last 5 of budget
  assert.equal(snapshot(s).reserved, 5);
  const before = JSON.stringify(s);
  assert.throws(() => settle(s, 'b', 6)); // (max-5) + 6 = max+1: not safe
  assert.equal(JSON.stringify(s), before);
  assert.equal(snapshot(s).reserved, 5); // hold left untouched
  assert.equal(snapshot(s).spent, max - 5);
  settle(s, 'b', 5); // exactly max total is representable and accepted
  assert.equal(snapshot(s).spent, max);
});

test('zero-value reservations and zero actual spends are valid while not overdrawn', () => {
  const s = createBudget(100);
  reserve(s, 'z', 0);
  assert.deepEqual(snapshot(s), {
    limit: 100, spent: 0, reserved: 0, available: 100, overdrawn: false,
  });
  settle(s, 'z', 0);
  assert.equal(snapshot(s).spent, 0);
  const after = JSON.stringify(s);
  reserve(s, 'z', 0); // same id + amount after settle: inert idempotent replay
  assert.equal(JSON.stringify(s), after);
  assert.equal(snapshot(s).spent, 0);
  reserve(s, 'zz', 0); // distinct id: fresh zero reservation allowed
  assert.equal(snapshot(s).reserved, 0);
});

test('id keys may be arbitrary non-empty strings including odd ones', () => {
  const s = createBudget(100);
  reserve(s, '__proto__', 10);
  reserve(s, 'toString', 20);
  reserve(s, 'constructor', 30);
  reserve(s, ' ', 5);
  reserve(s, '🎯-op-1', 5);
  assert.equal(snapshot(s).reserved, 70);
  settle(s, '__proto__', 12);
  release(s, 'toString');
  release(s, 'constructor');
  assert.equal(snapshot(s).spent, 12);
  assert.equal(snapshot(s).reserved, 10);
  const restored = roundtrip(s);
  assert.equal(snapshot(restored).reserved, 10);
  assert.throws(() => settle(restored, 'constructor', 30)); // released id cannot be settled
});

test('end-to-end multi-op accounting', () => {
  const s = createBudget(1000);
  reserve(s, 'r1', 100);
  reserve(s, 'r2', 200);
  assert.deepEqual(snapshot(s), {
    limit: 1000, spent: 0, reserved: 300, available: 700, overdrawn: false,
  });
  settle(s, 'r1', 90);
  release(s, 'r2');
  assert.deepEqual(snapshot(s), {
    limit: 1000, spent: 90, reserved: 0, available: 910, overdrawn: false,
  });
  reserve(s, 'r3', 910);
  settle(s, 'r3', 2000); // overrun
  assert.deepEqual(snapshot(s), {
    limit: 1000, spent: 2090, reserved: 0, available: 0, overdrawn: true,
  });
  assert.throws(() => reserve(s, 'r4', 0));
});
