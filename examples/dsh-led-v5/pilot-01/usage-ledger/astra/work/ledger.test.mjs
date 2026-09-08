import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, ingest, report } from './usage-ledger.mjs';

const event = (changes = {}) => ({ id: '1', stream: 's', model: 'm', seq: 0,
  kind: 'delta', input: 100, cachedInput: 80, output: 10, ...changes });
const rates = { m: { uncachedInput: 10, cacheRead: 1, output: 50 } };
function rejectsUnchanged(state, value) {
  const before = JSON.stringify(state);
  assert.throws(() => ingest(state, value));
  assert.equal(JSON.stringify(state), before);
}

test('empty report and persistent replay history', () => {
  assert.deepEqual(report(createLedger()), { complete: true, totalUsd: 0, byModel: {} });
  let s = createLedger();
  const first = event();
  ingest(s, first);
  first.input = 999;
  ingest(s, event({ id: '2', seq: 2 }));
  s = JSON.parse(JSON.stringify(s));
  const before = JSON.stringify(s);
  ingest(s, event());
  assert.equal(JSON.stringify(s), before);
  for (const changes of [{ input: 101 }, { stream: 'other' }, { model: 'other' },
    { seq: 1 }, { kind: 'cumulative' }, { cachedInput: 79 }, { output: 11 }]) {
    rejectsUnchanged(s, event(changes));
  }
});

test('cumulative snapshots, delta streams, and model aggregation', () => {
  const s = createLedger();
  ingest(s, event({ kind: 'cumulative' }));
  ingest(s, event({ id: '2', seq: 4, kind: 'cumulative', input: 150, cachedInput: 120, output: 15 }));
  ingest(s, event({ id: '3', seq: 5, kind: 'cumulative', input: 150, cachedInput: 140, output: 15 }));
  ingest(s, event({ id: '4', stream: 'd' }));
  ingest(s, event({ id: '5', stream: 'd', seq: 1 }));
  assert.deepEqual(report(s, rates).byModel, { m: { uncachedInput: 50, cacheRead: 300, output: 35 } });
  for (const changes of [{ input: 149, cachedInput: 140, output: 15 },
    { input: 150, cachedInput: 139, output: 15 }, { input: 150, cachedInput: 140, output: 14 }]) {
    rejectsUnchanged(s, event({ id: 'bad', kind: 'cumulative', seq: 6, ...changes }));
  }
});

test('invalid events, ordering, and stream identity reject atomically', () => {
  const s = createLedger();
  ingest(s, event({ seq: 2 }));
  for (const changes of [{ seq: 2 }, { seq: 1 }, { model: 'x' }, { kind: 'cumulative' },
    { seq: -1 }, { seq: 1.5 }, { seq: Number.MAX_SAFE_INTEGER + 1 },
    { input: NaN }, { cachedInput: Infinity }, { output: -1 }, { cachedInput: 101 },
    { id: '' }, { stream: '' }, { model: '' }, { kind: 'x' }, { input: '100' }]) {
    rejectsUnchanged(s, event({ id: 'new', seq: 3, ...changes }));
  }
  for (const key of Object.keys(event())) {
    const missing = event({ id: 'new', seq: 3 });
    delete missing[key];
    rejectsUnchanged(s, missing);
  }
});

test('safe integer bounds apply to stream and model totals', () => {
  for (const field of ['input', 'cachedInput', 'output']) {
    const s = createLedger();
    const max = { input: 0, cachedInput: 0, output: 0, [field]: Number.MAX_SAFE_INTEGER };
    if (field === 'cachedInput') max.input = max.cachedInput;
    ingest(s, event(max));
    const increment = { input: 0, cachedInput: 0, output: 0, [field]: 1 };
    if (field === 'cachedInput') increment.input = 1;
    rejectsUnchanged(s, event({ ...increment, id: '2', seq: 1 }));
    rejectsUnchanged(s, event({ ...increment, id: '3', stream: 'another' }));
  }
});

test('missing or invalid used rates retain totals; unused invalid rates do not matter', () => {
  const s = createLedger();
  ingest(s, event());
  for (const value of [undefined, {}, { m: null }, { m: {} },
    ...[NaN, Infinity, -1, '1', undefined].map(cacheRead => ({ m: { ...rates.m, cacheRead } }))]) {
    assert.deepEqual(report(s, value), { complete: false, totalUsd: null,
      byModel: { m: { uncachedInput: 20, cacheRead: 80, output: 10 } } });
  }
  assert.equal(report(s, { ...rates, unused: null }).complete, true);
  assert.equal(report(s, { m: { uncachedInput: 0, cacheRead: 0, output: 0 } }).totalUsd, 0);
});

test('arbitrary identifiers survive JSON without prototype collisions', () => {
  let s = createLedger();
  for (const name of ['__proto__', 'constructor', 'toString']) {
    ingest(s, event({ id: name, stream: name, model: name }));
  }
  s = JSON.parse(JSON.stringify(s));
  const price = JSON.parse('{"__proto__":{"uncachedInput":10,"cacheRead":1,"output":50},"constructor":{"uncachedInput":0,"cacheRead":0,"output":0},"toString":{"uncachedInput":0,"cacheRead":0,"output":0}}');
  assert.equal(report(s, price).totalUsd, 0.00078);
  assert.equal(Object.keys(report(s, price).byModel).length, 3);
  const before = JSON.stringify(s);
  ingest(s, event({ id: '__proto__', stream: '__proto__', model: '__proto__' }));
  assert.equal(JSON.stringify(s), before);
});
