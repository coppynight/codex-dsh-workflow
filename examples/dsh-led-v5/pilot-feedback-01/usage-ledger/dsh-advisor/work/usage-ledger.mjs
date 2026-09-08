const MAX = Number.MAX_SAFE_INTEGER;

function isNonnegSafeInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function nonemptyStr(v) {
  return typeof v === 'string' && v.length > 0;
}

function isFiniteNonneg(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// Return a null-prototype object holding the same own enumerable properties as o
// (a no-op when o is already null-prototype). Avoids prototype-pollution pitfalls
// for arbitrary stream/id keys, especially after a JSON round-trip.
function ensureNullProto(o) {
  if (o === null || o === undefined) return Object.create(null);
  if (Object.getPrototypeOf(o) === null) return o;
  const np = Object.create(null);
  for (const k of Object.keys(o)) np[k] = o[k];
  return np;
}

export function createLedger() {
  return {
    ids: Object.create(null),
    streams: Object.create(null),
  };
}

/**
 * Atomically ingest one usage event into `state`.
 * On success it mutates `state` in place and returns `state`.
 * On any rejection it throws and leaves `state` unchanged.
 */
export function ingest(state, event) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('state must be an object produced by createLedger()');
  }
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('event must be an object');
  }

  const { id, stream, model, seq, kind, input, cachedInput, output } = event;

  // --- scalar validation (no mutation yet) ---
  if (!nonemptyStr(id)) throw new Error('event.id must be a nonempty string');
  if (!nonemptyStr(stream)) throw new Error('event.stream must be a nonempty string');
  if (!nonemptyStr(model)) throw new Error('event.model must be a nonempty string');
  if (kind !== 'delta' && kind !== 'cumulative') {
    throw new Error('event.kind must be "delta" or "cumulative"');
  }
  if (!isNonnegSafeInt(seq)) throw new Error('event.seq must be a nonnegative safe integer');
  if (!isNonnegSafeInt(input)) throw new Error('event.input must be a nonnegative safe integer');
  if (!isNonnegSafeInt(cachedInput)) throw new Error('event.cachedInput must be a nonnegative safe integer');
  if (!isNonnegSafeInt(output)) throw new Error('event.output must be a nonnegative safe integer');
  if (cachedInput > input) throw new Error('event.cachedInput cannot exceed event.input');

  // Existing containers may be plain objects after a JSON round-trip; normalize lazily.
  const ids = ensureNullProto(state.ids);
  const streams = ensureNullProto(state.streams);

  // --- idempotency: exact replay of an already-ingested id is a no-op ---
  const seen = ids[id];
  if (seen !== undefined) {
    if (
      seen[0] === stream &&
      seen[1] === model &&
      seen[2] === seq &&
      seen[3] === kind &&
      seen[4] === input &&
      seen[5] === cachedInput &&
      seen[6] === output
    ) {
      return state; // exact replay -> no-op
    }
    throw new Error(`id "${id}" reused with conflicting event`);
  }

  const st = streams[stream];
  if (st !== undefined) {
    if (st.model !== model) throw new Error(`stream "${stream}" already uses model "${st.model}"`);
    if (st.kind !== kind) throw new Error(`stream "${stream}" already has kind "${st.kind}"`);
    if (seq <= st.lastSeq) throw new Error(`seq ${seq} is out-of-order/repeated for stream "${stream}"`);
    if (kind === 'cumulative') {
      if (input < st.input || cachedInput < st.cachedInput || output < st.output) {
        throw new Error('cumulative counters for stream "' + stream + '" decreased');
      }
    }
  }

  // --- compute the new effective stream counters (safe-integer arithmetic) ---
  let newInput;
  let newCached;
  let newOut;
  if (kind === 'delta') {
    const baseInput = st ? st.input : 0;
    const baseCached = st ? st.cachedInput : 0;
    const baseOut = st ? st.output : 0;
    newInput = baseInput + input;
    newCached = baseCached + cachedInput;
    newOut = baseOut + output;
    if (newInput > MAX || newCached > MAX || newOut > MAX) {
      throw new Error('delta accumulation overflows safe integer range');
    }
  } else {
    // cumulative: count only the latest snapshot total
    newInput = input;
    newCached = cachedInput;
    newOut = output;
  }

  // --- mutate (only reached after every validation passed) ---
  state.ids = ids;
  state.streams = streams;
  state.streams[stream] = {
    model,
    kind,
    lastSeq: seq,
    input: newInput,
    cachedInput: newCached,
    output: newOut,
  };
  state.ids[id] = [stream, model, seq, kind, input, cachedInput, output];
  return state;
}

/**
 * Compute the usage/cost report. Pure: does not mutate `state`.
 */
export function report(state, rates) {
  const streams = (state && state.streams) || {};
  const byModel = {};
  const usedModels = [];

  for (const key of Object.keys(streams)) {
    const st = streams[key];
    const m = st.model;
    // Guard against hostile model keys colliding with Object.prototype members
    // (e.g. "toString", "constructor", "__proto__").
    if (!Object.prototype.hasOwnProperty.call(byModel, m)) {
      Object.defineProperty(byModel, m, {
        value: { uncachedInput: 0, cacheRead: 0, output: 0 },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      usedModels.push(m);
    }
    const b = byModel[m];
    b.uncachedInput += st.input - st.cachedInput;
    b.cacheRead += st.cachedInput;
    b.output += st.output;
  }

  if (usedModels.length === 0) {
    return { complete: true, totalUsd: 0, byModel };
  }

  const ratesObj = rates && typeof rates === 'object' && !Array.isArray(rates) ? rates : {};

  let complete = true;
  let grand = 0; // accumulated per-model numerator in "USD * 1e6"-free integer form
  for (const m of usedModels) {
    const r = Object.prototype.hasOwnProperty.call(ratesObj, m) ? ratesObj[m] : undefined;
    const valid =
      r !== null &&
      typeof r === 'object' &&
      isFiniteNonneg(r.uncachedInput) &&
      isFiniteNonneg(r.cacheRead) &&
      isFiniteNonneg(r.output);
    if (!valid) {
      complete = false;
      continue;
    }
    const t = byModel[m];
    grand += t.uncachedInput * r.uncachedInput + t.cacheRead * r.cacheRead + t.output * r.output;
  }

  return { complete, totalUsd: complete ? grand / 1e6 : null, byModel };
}
