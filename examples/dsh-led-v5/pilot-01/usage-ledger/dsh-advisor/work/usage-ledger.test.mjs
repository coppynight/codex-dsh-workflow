import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, ingest, report } from './usage-ledger.mjs';

const snap = (s) => JSON.stringify(s);
const bytesUnchanged = (s, fn) => {
  const before = snap(s);
  assert.throws(fn);
  assert.equal(snap(s), before, 'state must stay byte-for-byte unchanged after rejection');
};

const D = (id, stream, model, seq, input, cachedInput, output, kind = 'delta') => ({
  id, stream, model, seq, kind, input, cachedInput, output,
});
const delta = (id, stream, model, seq, input, cachedInput, output) => D(id, stream, model, seq, input, cachedInput, output, 'delta');
const cum = (id, stream, model, seq, input, cachedInput, output) => D(id, stream, model, seq, input, cachedInput, output, 'cumulative');

test('visible acceptance: cached input not double counted, exact cost', () => {
  const s = createLedger();
  ingest(s, { id: '1', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 100, cachedInput: 80, output: 10 });
  const r = report(s, { m: { uncachedInput: 10, cacheRead: 1, output: 50 } });
  assert.deepEqual(r.byModel.m, { uncachedInput: 20, cacheRead: 80, output: 10 });
  assert.equal(r.complete, true);
  assert.equal(r.totalUsd, 0.00078);
});

test('createLedger produces empty state; empty ledger reports zeros', () => {
  const s = createLedger();
  assert.deepEqual(Object.keys(s.streams), []);
  assert.deepEqual(Object.keys(s.ids), []);
  assert.deepEqual(report(s, {}), { complete: true, totalUsd: 0, byModel: {} });
  assert.deepEqual(report(s, null), { complete: true, totalUsd: 0, byModel: {} });
  assert.deepEqual(report(s, undefined), { complete: true, totalUsd: 0, byModel: {} });
});

test('state survives JSON.stringify/parse round trips', () => {
  const s = createLedger();
  ingest(s, delta('a', 's1', 'm', 1, 100, 40, 10));
  ingest(s, delta('b', 's2', 'm', 1, 50, 50, 5));
  const r1 = report(s, { m: { uncachedInput: 1, cacheRead: 2, output: 3 } });
  const back = JSON.parse(JSON.stringify(s));
  const r2 = report(back, { m: { uncachedInput: 1, cacheRead: 2, output: 3 } });
  assert.deepEqual(r1, r2);
});

test('exact replay of an id is a no-op, even after restart (JSON round trip)', () => {
  const s = createLedger();
  const ev = cum('a', 'x', 'm', 1, 100, 40, 10);
  ingest(s, ev);
  ingest(s, cum('b', 'x', 'm', 2, 200, 50, 30));
  const before = snap(s);
  ingest(s, ev); // replay of an OLD id must not roll the cumulative total back
  assert.equal(snap(s), before);
  assert.deepEqual(report(s, { m: { uncachedInput: 1, cacheRead: 1, output: 1 } }).byModel.m,
    { uncachedInput: 150, cacheRead: 50, output: 30 });

  // restart: re-send exact replay after round trip -> still a no-op
  const s2 = JSON.parse(JSON.stringify(s));
  ingest(s2, ev);
  assert.equal(snap(s2), snap(JSON.parse(JSON.stringify(s))));
  // and a later duplicate of the newer event too
  ingest(s2, cum('b', 'x', 'm', 2, 200, 50, 30));
  assert.deepEqual(report(s2, { m: { uncachedInput: 1, cacheRead: 1, output: 1 } }).byModel.m,
    { uncachedInput: 150, cacheRead: 50, output: 30 });
});

test('delta events accumulate; multiple streams of a model sum', () => {
  const s = createLedger();
  ingest(s, delta('a', 's1', 'm', 1, 100, 60, 10));
  ingest(s, delta('b', 's1', 'm', 2, 50, 20, 5));
  ingest(s, delta('c', 's2', 'm', 1, 30, 0, 3));
  ingest(s, delta('d', 's3', 'other', 1, 10, 10, 1));
  const r = report(s, { m: { uncachedInput: 1, cacheRead: 2, output: 3 }, other: { uncachedInput: 1, cacheRead: 1, output: 1 } });
  // m: s1 unc 100-60 + 50-20 = 70, cached 80, out 15 ; s2 unc 30, cached 0, out 3
  assert.deepEqual(r.byModel.m, { uncachedInput: 100, cacheRead: 80, output: 18 });
  assert.deepEqual(r.byModel.other, { uncachedInput: 0, cacheRead: 10, output: 1 });
  assert.equal(r.complete, true);
  // 100*1 + 80*2 + 18*3 = 100+160+54 = 314 /1e6 ; other: 0 + 10*1 + 1*1 = 11/1e6
  assert.equal(r.totalUsd, 325 / 1e6);
});

test('cumulative uses only the latest snapshot (no summing)', () => {
  const s = createLedger();
  ingest(s, cum('a', 'x', 'm', 1, 100, 40, 10));
  ingest(s, cum('b', 'x', 'm', 2, 150, 60, 12));
  ingest(s, cum('c', 'x', 'm', 3, 150, 90, 15)); // cached grows, input equal -> ok
  const r = report(s, { m: { uncachedInput: 5, cacheRead: 1, output: 2 } });
  assert.deepEqual(r.byModel.m, { uncachedInput: 60, cacheRead: 90, output: 15 });
  assert.equal(r.complete, true);
  assert.equal(r.totalUsd, (60 * 5 + 90 * 1 + 15 * 2) / 1e6);
});

test('a stream keeps one model and one kind', () => {
  const s = createLedger();
  ingest(s, delta('a', 'x', 'm', 1, 1, 0, 1));
  bytesUnchanged(s, () => ingest(s, delta('b', 'x', 'n', 2, 1, 0, 1))); // model switch
  bytesUnchanged(s, () => ingest(s, cum('c', 'x', 'm', 2, 1, 0, 1))); // kind switch
  ingest(s, delta('d', 'x', 'm', 3, 1, 0, 1)); // same model+kind, valid seq still fine
  // a different stream with different model/kind is allowed
  ingest(s, cum('e', 'y', 'n', 1, 5, 5, 5));
  assert.deepEqual(report(s, { m: { uncachedInput: 1, cacheRead: 1, output: 1 }, n: { uncachedInput: 1, cacheRead: 1, output: 1 } }).byModel.m,
    { uncachedInput: 2, cacheRead: 0, output: 2 });
});

test('out-of-order and repeated seq with a new id are rejected', () => {
  const s = createLedger();
  ingest(s, delta('a', 'x', 'm', 5, 10, 0, 1));
  bytesUnchanged(s, () => ingest(s, delta('b', 'x', 'm', 4, 1, 0, 1))); // out of order
  bytesUnchanged(s, () => ingest(s, delta('c', 'x', 'm', 5, 1, 0, 1))); // repeated seq
  // a new valid seq still works afterwards
  ingest(s, delta('d', 'x', 'm', 6, 1, 0, 1));
  // fresh stream may start at any nonnegative seq
  const t = createLedger();
  ingest(t, delta('z', 'y', 'm', 7, 1, 0, 1));
});

test('cumulative counters must never decrease individually', () => {
  const s = createLedger();
  ingest(s, cum('a', 'x', 'm', 1, 100, 50, 20));
  bytesUnchanged(s, () => ingest(s, cum('b', 'x', 'm', 2, 90, 50, 20))); // input down
  bytesUnchanged(s, () => ingest(s, cum('c', 'x', 'm', 2, 100, 40, 20))); // cached down
  bytesUnchanged(s, () => ingest(s, cum('d', 'x', 'm', 2, 100, 50, 19))); // output down
  ingest(s, cum('e', 'x', 'm', 2, 100, 50, 20)); // equal values are fine
});

test('conflicting reuse of an id throws without touching state', () => {
  const s = createLedger();
  ingest(s, delta('a', 'x', 'm', 1, 100, 40, 10));
  const cases = [
    delta('a', 'x', 'm', 2, 100, 40, 10),   // different seq
    delta('a', 'x', 'm', 1, 101, 40, 10),   // different input
    delta('a', 'y', 'm', 1, 100, 40, 10),   // different stream
    delta('a', 'x', 'n', 1, 100, 40, 10),   // different model
    cum('a', 'x', 'm', 1, 100, 40, 10),     // different kind
  ];
  for (const ev of cases) bytesUnchanged(s, () => ingest(s, ev));
  // global uniqueness across streams: id used on another stream with same content
  const t = createLedger();
  ingest(t, delta('a', 'x', 'm', 1, 1, 0, 1));
  bytesUnchanged(t, () => ingest(t, delta('a', 'y', 'm', 1, 1, 0, 1)));
});

test('required scalar validation and unknown-is-not-zero', () => {
  const s = createLedger();
  const base = { id: 'x', stream: 's', model: 'm', seq: 1, kind: 'delta', input: 10, cachedInput: 0, output: 1 };
  bytesUnchanged(s, () => ingest(s, { ...base, id: '' }));
  bytesUnchanged(s, () => ingest(s, { ...base, id: undefined }));
  bytesUnchanged(s, () => ingest(s, { ...base, stream: '' }));
  bytesUnchanged(s, () => ingest(s, { ...base, model: '' }));
  bytesUnchanged(s, () => ingest(s, { ...base, seq: -1 }));
  bytesUnchanged(s, () => ingest(s, { ...base, seq: 1.5 }));
  bytesUnchanged(s, () => ingest(s, { ...base, seq: Number.MAX_SAFE_INTEGER + 1 }));
  bytesUnchanged(s, () => ingest(s, { ...base, seq: NaN }));
  bytesUnchanged(s, () => ingest(s, { ...base, kind: 'snapshot' }));
  bytesUnchanged(s, () => ingest(s, { ...base, kind: undefined }));
  bytesUnchanged(s, () => ingest(s, { ...base, input: undefined }));   // missing != 0
  bytesUnchanged(s, () => ingest(s, { ...base, cachedInput: undefined }));
  bytesUnchanged(s, () => ingest(s, { ...base, output: undefined }));
  bytesUnchanged(s, () => ingest(s, { ...base, input: -1 }));
  bytesUnchanged(s, () => ingest(s, { ...base, cachedInput: -1 }));
  bytesUnchanged(s, () => ingest(s, { ...base, output: 1.5 }));
  bytesUnchanged(s, () => ingest(s, { ...base, output: Infinity }));
  bytesUnchanged(s, () => ingest(s, { ...base, output: NaN }));
  bytesUnchanged(s, () => ingest(s, { ...base, input: '10' }));
  bytesUnchanged(s, () => ingest(s, { ...base, cachedInput: 11, input: 10 })); // cached > input
  ingest(s, { ...base, id: 'xe', cachedInput: 10, input: 10 }); // equal ok (no throw)
  bytesUnchanged(s, () => ingest(s, null));
  bytesUnchanged(s, () => ingest(s, 'nope'));
  bytesUnchanged(s, () => ingest(s, [1, 2]));
  // extra unknown fields tolerated; still ingested fine
  ingest(s, { ...base, id: 'y', seq: 2, extra: 'whatever', provider: 'p' });
  assert.deepEqual(Object.keys(s.ids), ['xe', 'y']);
});

test('rejections leave state byte-for-byte unchanged even mid-sequence', () => {
  const s = createLedger();
  ingest(s, delta('a', 's1', 'm', 1, 100, 40, 10));
  ingest(s, cum('b', 's2', 'm', 1, 500, 200, 60));
  const before = snap(s);
  const attempts = [
    () => ingest(s, delta('a', 's1', 'm', 2, 1, 0, 1)),           // conflict reuse
    () => ingest(s, delta('c', 's1', 'm', 0, 1, 0, 1)),           // out of order
    () => ingest(s, cum('d', 's2', 'm', 2, 400, 200, 60)),        // cumulative decrease
    () => ingest(s, delta('e', 's3', 'm', 1, 1, 5, 1)),           // cached > input
    () => ingest(s, { id: 'f', stream: 's3', model: 'm', seq: -1, kind: 'delta', input: 1, cachedInput: 0, output: 1 }), // bad seq
    () => ingest(s, { id: 'f', stream: 's3', model: 'm', seq: 1, kind: 'delta', input: 1, cachedInput: 0 }), // missing output
  ];
  for (const fn of attempts) {
    assert.throws(fn);
    assert.equal(snap(s), before);
  }
});

test('safe-integer overflow on delta accumulation is rejected atomically', () => {
  const s = createLedger();
  const M = Number.MAX_SAFE_INTEGER;
  ingest(s, delta('a', 'x', 'm', 1, M, 0, 1));
  bytesUnchanged(s, () => ingest(s, delta('b', 'x', 'm', 2, M, 0, 1))); // 2*M not safe
  // cumulative with huge but valid values is fine (no summing)
  const t = createLedger();
  ingest(t, cum('a', 'y', 'n', 1, M, 0, M));
  assert.deepEqual(report(t, { n: { uncachedInput: 1, cacheRead: 1, output: 1 } }).byModel.n,
    { uncachedInput: M, cacheRead: 0, output: M });
});

test('missing/invalid rates for an actually used model -> complete:false, totalUsd:null, totals kept', () => {
  const s = createLedger();
  ingest(s, delta('a', 's1', 'm', 1, 100, 60, 10));
  ingest(s, delta('b', 's2', 'm', 1, 50, 0, 5));
  const good = { m: { uncachedInput: 1, cacheRead: 1, output: 1 } };
  const missing = report(s, {});                       // model 'm' has no rates
  assert.equal(missing.complete, false);
  assert.equal(missing.totalUsd, null);
  assert.deepEqual(missing.byModel.m, { uncachedInput: 90, cacheRead: 60, output: 15 });
  const onlyOther = report(s, { other: good.m });
  assert.equal(onlyOther.complete, false);
  assert.deepEqual(onlyOther.byModel.m, { uncachedInput: 90, cacheRead: 60, output: 15 });

  for (const badRates of [
    { m: null },
    { m: { uncachedInput: -1, cacheRead: 1, output: 1 } },
    { m: { uncachedInput: NaN, cacheRead: 1, output: 1 } },
    { m: { uncachedInput: Infinity, cacheRead: 1, output: 1 } },
    { m: { uncachedInput: 1, cacheRead: 1, output: 'x' } },
    { m: { uncachedInput: 1 } },
  ]) {
    const r = report(s, badRates);
    assert.equal(r.complete, false, JSON.stringify(badRates));
    assert.equal(r.totalUsd, null);
    assert.deepEqual(r.byModel.m, { uncachedInput: 90, cacheRead: 60, output: 15 });
  }
  assert.equal(report(s, null).complete, false);
  // extra unused models in rates do not hurt
  assert.equal(report(s, { m: good.m, unused: { uncachedInput: 9, cacheRead: 9, output: 9 } }).complete, true);
  // zero rates are fine
  assert.equal(report(s, { m: { uncachedInput: 0, cacheRead: 0, output: 0 } }).totalUsd, 0);
});

test('cumulative snapshots from several streams of one model sum the latest only', () => {
  const s = createLedger();
  ingest(s, cum('a', 'x1', 'm', 1, 1000, 900, 40));
  ingest(s, cum('b', 'x1', 'm', 2, 1200, 1000, 50)); // latest for x1
  ingest(s, cum('c', 'x2', 'm', 1, 800, 700, 30));
  const r = report(s, { m: { uncachedInput: 3, cacheRead: 1, output: 2 } });
  // uncached: (1200-1000)+(800-700) = 300 ; cached 1700 ; out 80
  assert.deepEqual(r.byModel.m, { uncachedInput: 300, cacheRead: 1700, output: 80 });
  assert.equal(r.totalUsd, (300 * 3 + 1700 * 1 + 80 * 2) / 1e6);
});

test('report does not mutate state or rates', () => {
  const s = createLedger();
  ingest(s, delta('a', 's1', 'm', 1, 100, 40, 10));
  const before = snap(s);
  const rates = { m: { uncachedInput: 10, cacheRead: 1, output: 50 } };
  report(s, rates);
  report(s, {});
  assert.equal(snap(s), before);
  assert.deepEqual(rates, { m: { uncachedInput: 10, cacheRead: 1, output: 50 } });
});

test('ingest returns undefined and mutates in place (same object identity)', () => {
  const s = createLedger();
  assert.equal(ingest(s, delta('a', 'x', 'm', 1, 1, 0, 1)), undefined);
  assert.equal(ingest(s, delta('a', 'x', 'm', 1, 1, 0, 1)), undefined); // replay
  assert.equal(s.streams.x.input, 1);
  assert.equal(s.ids.a.seq, 1);
});

test('hostile key names do not break the ledger', () => {
  const s = createLedger();
  ingest(s, delta('a', '__proto__', 'constructor', 1, 10, 4, 1));
  ingest(s, delta('b', 'toString', 'hasOwnProperty', 1, 5, 0, 2));
  const r = report(s, {
    constructor: { uncachedInput: 1, cacheRead: 1, output: 1 },
    hasOwnProperty: { uncachedInput: 1, cacheRead: 1, output: 1 },
  });
  assert.deepEqual(r.byModel.constructor, { uncachedInput: 6, cacheRead: 4, output: 1 });
  assert.deepEqual(r.byModel.hasOwnProperty, { uncachedInput: 5, cacheRead: 0, output: 2 });
  assert.equal(r.complete, true);
  // survives round trip too
  const s2 = JSON.parse(JSON.stringify(s));
  ingest(s2, delta('a', '__proto__', 'constructor', 1, 10, 4, 1)); // replay no-op
  assert.deepEqual(report(s2, {
    constructor: { uncachedInput: 1, cacheRead: 1, output: 1 },
    hasOwnProperty: { uncachedInput: 1, cacheRead: 1, output: 1 },
  }), r);
});
