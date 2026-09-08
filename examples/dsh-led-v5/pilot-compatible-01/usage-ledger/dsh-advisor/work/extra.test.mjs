import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, ingest, report } from './usage-ledger.mjs';

const D = (o) => JSON.parse(JSON.stringify(o));
const RATES = (u, c, o) => ({ uncachedInput: u, cacheRead: c, output: o });

function ingestThrows(state, ev) {
  let threw = false;
  try { ingest(state, ev); } catch (e) { threw = true; }
  return threw;
}

test('createLedger empty; empty report complete', () => {
  const s = createLedger();
  assert.deepEqual(report(s, {}), { complete: true, totalUsd: 0, byModel: {} });
});

test('delta events sum across streams of same model', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's1', model: 'm', seq: 1, kind: 'delta', input: 100, cachedInput: 40, output: 5 });
  ingest(s, { id: 'b', stream: 's1', model: 'm', seq: 2, kind: 'delta', input: 20, cachedInput: 0, output: 5 });
  ingest(s, { id: 'c', stream: 's2', model: 'm', seq: 1, kind: 'delta', input: 10, cachedInput: 10, output: 0 });
  const r = report(s, { m: RATES(10, 1, 50) });
  // m: uncached = (100-40)+(20-0)+(10-10)=80 ; cacheRead=40+0+10=50 ; output=5+5+0=10
  assert.deepEqual(r.byModel.m, { uncachedInput: 80, cacheRead: 50, output: 10 });
  assert.equal(r.complete, true);
});

test('exact replay no-op even after restart; conflicting reuse throws unchanged', () => {
  const ev = { id: 'x', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 100, cachedInput: 80, output: 10 };
  const s = createLedger();
  ingest(s, ev);
  const snap = D(s);
  ingest(s, ev); // exact replay -> no-op
  assert.deepEqual(D(s), snap);
  const restarted = D(s);
  ingest(restarted, ev); // replay after restart still no-op
  assert.deepEqual(D(restarted), snap);

  const conflicting = { ...ev, output: 999 };
  assert.equal(ingestThrows(restarted, conflicting), true);
  assert.deepEqual(D(restarted), snap, 'conflict must leave state unchanged');
});

test('out-of-order and repeated seq with a new id are rejected atomically', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 10, cachedInput: 0, output: 0 });
  ingest(s, { id: 'b', stream: 's', model: 'm', seq: 2, kind: 'delta', input: 10, cachedInput: 0, output: 0 });
  const snap = D(s);
  // repeated seq with new id
  assert.equal(ingestThrows(s, { id: 'c', stream: 's', model: 'm', seq: 2, kind: 'delta', input: 1, cachedInput: 0, output: 0 }), true);
  // out of order (smaller than last accepted) with new id
  assert.equal(ingestThrows(s, { id: 'd', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 1, cachedInput: 0, output: 0 }), true);
  assert.deepEqual(D(s), snap);
});

test('cumulative keeps latest only and never decreases', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'cumulative', input: 100, cachedInput: 50, output: 10 });
  ingest(s, { id: 'b', stream: 's', model: 'm', seq: 2, kind: 'cumulative', input: 200, cachedInput: 60, output: 20 });
  const snap = D(s);
  // must not decrease individually
  assert.equal(ingestThrows(s, { id: 'c', stream: 's', model: 'm', seq: 3, kind: 'cumulative', input: 150, cachedInput: 60, output: 20 }), true);
  assert.deepEqual(D(s), snap);
  // report counts only latest cumulative (200,60,20): uncached=140 cacheRead=60 output=20
  const r = report(s, { m: RATES(1, 1, 1) });
  assert.deepEqual(r.byModel.m, { uncachedInput: 140, cacheRead: 60, output: 20 });
  assert.equal(r.totalUsd, (140 + 60 + 20) / 1e6);
});

test('stream keeps one model and one kind', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'm1', seq: 1, kind: 'delta', input: 1, cachedInput: 0, output: 0 });
  const snap = D(s);
  assert.equal(ingestThrows(s, { id: 'b', stream: 's', model: 'm2', seq: 2, kind: 'delta', input: 1, cachedInput: 0, output: 0 }), true);
  assert.equal(ingestThrows(s, { id: 'c', stream: 's', model: 'm1', seq: 2, kind: 'cumulative', input: 5, cachedInput: 0, output: 0 }), true);
  assert.deepEqual(D(s), snap);
});

test('validation rejects malformed events atomically', () => {
  const good = { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 10, cachedInput: 2, output: 3 };
  const s = createLedger();
  ingest(s, good);
  const snap = D(s);
  const bad = [
    { ...good, id: '' },
    { ...good, stream: '' },
    { ...good, model: '' },
    { ...good, kind: 'bogus' },
    { ...good, seq: -1 },
    { ...good, seq: 1.5 },
    { ...good, seq: Number.MAX_SAFE_INTEGER + 1 },
    { ...good, input: -1 },
    { ...good, input: 1.2 },
    { ...good, input: NaN },
    { ...good, input: '10' },
    { ...good, cachedInput: 11 }, // > input 10
    { ...good, output: undefined },
    { ...good, input: undefined, cachedInput: 0, output: 0 },
    // missing a required field entirely
    (() => { const e = { ...good }; delete e.output; return e; })(),
    { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 10, cachedInput: 2, output: 99 }, // conflicting reuse
  ];
  for (const b of bad) {
    assert.equal(ingestThrows(s, b), true, `expected throw for ${JSON.stringify(b)}`);
  }
  assert.deepEqual(D(s), snap);
});

test('safe integer overflow on delta accumulation rejected atomically', () => {
  const s = createLedger();
  const MAX = Number.MAX_SAFE_INTEGER;
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'delta', input: MAX, cachedInput: 0, output: 0 });
  const snap = D(s);
  assert.equal(ingestThrows(s, { id: 'b', stream: 's', model: 'm', seq: 2, kind: 'delta', input: 1, cachedInput: 0, output: 0 }), true);
  assert.deepEqual(D(s), snap);
});

test('report: missing/invalid rates -> complete false, totalUsd null, totals preserved', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 100, cachedInput: 40, output: 5 });
  let r = report(s, {});
  assert.equal(r.complete, false);
  assert.equal(r.totalUsd, null);
  assert.deepEqual(r.byModel.m, { uncachedInput: 60, cacheRead: 40, output: 5 });

  r = report(s, { m: RATES(NaN, 1, 1) });
  assert.equal(r.complete, false);
  assert.equal(r.totalUsd, null);
  r = report(s, { m: RATES(-1, 1, 1) });
  assert.equal(r.complete, false);
  r = report(s, { m: RATES(Infinity, 1, 1) });
  assert.equal(r.complete, false);

  // partial valid rates across two models
  const s2 = createLedger();
  ingest(s2, { id: 'a', stream: 's', model: 'm1', seq: 1, kind: 'delta', input: 10, cachedInput: 0, output: 0 });
  ingest(s2, { id: 'b', stream: 't', model: 'm2', seq: 1, kind: 'delta', input: 10, cachedInput: 0, output: 0 });
  r = report(s2, { m1: RATES(1, 1, 1) });
  assert.equal(r.complete, false);
  assert.equal(r.totalUsd, null);
  assert.deepEqual(r.byModel.m1, { uncachedInput: 10, cacheRead: 0, output: 0 });
  assert.deepEqual(r.byModel.m2, { uncachedInput: 10, cacheRead: 0, output: 0 });
});

test('report sums models and does not round; fractional rates', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's1', model: 'm', seq: 1, kind: 'delta', input: 1000000, cachedInput: 0, output: 0 });
  ingest(s, { id: 'b', stream: 's2', model: 'm', seq: 1, kind: 'delta', input: 1000000, cachedInput: 0, output: 0 });
  ingest(s, { id: 'c', stream: 's3', model: 'n', seq: 1, kind: 'delta', input: 500000, cachedInput: 0, output: 0 });
  const r = report(s, { m: RATES(1.5, 1, 1), n: RATES(0.25, 1, 1) });
  assert.equal(r.complete, true);
  assert.deepEqual(r.byModel.m, { uncachedInput: 2000000, cacheRead: 0, output: 0 });
  // m: 2e6*1.5 = 3e6 micro; n: 0.5e6*0.25=0.125e6 micro -> 3.125e6/1e6 = 3.125
  assert.equal(r.totalUsd, 3.125);
});

test('state round-trips and continues to ingest after parse', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'cumulative', input: 100, cachedInput: 20, output: 10 });
  const s2 = D(s);
  ingest(s2, { id: 'b', stream: 's', model: 'm', seq: 2, kind: 'cumulative', input: 150, cachedInput: 30, output: 15 });
  const r = report(s2, { m: RATES(10, 1, 50) });
  // uncached=120, cacheRead=30, output=15 -> 1200+30+750=1980 micro -> 0.00198
  assert.equal(r.complete, true);
  assert.deepEqual(r.byModel.m, { uncachedInput: 120, cacheRead: 30, output: 15 });
  assert.equal(r.totalUsd, 1980 / 1e6);
});

test('visible example exact equality', () => {
  const s = createLedger();
  ingest(s, { id: '1', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 100, cachedInput: 80, output: 10 });
  const r = report(s, { m: RATES(10, 1, 50) });
  assert.deepEqual(r.byModel.m, { uncachedInput: 20, cacheRead: 80, output: 10 });
  assert.equal(r.complete, true);
  assert.equal(r.totalUsd, 0.00078);
});
