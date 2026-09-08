import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, ingest, report } from './usage-ledger.mjs';

const json = (s) => JSON.parse(JSON.stringify(s));
const snap = (s) => JSON.stringify(s);
const R = { m: { uncachedInput: 10, cacheRead: 1, output: 50 } };

test('createLedger is empty and pure on report', () => {
  const s = createLedger();
  assert.deepEqual(report(s, {}), { complete: true, totalUsd: 0, byModel: {} });
});

test('delta events sum', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 100, cachedInput: 40, output: 10 });
  ingest(s, { id: 'b', stream: 's', model: 'm', seq: 2, kind: 'delta', input: 50, cachedInput: 20, output: 5 });
  const r = report(s, R);
  assert.equal(r.complete, true);
  assert.deepEqual(r.byModel.m, { uncachedInput: 90, cacheRead: 60, output: 15 });
});

test('cumulative counts only latest snapshot', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'cumulative', input: 100, cachedInput: 80, output: 10 });
  ingest(s, { id: 'b', stream: 's', model: 'm', seq: 2, kind: 'cumulative', input: 130, cachedInput: 100, output: 12 });
  const r = report(s, R);
  assert.deepEqual(r.byModel.m, { uncachedInput: 30, cacheRead: 100, output: 12 }); // not summing 100+130
});

test('cumulative counters must never decrease -> reject atomically', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'cumulative', input: 130, cachedInput: 100, output: 12 });
  const before = snap(s);
  assert.throws(() => ingest(s, { id: 'b', stream: 's', model: 'm', seq: 2, kind: 'cumulative', input: 100, cachedInput: 100, output: 12 }));
  assert.equal(snap(s), before, 'state unchanged after rejected cumulative decrease');
  const r = report(s, R);
  assert.deepEqual(r.byModel.m, { uncachedInput: 30, cacheRead: 100, output: 12 });
});

test('exact replay no-op; conflicting reuse throws without change', () => {
  const s = createLedger();
  const ev = { id: 'x', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 10, cachedInput: 0, output: 0 };
  ingest(s, ev);
  const before = snap(s);
  ingest(s, { ...ev });
  assert.equal(snap(s), before, 'exact replay must not change state');
  assert.deepEqual(report(s, R).byModel.m, { uncachedInput: 10, cacheRead: 0, output: 0 });
  // conflicting reuse of same id
  assert.throws(() => ingest(s, { ...ev, model: 'other' }));
  assert.equal(snap(s), before, 'conflicting reuse must not change state');
});

test('exact replay is a no-op even after JSON round-trip / restart', () => {
  let s = createLedger();
  const ev = { id: 'persist', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 10, cachedInput: 3, output: 4 };
  ingest(s, ev);
  s = json(s);
  const before = snap(s);
  ingest(s, { ...ev });
  assert.equal(snap(s), before, 'replay after restart must be a no-op');
  assert.deepEqual(report(s, R).byModel.m, { uncachedInput: 7, cacheRead: 3, output: 4 });
});

test('out-of-order and repeated seq rejected with a new id; state unchanged', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 2, kind: 'delta', input: 5, cachedInput: 0, output: 0 });
  const before = snap(s);
  // repeated seq
  assert.throws(() => ingest(s, { id: 'b', stream: 's', model: 'm', seq: 2, kind: 'delta', input: 1, cachedInput: 0, output: 0 }));
  // out of order
  assert.throws(() => ingest(s, { id: 'c', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 1, cachedInput: 0, output: 0 }));
  assert.equal(snap(s), before);
});

test('stream keeps one model and one kind', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 1, cachedInput: 0, output: 0 });
  assert.throws(() => ingest(s, { id: 'b', stream: 's', model: 'n', seq: 2, kind: 'delta', input: 1, cachedInput: 0, output: 0 }));
  assert.throws(() => ingest(s, { id: 'c', stream: 's', model: 'm', seq: 2, kind: 'cumulative', input: 1, cachedInput: 0, output: 0 }));
});

test('mixing delta and cumulative streams of the same model are summed', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 'delta1', model: 'm', seq: 1, kind: 'delta', input: 100, cachedInput: 50, output: 5 });
  ingest(s, { id: 'b', stream: 'cum1', model: 'm', seq: 1, kind: 'cumulative', input: 200, cachedInput: 150, output: 7 });
  ingest(s, { id: 'c', stream: 'cum1', model: 'm', seq: 2, kind: 'cumulative', input: 300, cachedInput: 200, output: 10 });
  const r = report(s, R);
  assert.deepEqual(r.byModel.m, { uncachedInput: 150, cacheRead: 250, output: 15 });
});

test('multiple models aggregated separately', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's1', model: 'm', seq: 1, kind: 'delta', input: 10, cachedInput: 0, output: 0 });
  ingest(s, { id: 'b', stream: 's2', model: 'n', seq: 1, kind: 'delta', input: 20, cachedInput: 5, output: 1 });
  const r = report(s, R);
  assert.deepEqual(Object.keys(r.byModel).sort(), ['m', 'n']);
  assert.deepEqual(r.byModel.n, { uncachedInput: 15, cacheRead: 5, output: 1 });
});

test('missing/invalid rates -> complete false, totalUsd null, token totals preserved', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's1', model: 'm', seq: 1, kind: 'delta', input: 10, cachedInput: 0, output: 0 });
  ingest(s, { id: 'b', stream: 's2', model: 'missing', seq: 1, kind: 'delta', input: 10, cachedInput: 0, output: 0 });
  // rates missing entirely for 'missing'
  const r = report(s, { m: { uncachedInput: 10, cacheRead: 1, output: 50 } });
  assert.equal(r.complete, false);
  assert.equal(r.totalUsd, null);
  assert.deepEqual(r.byModel.missing, { uncachedInput: 10, cacheRead: 0, output: 0 });
  assert.deepEqual(r.byModel.m, { uncachedInput: 10, cacheRead: 0, output: 0 });
});

test('invalid rate values (negative/NaN) -> incomplete', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 10, cachedInput: 0, output: 0 });
  const r = report(s, { m: { uncachedInput: -5, cacheRead: 1, output: 50 } });
  assert.equal(r.complete, false);
  assert.equal(r.totalUsd, null);
});

test('cost uses provided rates and does not round', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 100, cachedInput: 80, output: 10 });
  // uncached 20 * 10/M = 0.0002 ; cached 80 * 1/M = 0.00008 ; out 10 * 50/M = 0.0005
  assert.equal(report(s, R).totalUsd, 0.00078);
});

test('rejected malformed event leaves state byte-for-byte unchanged', () => {
  const s = createLedger();
  const bads = [
    { id: '', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 1, cachedInput: 0, output: 0 },
    { id: 'e1', stream: '', model: 'm', seq: 1, kind: 'delta', input: 1, cachedInput: 0, output: 0 },
    { id: 'e2', stream: 's', model: '', seq: 1, kind: 'delta', input: 1, cachedInput: 0, output: 0 },
    { id: 'e3', stream: 's', model: 'm', seq: -1, kind: 'delta', input: 1, cachedInput: 0, output: 0 },
    { id: 'e4', stream: 's', model: 'm', seq: 1, kind: 'other', input: 1, cachedInput: 0, output: 0 },
    { id: 'e5', stream: 's', model: 'm', seq: 1, kind: 'delta', cachedInput: 0, output: 0 }, // missing input
    { id: 'e6', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 1, cachedInput: 2, output: 0 }, // cached>input
    { id: 'e7', stream: 's', model: 'm', seq: 1.5, kind: 'delta', input: 1, cachedInput: 0, output: 0 },
    { id: 'e8', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 1, cachedInput: 0, output: -1 },
  ];
  for (const ev of bads) {
    const before = snap(s);
    assert.throws(() => ingest(s, ev), undefined, JSON.stringify(ev));
    assert.equal(snap(s), before, 'malformed event must not change state');
  }
});

test('survives full JSON round-trip between events and reports identically', () => {
  let s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 100, cachedInput: 80, output: 10 });
  const r1 = report(s, R);
  s = json(s);
  ingest(s, { id: 'b', stream: 's', model: 'm', seq: 2, kind: 'delta', input: 20, cachedInput: 10, output: 1 });
  const r2 = report(s, R);
  assert.deepEqual(r2.byModel.m, { uncachedInput: 30, cacheRead: 90, output: 11 });
  assert.equal(r2.complete, true);
});

test('seq 0 valid as first event; repeated rejected', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 0, kind: 'delta', input: 1, cachedInput: 0, output: 0 });
  assert.throws(() => ingest(s, { id: 'b', stream: 's', model: 'm', seq: 0, kind: 'delta', input: 1, cachedInput: 0, output: 0 }));
  ingest(s, { id: 'c', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 1, cachedInput: 0, output: 0 });
});

test('overflow of delta accumulation rejected atomically', () => {
  const s = createLedger();
  const MAX = Number.MAX_SAFE_INTEGER;
  ingest(s, { id: 'a', stream: 's', model: 'm', seq: 1, kind: 'delta', input: MAX, cachedInput: 0, output: 0 });
  const before = snap(s);
  assert.throws(() => ingest(s, { id: 'b', stream: 's', model: 'm', seq: 2, kind: 'delta', input: 1, cachedInput: 0, output: 0 }));
  assert.equal(snap(s), before);
});

test('hostile identifier keys (toString/constructor/__proto__) work as model, stream, id', () => {
  const hostile = ['toString', 'constructor', '__proto__'];
  for (const model of hostile) {
    const s = createLedger();
    ingest(s, { id: 'a', stream: 's1', model, seq: 1, kind: 'delta', input: 100, cachedInput: 50, output: 10 });
    const rates = {};
    // defineProperty: plain assignment would hit the __proto__ setter instead of making an own key
    Object.defineProperty(rates, model, { value: { uncachedInput: 10, cacheRead: 1, output: 50 }, enumerable: true, writable: true, configurable: true });
    const r = report(s, rates);
    assert.equal(r.complete, true, `model ${model}`);
    assert.ok(Object.prototype.hasOwnProperty.call(r.byModel, model), `byModel owns ${model}`);
    assert.deepEqual(r.byModel[model], { uncachedInput: 50, cacheRead: 50, output: 10 }, `model ${model}`);
    // 50*10 + 50*1 + 10*50 = 1050 -> /1e6
    assert.equal(r.totalUsd, 0.00105, `model ${model} cost`);

    // hostile stream key too, plus replay after JSON round-trip
    const s2 = createLedger();
    const ev = { id: 'b', stream: model, model: 'm', seq: 1, kind: 'cumulative', input: 40, cachedInput: 20, output: 3 };
    ingest(s2, ev);
    const back = JSON.parse(JSON.stringify(s2));
    const before = JSON.stringify(back);
    ingest(back, { ...ev }); // exact replay no-op after restart
    assert.equal(JSON.stringify(back), before);
    const r2 = report(back, { m: { uncachedInput: 10, cacheRead: 1, output: 50 } });
    assert.deepEqual(r2.byModel.m, { uncachedInput: 20, cacheRead: 20, output: 3 });
  }
});

test('hostile model without own rate stays unknown (incomplete) with preserved totals', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's', model: 'toString', seq: 1, kind: 'delta', input: 100, cachedInput: 50, output: 10 });
  const r = report(s, {}); // no rates at all
  assert.equal(r.complete, false);
  assert.equal(r.totalUsd, null);
  assert.deepEqual(r.byModel.toString, { uncachedInput: 50, cacheRead: 50, output: 10 });
});
