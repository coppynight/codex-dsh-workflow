import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, ingest, report } from './usage-ledger.mjs';

const R = { m: { uncachedInput: 10, cacheRead: 1, output: 50 } };

function ev(id, stream, model, seq, kind, input, cachedInput, output) {
  return { id, stream, model, seq, kind, input, cachedInput, output };
}

test('empty ledger', () => {
  const r = report(createLedger(), {});
  assert.deepEqual(r, { complete: true, totalUsd: 0, byModel: {} });
});

test('round trip preserves empty state', () => {
  const s = JSON.parse(JSON.stringify(createLedger()));
  assert.deepEqual(report(s, {}), { complete: true, totalUsd: 0, byModel: {} });
});

test('visible scenario', () => {
  const s = createLedger();
  ingest(s, ev('1', 's', 'm', 1, 'delta', 100, 80, 10));
  const r = report(s, { m: { uncachedInput: 10, cacheRead: 1, output: 50 } });
  assert.deepEqual(r.byModel.m, { uncachedInput: 20, cacheRead: 80, output: 10 });
  assert.equal(r.complete, true);
  assert.equal(r.totalUsd, 0.00078);
});

test('state survives JSON round trip and replay is no-op after restart', () => {
  const s = createLedger();
  ingest(s, ev('a', 's', 'm', 1, 'delta', 100, 80, 10));
  const copy = JSON.parse(JSON.stringify(s));
  const before = JSON.stringify(copy);
  // exact replay after restart -> no-op
  ingest(copy, ev('a', 's', 'm', 1, 'delta', 100, 80, 10));
  assert.equal(JSON.stringify(copy), before);
  // report identical
  assert.deepEqual(report(copy, R), report(s, R));
});

test('conflicting reuse throws without changing state', () => {
  const s = createLedger();
  ingest(s, ev('a', 's', 'm', 1, 'delta', 100, 80, 10));
  const before = JSON.stringify(s);
  assert.throws(() => ingest(s, ev('a', 's', 'm', 2, 'delta', 100, 80, 10)));
  assert.equal(JSON.stringify(s), before);
});

test('delta events sum; replay among them is no-op', () => {
  const s = createLedger();
  ingest(s, ev('d1', 's', 'm', 1, 'delta', 100, 80, 10));
  ingest(s, ev('d2', 's', 'm', 2, 'delta', 50, 0, 5));
  ingest(s, ev('d1', 's', 'm', 1, 'delta', 100, 80, 10)); // replay
  const r = report(s, R);
  assert.deepEqual(r.byModel.m, { uncachedInput: 70, cacheRead: 80, output: 15 });
});

test('cumulative counts only latest totals, not summed snapshots', () => {
  const s = createLedger();
  ingest(s, ev('c1', 't', 'm', 1, 'cumulative', 100, 80, 10));
  ingest(s, ev('c2', 't', 'm', 2, 'cumulative', 250, 200, 40));
  const r = report(s, R);
  // latest only: uncached=50, cache=200, output=40
  assert.deepEqual(r.byModel.m, { uncachedInput: 50, cacheRead: 200, output: 40 });
});

test('mixed streams same model are summed', () => {
  const s = createLedger();
  ingest(s, ev('c1', 't1', 'm', 1, 'cumulative', 100, 80, 10));
  ingest(s, ev('d1', 't2', 'm', 1, 'delta', 50, 20, 30));
  const r = report(s, R);
  assert.deepEqual(r.byModel.m, { uncachedInput: 50, cacheRead: 100, output: 40 });
});

test('out-of-order and repeated seq rejected with new id', () => {
  const s = createLedger();
  ingest(s, ev('a', 's', 'm', 5, 'delta', 1, 0, 0));
  const before = JSON.stringify(s);
  assert.throws(() => ingest(s, ev('b', 's', 'm', 4, 'delta', 1, 0, 0))); // lower
  assert.throws(() => ingest(s, ev('c', 's', 'm', 5, 'delta', 1, 0, 0))); // equal
  assert.equal(JSON.stringify(s), before);
});

test('cumulative decrease rejected atomically', () => {
  const s = createLedger();
  ingest(s, ev('c1', 't', 'm', 1, 'cumulative', 100, 80, 10));
  const before = JSON.stringify(s);
  assert.throws(() => ingest(s, ev('c2', 't', 'm', 2, 'cumulative', 90, 80, 10)));
  assert.equal(JSON.stringify(s), before);
});

test('stream keeps one model and one kind', () => {
  const s = createLedger();
  ingest(s, ev('a', 's', 'm1', 1, 'delta', 1, 0, 0));
  assert.throws(() => ingest(s, ev('b', 's', 'm2', 2, 'delta', 1, 0, 0)));
  assert.throws(() => ingest(s, ev('c', 's', 'm1', 2, 'cumulative', 1, 0, 0)));
});

test('invalid events rejected atomically', () => {
  const base = () => ev('x', 's', 'm', 1, 'delta', 10, 5, 3);
  const cases = [
    { ...base(), id: '' },
    { ...base(), id: 3 },
    { ...base(), stream: '' },
    { ...base(), model: '' },
    { ...base(), kind: 'nope' },
    { ...base(), kind: undefined },
    { ...base(), seq: -1 },
    { ...base(), seq: 1.5 },
    { ...base(), input: -2 },
    { ...base(), input: Number.MAX_SAFE_INTEGER + 1 },
    { ...base(), input: undefined },
    { ...base(), cachedInput: 99, input: 10 }, // cached > input
    { ...base(), output: 'x' },
    { ...base(), output: undefined },
    { ...base(), cachedInput: undefined },
  ];
  for (const c of cases) {
    const s = createLedger();
    const before = JSON.stringify(s);
    assert.throws(() => ingest(s, c), `should reject ${JSON.stringify(c)}`);
    assert.equal(JSON.stringify(s), before);
  }
});

test('missing rates -> complete false, totalUsd null, totals preserved', () => {
  const s = createLedger();
  ingest(s, ev('a', 's', 'm', 1, 'delta', 100, 80, 10));
  const r = report(s, {});
  assert.equal(r.complete, false);
  assert.equal(r.totalUsd, null);
  assert.deepEqual(r.byModel.m, { uncachedInput: 20, cacheRead: 80, output: 10 });
});

test('invalid rates -> complete false, totalUsd null', () => {
  const s = createLedger();
  ingest(s, ev('a', 's', 'm', 1, 'delta', 100, 80, 10));
  for (const bad of [
    { m: { uncachedInput: -1, cacheRead: 1, output: 50 } },
    { m: { uncachedInput: NaN, cacheRead: 1, output: 50 } },
    { m: { uncachedInput: Infinity, cacheRead: 1, output: 50 } },
    { m: { uncachedInput: 1, cacheRead: 1 } },
    null,
  ]) {
    const r = report(s, bad);
    assert.equal(r.complete, false);
    assert.equal(r.totalUsd, null);
    assert.deepEqual(r.byModel.m, { uncachedInput: 20, cacheRead: 80, output: 10 });
  }
});

test('rates may be zero and yield zero cost', () => {
  const s = createLedger();
  ingest(s, ev('a', 's', 'm', 1, 'delta', 100, 80, 10));
  const r = report(s, { m: { uncachedInput: 0, cacheRead: 0, output: 0 } });
  assert.equal(r.complete, true);
  assert.equal(r.totalUsd, 0);
});

test('hostile model/stream names do not corrupt state', () => {
  const s = createLedger();
  ingest(s, ev('1', '__proto__', 'constructor', 1, 'delta', 100, 80, 10));
  ingest(s, ev('2', 'constructor', 'toString', 1, 'delta', 50, 20, 5));
  const r = report(s, {
    constructor: { uncachedInput: 10, cacheRead: 1, output: 50 },
    toString: { uncachedInput: 10, cacheRead: 1, output: 50 },
  });
  assert.ok(r.complete);
  assert.deepEqual(r.byModel.constructor, { uncachedInput: 20, cacheRead: 80, output: 10 });
  assert.deepEqual(r.byModel.toString, { uncachedInput: 30, cacheRead: 20, output: 5 });
  // round trip still intact
  const copy = JSON.parse(JSON.stringify(s));
  const r2 = report(copy, {
    constructor: { uncachedInput: 10, cacheRead: 1, output: 50 },
    toString: { uncachedInput: 10, cacheRead: 1, output: 50 },
  });
  assert.deepEqual(r2, r);
});

test('no rounding of internal cost', () => {
  const s = createLedger();
  ingest(s, ev('a', 's', 'm', 1, 'delta', 1, 0, 0));
  const r = report(s, { m: { uncachedInput: 1, cacheRead: 1, output: 1 } });
  assert.equal(r.complete, true);
  assert.equal(r.totalUsd, 1 / 1e6);
});

test('repeated ingestion of a new id is not a replay across different streams', () => {
  // same id reused on a *different* stream is still a global-id conflict
  const s = createLedger();
  ingest(s, ev('a', 's1', 'm', 1, 'delta', 10, 0, 0));
  assert.throws(() => ingest(s, ev('a', 's2', 'm', 1, 'delta', 10, 0, 0)));
});

test('large delta accumulation overflow is rejected atomically', () => {
  const big = Number.MAX_SAFE_INTEGER;
  const s = createLedger();
  ingest(s, ev('a', 's', 'm', 1, 'delta', big, 0, 0));
  const before = JSON.stringify(s);
  assert.throws(() => ingest(s, ev('b', 's', 'm', 2, 'delta', big, 0, 0)));
  assert.equal(JSON.stringify(s), before);
});
