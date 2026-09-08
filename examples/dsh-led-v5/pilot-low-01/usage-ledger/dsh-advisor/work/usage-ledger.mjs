// usage-ledger.mjs
// A deterministic usage ledger with atomic ingestion, idempotent replays and
// JSON round-trip-safe state.

function isNonemptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isSafeNonnegInt(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function isPlainRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Object-as-map helpers that are safe even after a JSON.stringify/parse round
// trip (when prototype safety is lost) and against hostile keys such as
// "__proto__" or "constructor".
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function safeGet(obj, key) {
  return hasOwn(obj, key) ? obj[key] : undefined;
}

function safeSet(obj, key, value) {
  Object.defineProperty(obj, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Produce a fresh, empty ledger state.
 * The state is a plain JSON round-trip-safe structure: two string-keyed maps.
 *   ids:     { id: canonicalSignature }
 *   streams: { stream: { model, kind, lastSeq, input, cached, output } }
 */
export function createLedger() {
  return {
    ids: Object.create(null),
    streams: Object.create(null),
  };
}

// Canonical signature of the semantically meaningful fields of an event.
// Used to recognise exact replays of an id and to detect conflicting reuse.
function signature(event) {
  return JSON.stringify([
    event.stream,
    event.model,
    event.seq,
    event.kind,
    event.input,
    event.cachedInput,
    event.output,
  ]);
}

// Throws if an (id-new) event is malformed in any way.
function validateEvent(event) {
  if (!isNonemptyString(event.id)) throw new Error('usage-ledger: invalid id');
  if (!isNonemptyString(event.stream)) {
    throw new Error('usage-ledger: invalid stream');
  }
  if (!isNonemptyString(event.model)) {
    throw new Error('usage-ledger: invalid model');
  }
  if (event.kind !== 'delta' && event.kind !== 'cumulative') {
    throw new Error('usage-ledger: invalid kind');
  }
  // seq and every usage counter must be present and valid. "Unknown" fields are
  // NOT treated as zero: a missing/invalid field rejects the event.
  if (!isSafeNonnegInt(event.seq)) {
    throw new Error('usage-ledger: invalid seq');
  }
  if (!isSafeNonnegInt(event.input)) {
    throw new Error('usage-ledger: invalid input');
  }
  if (!isSafeNonnegInt(event.cachedInput)) {
    throw new Error('usage-ledger: invalid cachedInput');
  }
  if (!isSafeNonnegInt(event.output)) {
    throw new Error('usage-ledger: invalid output');
  }
  if (event.cachedInput > event.input) {
    throw new Error('usage-ledger: cachedInput exceeds input');
  }
}

function addSafe(a, b) {
  const r = a + b;
  if (!Number.isSafeInteger(r)) {
    throw new Error('usage-ledger: safe-integer overflow');
  }
  return r;
}

/**
 * Ingest a single event into `state` in place.
 * - Exact replay of an id: no-op.
 * - Conflicting reuse of an id, or any other invalid event: throws, leaving
 *   state byte-for-byte unchanged (validation is completed before mutation).
 */
export function ingest(state, event) {
  if (!isPlainRecord(state)) throw new Error('usage-ledger: invalid state');
  if (!isPlainRecord(event)) throw new Error('usage-ledger: invalid event');
  if (!isNonemptyString(event.id)) throw new Error('usage-ledger: invalid id');

  const id = event.id;

  // id already seen -> exact replay is a no-op, any other use conflicts.
  if (hasOwn(state.ids, id)) {
    if (signature(event) === safeGet(state.ids, id)) {
      return; // exact replay: idempotent, nothing changes
    }
    throw new Error(`usage-ledger: conflicting reuse of id "${id}"`);
  }

  // New id: validate the whole event before doing any work.
  validateEvent(event);

  const stream = event.stream;
  const existing = hasOwn(state.streams, stream)
    ? safeGet(state.streams, stream)
    : null;

  if (existing) {
    if (existing.model !== event.model) {
      throw new Error('usage-ledger: stream model mismatch');
    }
    if (existing.kind !== event.kind) {
      throw new Error('usage-ledger: stream kind mismatch');
    }
    if (event.seq <= existing.lastSeq) {
      throw new Error('usage-ledger: out-of-order or repeated seq');
    }
  }

  // Compute the resulting stream record without mutating anything yet.
  let nextInput;
  let nextCached;
  let nextOutput;

  if (event.kind === 'cumulative') {
    if (existing) {
      // Cumulative running totals must never decrease individually.
      if (
        event.input < existing.input ||
        event.cachedInput < existing.cached ||
        event.output < existing.output
      ) {
        throw new Error('usage-ledger: cumulative counters decreased');
      }
    }
    // Count only the latest cumulative totals, not the sum of snapshots.
    nextInput = event.input;
    nextCached = event.cachedInput;
    nextOutput = event.output;
  } else {
    // delta events sum.
    const baseInput = existing ? existing.input : 0;
    const baseCached = existing ? existing.cached : 0;
    const baseOutput = existing ? existing.output : 0;
    nextInput = addSafe(baseInput, event.input);
    nextCached = addSafe(baseCached, event.cachedInput);
    nextOutput = addSafe(baseOutput, event.output);
  }

  const nextRec = {
    model: event.model,
    kind: event.kind,
    lastSeq: event.seq,
    input: nextInput,
    cached: nextCached,
    output: nextOutput,
  };

  // Commit atomically: record the id and the stream record.
  safeSet(state.ids, id, signature(event));
  safeSet(state.streams, stream, nextRec);
}

/**
 * Compute the usage report.
 * Returns { complete, totalUsd, byModel } where
 *   byModel[model] = { uncachedInput, cacheRead, output }
 * Sums usage across every stream of the same model. Missing/invalid rates for
 * an actually used model yield complete:false and totalUsd:null while still
 * reporting token totals. No internal rounding.
 */
export function report(state, rates) {
  const byModel = Object.create(null);

  const streamKeys = Object.keys(state.streams);
  for (let i = 0; i < streamKeys.length; i++) {
    const rec = safeGet(state.streams, streamKeys[i]);
    const model = rec.model;
    let agg = hasOwn(byModel, model) ? safeGet(byModel, model) : null;
    if (!agg) {
      agg = { uncachedInput: 0, cacheRead: 0, output: 0 };
      safeSet(byModel, model, agg);
    }
    // input is inclusive of cached input; uncached = input - cached.
    agg.uncachedInput += rec.input - rec.cached;
    agg.cacheRead += rec.cached;
    agg.output += rec.output;
  }

  const modelKeys = Object.keys(byModel);

  function validRate(r) {
    return (
      isPlainRecord(r) &&
      typeof r.uncachedInput === 'number' &&
      Number.isFinite(r.uncachedInput) &&
      r.uncachedInput >= 0 &&
      typeof r.cacheRead === 'number' &&
      Number.isFinite(r.cacheRead) &&
      r.cacheRead >= 0 &&
      typeof r.output === 'number' &&
      Number.isFinite(r.output) &&
      r.output >= 0
    );
  }

  let complete = true;
  for (let i = 0; i < modelKeys.length; i++) {
    const model = modelKeys[i];
    const rate = rates && isPlainRecord(rates) ? safeGet(rates, model) : undefined;
    if (!validRate(rate)) {
      complete = false;
      break;
    }
  }

  let totalUsd;
  if (complete) {
    totalUsd = 0;
    for (let i = 0; i < modelKeys.length; i++) {
      const model = modelKeys[i];
      const agg = safeGet(byModel, model);
      const rate = safeGet(rates, model);
      totalUsd +=
        (agg.uncachedInput * rate.uncachedInput +
          agg.cacheRead * rate.cacheRead +
          agg.output * rate.output) /
        1e6;
    }
  } else {
    totalUsd = null;
  }

  // Convert the null-prototype accumulator to a plain object for callers and
  // to keep the output JSON round-trip friendly / deepEqual-friendly.
  const outByModel = {};
  for (let i = 0; i < modelKeys.length; i++) {
    safeSet(outByModel, modelKeys[i], safeGet(byModel, modelKeys[i]));
  }

  return { complete, totalUsd, byModel: outByModel };
}
