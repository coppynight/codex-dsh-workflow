// usage-ledger.mjs — atomic, JSON-safe usage ledger.
// createLedger() -> empty state
// ingest(state, event) -> mutates state in place; every rejection leaves the
//   state unchanged (validation runs to completion before any mutation).
// report(state, rates) -> { complete, totalUsd, byModel }

const KINDS = new Set(['delta', 'cumulative']);

function nonEmptyStr(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`usage-ledger: invalid ${name}: must be a nonempty string`);
  }
  return value;
}

function nonNegSafeInt(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`usage-ledger: invalid ${name}: must be a nonnegative safe integer`);
  }
  return value;
}

function isFiniteNonNegRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function fingerprint(e) {
  // Semantic content of the event (its id is the map key).
  return JSON.stringify([
    e.stream, e.model, e.seq, e.kind, e.input, e.cachedInput, e.output,
  ]);
}

// Compute every intended effect of an event without mutating state.
// Returns either {noop:true} or a commit record, or throws (state untouched).
function plan(state, event) {
  if (state === null || typeof state !== 'object') {
    throw new Error('usage-ledger: state must be an object');
  }

  const id = nonEmptyStr(event.id, 'id');
  const stream = nonEmptyStr(event.stream, 'stream');
  const model = nonEmptyStr(event.model, 'model');
  const seq = nonNegSafeInt(event.seq, 'seq');
  if (!KINDS.has(event.kind)) {
    throw new Error(`usage-ledger: invalid kind: ${String(event.kind)}`);
  }
  const kind = event.kind;

  const input = nonNegSafeInt(event.input, 'input');
  const cachedInput = nonNegSafeInt(event.cachedInput, 'cachedInput');
  const output = nonNegSafeInt(event.output, 'output');
  if (cachedInput > input) {
    throw new Error('usage-ledger: cachedInput must not exceed input');
  }
  const uncached = input - cachedInput; // >= 0

  const models = requireObj(state, 'models');
  const streams = requireObj(state, 'streams');
  const ids = requireObj(state, 'ids');

  // --- id replay / conflicting reuse -------------------------------------
  if (Object.prototype.hasOwnProperty.call(ids, id)) {
    const sig = fingerprint(event);
    if (ids[id] === sig) return { noop: true }; // exact replay -> no-op
    throw new Error(`usage-ledger: conflicting reuse of id "${id}"`);
  }

  // --- stream invariants + sequence ordering ------------------------------
  const existing = streams[stream];
  if (existing) {
    if (existing.model !== model) {
      throw new Error(`usage-ledger: stream "${stream}" already uses model "${existing.model}"`);
    }
    if (existing.kind !== kind) {
      throw new Error(`usage-ledger: stream "${stream}" already uses kind "${existing.kind}"`);
    }
    if (seq <= existing.seq) {
      throw new Error(`usage-ledger: out-of-order or repeated seq ${seq} on stream "${stream}"`);
    }
  }

  const base = Object.prototype.hasOwnProperty.call(models, model)
    ? models[model]
    : null;
  const bU = base ? base.uncachedInput : 0;
  const bC = base ? base.cacheRead : 0;
  const bO = base ? base.output : 0;

  // Block currently counted toward the model from this (cumulative) stream.
  const prev = existing && existing.kind === 'cumulative' ? existing.contrib : null;
  const pU = prev ? prev.uncachedInput : 0;
  const pC = prev ? prev.cacheRead : 0;
  const pO = prev ? prev.output : 0;

  let mU, mC, mO, contrib;
  if (kind === 'delta') {
    mU = bU + uncached;
    mC = bC + cachedInput;
    mO = bO + output;
    contrib = null; // deltas aggregate directly
  } else {
    if (uncached < pU || cachedInput < pC || output < pO) {
      throw new Error(`usage-ledger: cumulative counters decreased on stream "${stream}"`);
    }
    mU = bU - pU + uncached;
    mC = bC - pC + cachedInput;
    mO = bO - pO + output;
    contrib = { uncachedInput: uncached, cacheRead: cachedInput, output };
  }

  for (const v of [mU, mC, mO]) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new Error('usage-ledger: safe-integer overflow in ledger totals');
    }
  }

  return { noop: false, id, stream, model, kind, seq, sig: fingerprint(event), contrib, mU, mC, mO };
}

function apply(state, p) {
  const models = state.models;
  const streams = state.streams;
  const ids = state.ids;

  const modelRec = Object.prototype.hasOwnProperty.call(models, p.model)
    ? models[p.model]
    : (models[p.model] = { uncachedInput: 0, cacheRead: 0, output: 0 });
  modelRec.uncachedInput = p.mU;
  modelRec.cacheRead = p.mC;
  modelRec.output = p.mO;

  const streamRec = Object.prototype.hasOwnProperty.call(streams, p.stream)
    ? streams[p.stream]
    : (streams[p.stream] = {});
  streamRec.model = p.model;
  streamRec.kind = p.kind;
  streamRec.seq = p.seq;
  if (p.contrib) {
    streamRec.contrib = p.contrib;
  } else {
    delete streamRec.contrib;
  }

  ids[p.id] = p.sig;
}

function requireObj(map, key) {
  if (!Object.prototype.hasOwnProperty.call(map, key)) {
    const rec = {};
    map[key] = rec;
    return rec;
  }
  return map[key];
}

export function createLedger() {
  return { models: {}, streams: {}, ids: {} };
}

export function ingest(state, event) {
  const p = plan(state, event);
  if (p.noop) return state;
  apply(state, p);
  return state;
}

export function report(state, rates) {
  if (state === null || typeof state !== 'object') {
    throw new Error('usage-ledger: state must be an object');
  }
  const models = Object.prototype.hasOwnProperty.call(state, 'models')
    ? state.models
    : {};

  const used = [];
  const byModel = {};
  for (const name of Object.keys(models)) {
    const rec = models[name];
    const row = {
      uncachedInput: rec.uncachedInput,
      cacheRead: rec.cacheRead,
      output: rec.output,
    };
    byModel[name] = row;
    used.push({ name, row });
  }

  if (used.length === 0) {
    return { complete: true, totalUsd: 0, byModel: {} };
  }

  const ratesObj = rates !== null && typeof rates === 'object' ? rates : {};

  let complete = true;
  let totalUsd = 0;

  for (const { name, row } of used) {
    const r = ratesObj[name];
    const ok = r !== null && typeof r === 'object'
      && isFiniteNonNegRate(r.uncachedInput)
      && isFiniteNonNegRate(r.cacheRead)
      && isFiniteNonNegRate(r.output);
    if (!ok) {
      complete = false;
      continue;
    }
    totalUsd +=
      row.uncachedInput / 1e6 * r.uncachedInput +
      row.cacheRead / 1e6 * r.cacheRead +
      row.output / 1e6 * r.output;
  }

  if (!complete) {
    return { complete: false, totalUsd: null, byModel };
  }
  return { complete: true, totalUsd, byModel };
}
