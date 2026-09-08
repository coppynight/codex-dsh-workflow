import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudget, reserve, settle, release, snapshot } from './budget.mjs';

test('new reservation exceeding available throws', () => {
  const s = createBudget(100);
  reserve(s, 'a', 100);
  assert.throws(() => reserve(s, 'b', 1)); // nothing free
  assert.equal(snapshot(s).available, 0);
});

test('idempotent reserve replay for an active hold does not double count', () => {
  const s = createBudget(100);
  reserve(s, 'x', 40);
  reserve(s, 'x', 40); // replay
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 40, available: 60, overdrawn: false });
  // headroom still allows the remainder
  reserve(s, 'y', 60);
  assert.equal(snapshot(s).available, 0);
});

test('reserve replay tolerated after settle and after release', () => {
  const s = createBudget(100);
  reserve(s, 's', 30);
  settle(s, 's', 25);
  reserve(s, 's', 30); // replay after settle -> no throw
  assert.deepEqual(snapshot(s).spent, 25);
  assert.equal(snapshot(s).reserved, 0);

  const t = createBudget(100);
  reserve(t, 'r', 20);
  release(t, 'r');
  reserve(t, 'r', 20); // replay after release -> no throw
  assert.deepEqual(snapshot(t).reserved, 0);
});

test('changed amount or reused id for different operation throws', () => {
  const s = createBudget(100);
  reserve(s, 'a', 30);
  assert.throws(() => reserve(s, 'a', 31));
  reserve(s, 'b', 30);
  settle(s, 'b', 30);
  assert.throws(() => reserve(s, 'b', 40));
});

test('settle idempotent only for the same actual; different actual throws', () => {
  const s = createBudget(100);
  reserve(s, 'a', 50);
  settle(s, 'a', 40);
  settle(s, 'a', 40); // idempotent
  assert.deepEqual(snapshot(s).spent, 40);
  assert.throws(() => settle(s, 'a', 41));
  assert.deepEqual(snapshot(s).spent, 40); // state unchanged
});

test('settle actual may exceed reservation and total limit -> overdrawn', () => {
  const s = createBudget(100);
  reserve(s, 'a', 20);
  settle(s, 'a', 500);
  assert.deepEqual(snapshot(s), { limit: 100, spent: 500, reserved: 0, available: 0, overdrawn: true });
});

test('overdrawn rejects every new reservation including zero', () => {
  const s = createBudget(10);
  reserve(s, 'a', 5);
  settle(s, 'a', 20); // overdrawn
  assert.equal(snapshot(s).overdrawn, true);
  assert.throws(() => reserve(s, 'b', 0));
  assert.throws(() => reserve(s, 'b', 1));
});

test('release frees an active hold and repeats idempotently; rejects settled and unknown', () => {
  const s = createBudget(100);
  reserve(s, 'a', 40);
  reserve(s, 'b', 30);
  release(s, 'a');
  assert.equal(snapshot(s).reserved, 30);
  release(s, 'a'); // idempotent
  assert.equal(snapshot(s).reserved, 30);
  assert.throws(() => release(s, 'zzz')); // unknown
  // settle 'a' is impossible after release
  assert.throws(() => settle(s, 'a', 40));
  // settled id cannot be released
  settle(s, 'b', 30);
  assert.throws(() => release(s, 'b'));
});

test('settle rejects released and unknown ids', () => {
  const s = createBudget(50);
  reserve(s, 'a', 10);
  release(s, 'a');
  assert.throws(() => settle(s, 'a', 10));
  assert.throws(() => settle(s, 'nope', 5));
});

test('unresolved reservation survives JSON serialization and keeps blocking spend', () => {
  const s = createBudget(100);
  reserve(s, 'hold', 90);
  const revived = JSON.parse(JSON.stringify(s));
  assert.deepEqual(snapshot(revived), snapshot(s));
  // still blocking after restart
  assert.throws(() => reserve(revived, 'extra', 50));
  assert.equal(snapshot(revived).available, 10);
  settle(revived, 'hold', 70);
  assert.deepEqual(snapshot(revived), { limit: 100, spent: 70, reserved: 0, available: 30, overdrawn: false });
});

test('invalid input rejected without changing state', () => {
  const s = createBudget(100);
  reserve(s, 'a', 20);
  const before = snapshot(s);
  const ops = [
    () => reserve(s, '', 1),
    () => reserve(s, 42, 1),
    () => reserve(s, 'a', -1),
    () => reserve(s, 'a', 1.5),
    () => reserve(s, 'a', Number.MAX_SAFE_INTEGER + 1),
    () => settle(s, 'a', -5),
    () => settle(s, 'a', NaN),
    () => release(s, ''),
  ];
  for (const op of ops) assert.throws(op);
  assert.deepEqual(snapshot(s), before);
  assert.throws(() => createBudget(-1));
  assert.throws(() => createBudget(1.5));
});

test('snapshot never exposes mutable internals', () => {
  const s = createBudget(100);
  reserve(s, 'a', 20);
  const snap = snapshot(s);
  snap.spent = 9999;
  snap.available = 0;
  snap.limit = 0;
  snap.reserved = 0;
  assert.deepEqual(snapshot(s), { limit: 100, spent: 0, reserved: 20, available: 80, overdrawn: false });
});

test('budget exactly at limit is not overdrawn; zero reservation allowed', () => {
  const s = createBudget(50);
  reserve(s, 'a', 50);
  assert.deepEqual(snapshot(s).overdrawn, false);
  reserve(s, 'z', 0); // not overdrawn -> zero new reservation is fine
  assert.equal(snapshot(s).reserved, 50);
});
