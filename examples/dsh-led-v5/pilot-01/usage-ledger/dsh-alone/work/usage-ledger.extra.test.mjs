// usage-ledger.extra.test.mjs — additional checks beyond visible.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, ingest, report } from './usage-ledger.mjs';

const M = Number.MAX_SAFE_INTEGER;

const mk = (over) => ({
  id: 'e1', stream: 's', model: 'm', seq: 1, kind: 'delta',
  input: 100, cachedInput: 80, output: 10,
  ...over,
});

const snap = (s) => JSON.stringify(s);

test('createLedger yields empty, independent states', () => {
  const a = createLedger();
  const b = createLedger();
  ingest(a, mk({}));
  assert.deepEqual(report(a, { m: { uncachedInput: 1, cacheRead: 1, output: 1 } }).byModel.m, { uncachedInput: 20, cacheRead: 80, output: 10 });
  assert.deepEqual(report(b, {}), { complete: true, totalUsd: 0, byModel: {} });
});

test('empty ledger: complete with zero cost regardless of rates', () => {
  const s = createLedger();
  assert.deepEqual(report(s, {}), { complete: true, totalUsd: 0, byModel: {} });
  assert.deepEqual(report(s, null), { complete: true, totalUsd: 0, byModel: {} });
  assert.deepEqual(report(s, { m: { uncachedInput: NaN, cacheRead: -1, output: Infinity } }), { complete: true, totalUsd: 0, byModel: {} });
});

test('delta events sum across streams of the same model', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's1', model: 'm', seq: 1, kind: 'delta', input: 100, cachedInput: 40, output: 10 });
  ingest(s, { id: 'b', stream: 's1', model: 'm', seq: 2, kind: 'delta', input: 50, cachedInput: 50, output: 5 });
  ingest(s, { id: 'c', stream: 's2', model: 'm', seq: 7, kind: 'delta', input: 200, cachedInput: 0, output: 20 });
  const r = report(s, { m: { uncachedInput: 10, cacheRead: 1, output: 50 } });
  assert.deepEqual(r.byModel.m, { uncachedInput: 260, cacheRead: 90, output: 35 });
  assert.equal(r.complete, true);
  assert.equal(r.totalUsd, 0.00444); // (260*10 + 90*1 + 35*50) / 1e6
});

test('cumulative streams count latest snapshot only, never sum snapshots', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 'c1', model: 'm', seq: 1, kind: 'cumulative', input: 100, cachedInput: 60, output: 5 });
  ingest(s, { id: 'b', stream: 'c1', model: 'm', seq: 2, kind: 'cumulative', input: 300, cachedInput: 200, output: 15 });
  ingest(s, { id: 'c', stream: 'c1', model: 'm', seq: 3, kind: 'cumulative', input: 300, cachedInput: 250, output: 40 });
  const r = report(s, { m: { uncachedInput: 5, cacheRead: 1, output: 2 } });
  assert.deepEqual(r.byModel.m, { uncachedInput: 50, cacheRead: 250, output: 40 });
  assert.equal(r.totalUsd, (50 * 5 + 250 * 1 + 40 * 2) / 1e6);
});

test('mixed delta and cumulative streams for one model are summed', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 'd', model: 'm', seq: 1, kind: 'delta', input: 100, cachedInput: 0, output: 10 });
  ingest(s, { id: 'b', stream: 'c', model: 'm', seq: 4, kind: 'cumulative', input: 500, cachedInput: 400, output: 50 });
  const r = report(s, { m: { uncachedInput: 1, cacheRead: 2, output: 3 } });
  assert.deepEqual(r.byModel.m, { uncachedInput: 200, cacheRead: 400, output: 60 });
});

test('multiple models are reported separately', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's1', model: 'x', seq: 1, kind: 'delta', input: 100, cachedInput: 0, output: 10 });
  ingest(s, { id: 'b', stream: 's2', model: 'y', seq: 1, kind: 'delta', input: 50, cachedInput: 0, output: 5 });
  const r = report(s, {
    x: { uncachedInput: 1, cacheRead: 1, output: 1 },
    y: { uncachedInput: 10, cacheRead: 10, output: 10 },
  });
  assert.deepEqual(r.byModel, {
    x: { uncachedInput: 100, cacheRead: 0, output: 10 },
    y: { uncachedInput: 50, cacheRead: 0, output: 5 },
  });
  assert.equal(r.complete, true);
  assert.equal(r.totalUsd, (100 * 1 + 10 * 1 + 50 * 10 + 5 * 10) / 1e6);
});

test('exact replay is a no-op, including after a JSON round-trip', () => {
  const s = createLedger();
  ingest(s, mk({}));
  const before = snap(s);
  ingest(s, mk({})); // identical replay
  assert.equal(snap(s), before);

  const s2 = JSON.parse(JSON.stringify(s));
  ingest(s2, mk({})); // replay after restart: still a no-op
  assert.equal(snap(s2), snap(s));
  // state still usable for new events after restart
  ingest(s2, mk({ id: 'e2', seq: 2 }));
  assert.deepEqual(report(s2, { m: { uncachedInput: 1, cacheRead: 1, output: 1 } }).byModel.m, { uncachedInput: 40, cacheRead: 160, output: 20 });
});

test('conflicting id reuse throws without changing state', () => {
  const s = createLedger();
  ingest(s, mk({}));
  const before = snap(s);
  assert.throws(() => ingest(s, mk({ input: 999 }))); // tokens differ
  assert.equal(snap(s), before);
  assert.throws(() => ingest(s, mk({ model: 'other' })));
  assert.equal(snap(s), before);
  assert.throws(() => ingest(s, mk({ seq: 7 })));
  assert.equal(snap(s), before);
  assert.throws(() => ingest(s, mk({ stream: 'other' })));
  assert.equal(snap(s), before);
  assert.throws(() => ingest(s, mk({ kind: 'cumulative' })));
  assert.equal(snap(s), before);
});

test('out-of-order or repeated seq with a new id is rejected atomically', () => {
  const s = createLedger();
  ingest(s, mk({})); // seq 1
  ingest(s, mk({ id: 'e2', seq: 5 })); // gaps allowed
  const before = snap(s);
  assert.throws(() => ingest(s, mk({ id: 'e3', seq: 5 }))); // repeat
  assert.equal(snap(s), before);
  assert.throws(() => ingest(s, mk({ id: 'e4', seq: 3 }))); // out of order
  assert.equal(snap(s), before);
  ingest(s, mk({ id: 'e5', seq: 6 })); // fine
});

test('stream model and kind are fixed for the lifetime of the stream', () => {
  const s = createLedger();
  ingest(s, mk({}));
  const before = snap(s);
  assert.throws(() => ingest(s, mk({ id: 'e2', seq: 2, model: 'n' })));
  assert.equal(snap(s), before);
  assert.throws(() => ingest(s, mk({ id: 'e2', seq: 2, kind: 'cumulative' })));
  assert.equal(snap(s), before);
});

test('cumulative counters may never decrease individually', () => {
  const s = createLedger();
  ingest(s, mk({ id: 'a', kind: 'cumulative', input: 100, cachedInput: 60, output: 5 }));
  const before = snap(s);
  assert.throws(() => ingest(s, mk({ id: 'b', seq: 2, kind: 'cumulative', input: 90, cachedInput: 60, output: 5 })));
  assert.equal(snap(s), before);
  assert.throws(() => ingest(s, mk({ id: 'b', seq: 2, kind: 'cumulative', input: 100, cachedInput: 50, output: 5 })));
  assert.equal(snap(s), before);
  assert.throws(() => ingest(s, mk({ id: 'b', seq: 2, kind: 'cumulative', input: 100, cachedInput: 60, output: 4 })));
  assert.equal(snap(s), before);
  ingest(s, mk({ id: 'b', seq: 2, kind: 'cumulative', input: 100, cachedInput: 60, output: 5 })); // equal is fine
});

test('malformed events are rejected without mutation', () => {
  const s = createLedger();
  ingest(s, mk({}));
  const before = snap(s);
  const bad = [
    mk({ id: '' }), mk({ id: undefined }), mk({ id: 5 }),
    mk({ stream: '' }), mk({ stream: undefined }),
    mk({ model: '' }), mk({ model: undefined }),
    mk({ seq: -1 }), mk({ seq: 1.5 }), mk({ seq: M + 1 }), mk({ seq: '2' }), mk({ seq: undefined }),
    mk({ kind: 'total' }), mk({ kind: undefined }),
    mk({ input: undefined }), mk({ input: -1 }), mk({ input: 1.5 }), mk({ input: '10' }), mk({ input: M + 1 }), mk({ input: NaN }),
    mk({ cachedInput: undefined }), mk({ cachedInput: -1 }),
    mk({ output: undefined }), mk({ output: -1 }),
    mk({ input: 10, cachedInput: 20 }), // cachedInput > input
    null, 'event', 5, [],
  ];
  for (const e of bad) {
    assert.throws(() => ingest(s, e));
    assert.equal(snap(s), before);
  }
  // fields are required: an omitted one must not silently become zero
  assert.throws(() => ingest(s, { id: 'z', stream: 'q', model: 'm', seq: 1, kind: 'delta', input: 5, cachedInput: 0 }));
  assert.equal(snap(s), before);
});

test('extra unknown event fields are ignored but do not break replays', () => {
  const s = createLedger();
  ingest(s, mk({ ts: 111 }));
  const before = snap(s);
  ingest(s, mk({ ts: 222 })); // canonical content identical -> replay
  assert.equal(snap(s), before);
});

test('delta totals are validated against the safe-integer range', () => {
  const s = createLedger();
  ingest(s, mk({ id: 'a', input: M, cachedInput: 0, output: 0 }));
  const before = snap(s);
  assert.throws(() => ingest(s, mk({ id: 'b', seq: 2, input: 1, cachedInput: 0, output: 0 })));
  assert.equal(snap(s), before);
  ingest(s, mk({ id: 'b', seq: 2, input: 0, cachedInput: 0, output: 0 })); // sum stays M: ok
  // cached sum overflow
  const s2 = createLedger();
  ingest(s2, mk({ id: 'a', input: M, cachedInput: M, output: 0 }));
  assert.throws(() => ingest(s2, mk({ id: 'b', seq: 2, input: M, cachedInput: 1, output: 0 })));
});

test('missing or invalid rates for a used model give incomplete with tokens preserved', () => {
  const s = createLedger();
  ingest(s, mk({}));
  const tokens = { uncachedInput: 20, cacheRead: 80, output: 10 };

  let r = report(s, {}); // missing rate
  assert.equal(r.complete, false);
  assert.equal(r.totalUsd, null);
  assert.deepEqual(r.byModel.m, tokens);

  r = report(s, null);
  assert.equal(r.complete, false);
  assert.equal(r.totalUsd, null);
  assert.deepEqual(r.byModel.m, tokens);

  r = report(s, { m: { uncachedInput: NaN, cacheRead: 1, output: 1 } });
  assert.equal(r.complete, false);
  assert.deepEqual(r.byModel.m, tokens);

  r = report(s, { m: { uncachedInput: 1, cacheRead: -1, output: 1 } });
  assert.equal(r.complete, false);
  assert.deepEqual(r.byModel.m, tokens);

  r = report(s, { m: { uncachedInput: 1, cacheRead: 1, output: Infinity } });
  assert.equal(r.complete, false);
  assert.deepEqual(r.byModel.m, tokens);

  r = report(s, { m: { uncachedInput: 1, cacheRead: '1', output: 1 } });
  assert.equal(r.complete, false);
  assert.deepEqual(r.byModel.m, tokens);

  r = report(s, { m: { uncachedInput: 1, output: 1 } }); // missing cacheRead
  assert.equal(r.complete, false);

  r = report(s, { m: 7 }); // rate entry is not an object
  assert.equal(r.complete, false);

  r = report(s, 42); // rates not an object at all
  assert.equal(r.complete, false);
  assert.deepEqual(r.byModel.m, tokens);
});

test('valid rates for a used model plus junk rates for unused models stay complete', () => {
  const s = createLedger();
  ingest(s, mk({}));
  const r = report(s, {
    m: { uncachedInput: 10, cacheRead: 1, output: 50 },
    ghost: { uncachedInput: NaN, cacheRead: -5, output: Infinity },
  });
  assert.equal(r.complete, true);
  assert.equal(r.totalUsd, 0.00078);
});

test('one missing rate poisons the whole report', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's1', model: 'x', seq: 1, kind: 'delta', input: 100, cachedInput: 0, output: 10 });
  ingest(s, { id: 'b', stream: 's2', model: 'y', seq: 1, kind: 'delta', input: 50, cachedInput: 0, output: 5 });
  const r = report(s, { x: { uncachedInput: 1, cacheRead: 1, output: 1 } });
  assert.equal(r.complete, false);
  assert.equal(r.totalUsd, null);
  assert.deepEqual(r.byModel.x, { uncachedInput: 100, cacheRead: 0, output: 10 });
  assert.deepEqual(r.byModel.y, { uncachedInput: 50, cacheRead: 0, output: 5 });
});

test('ledger state survives JSON round-trips while remaining fully functional', () => {
  const s = createLedger();
  ingest(s, mk({}));
  ingest(s, mk({ id: 'e2', seq: 2, input: 50, cachedInput: 50, output: 5 }));
  const parsed = JSON.parse(JSON.stringify(s));
  assert.deepEqual(report(parsed, { m: { uncachedInput: 1, cacheRead: 1, output: 1 } }),
    report(s, { m: { uncachedInput: 1, cacheRead: 1, output: 1 } }));
  // monotonic checks and ordering survive the round trip
  const before = snap(parsed);
  assert.throws(() => ingest(parsed, mk({ id: 'e3', seq: 1 }))); // out of order still caught
  assert.equal(snap(parsed), before);
  ingest(parsed, mk({ id: 'e3', seq: 3 }));
});

test('no internal rounding is applied to costs', () => {
  const s = createLedger();
  ingest(s, { id: 'a', stream: 's1', model: 'm', seq: 1, kind: 'delta', input: 1, cachedInput: 0, output: 1 });
  const r = report(s, { m: { uncachedInput: 1, cacheRead: 1, output: 1 } });
  assert.equal(r.totalUsd, 2e-6);
  assert.equal(r.totalUsd, (1 * 1 + 1 * 1) / 1e6);
});

test('report does not mutate the state', () => {
  const s = createLedger();
  ingest(s, mk({}));
  const before = snap(s);
  report(s, { m: { uncachedInput: 1, cacheRead: 1, output: 1 } });
  report(s, {});
  report(s, null);
  assert.equal(snap(s), before);
});
