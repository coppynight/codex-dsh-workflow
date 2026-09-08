// usage-ledger.mjs
// A small, dependency-free usage ledger.
//
// State is a plain JSON-serialisable object (survives JSON.stringify/JSON.parse).
// ingest(state, event) mutates state in place and is atomic: every rejection
// leaves the state byte-for-byte unchanged.

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function createLedger() {
  // Object.create(null) avoids prototype-key collisions (e.g. "__proto__").
  return { ids: Object.create(null), streams: Object.create(null) };
}

function isSafeNonNegInt(x) {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
}

function isFiniteNonNeg(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

function own(o, key) {
  return Object.prototype.hasOwnProperty.call(o, key);
}

// Validate an event and return its canonical form. Throws on any invalid event
// BEFORE touching state, so rejection is always side-effect free.
function canonOf(event) {
  if (typeof event !== 'object' || event === null) {
    throw new Error('invalid event: not an object');
  }
  const id = event.id;
  const stream = event.stream;
  const model = event.model;
  const seq = event.seq;
  const kind = event.kind;
  const input = event.input;
  const cachedInput = event.cachedInput;
  const output = event.output;

  if (typeof id !== 'string' || id.length === 0) throw new Error('invalid id');
  if (typeof stream !== 'string' || stream.length === 0) throw new Error('invalid stream');
  if (typeof model !== 'string' || model.length === 0) throw new Error('invalid model');
  if (kind !== 'delta' && kind !== 'cumulative') throw new Error('invalid kind');
  if (!isSafeNonNegInt(seq)) throw new Error('invalid seq');
  // All usage fields are required: an absent/unknown value must not default to 0.
  if (!isSafeNonNegInt(input)) throw new Error('invalid input');
  if (!isSafeNonNegInt(cachedInput)) throw new Error('invalid cachedInput');
  if (!isSafeNonNegInt(output)) throw new Error('invalid output');
  if (cachedInput > input) throw new Error('cachedInput exceeds input');

  return { id, stream, model, seq, kind, input, cachedInput, output };
}

function sameCanonical(a, b) {
  return (
    a.id === b.id &&
    a.stream === b.stream &&
    a.model === b.model &&
    a.seq === b.seq &&
    a.kind === b.kind &&
    a.input === b.input &&
    a.cachedInput === b.cachedInput &&
    a.output === b.output
  );
}

export function ingest(state, event) {
  const c = canonOf(event);

  // Exact replay detection by globally-unique id. Same content => no-op (even
  // after a restart, because ids persist in state). Different content => throw
  // and change nothing.
  if (own(state.ids, c.id)) {
    if (sameCanonical(state.ids[c.id], c)) return;
    throw new Error(`conflicting reuse of id ${c.id}`);
  }

  const existing = own(state.streams, c.stream)
    ? state.streams[c.stream]
    : undefined;

  // Determine the new per-stream aggregate and validate against the stream
  // invariants (one model, one kind, monotonic seq, non-decreasing cumulative,
  // safe-integer accumulation). No mutation happens in this phase.
  let next;
  if (existing !== undefined) {
    if (existing.model !== c.model) throw new Error('stream model mismatch');
    if (existing.kind !== c.kind) throw new Error('stream kind mismatch');
    if (!(c.seq > existing.lastSeq)) {
      // out-of-order or repeated seq with a new (previously unseen) id
      throw new Error('out-of-order or repeated seq');
    }
    if (existing.kind === 'delta') {
      const sumInput = existing.input + c.input;
      const sumCached = existing.cachedInput + c.cachedInput;
      const sumOutput = existing.output + c.output;
      if (sumInput > MAX_SAFE || sumCached > MAX_SAFE || sumOutput > MAX_SAFE) {
        throw new Error('usage overflow');
      }
      next = {
        model: c.model,
        kind: c.kind,
        lastSeq: c.seq,
        input: sumInput,
        cachedInput: sumCached,
        output: sumOutput,
      };
    } else {
      // cumulative: counters must never decrease individually
      if (c.input < existing.input || c.cachedInput < existing.cachedInput || c.output < existing.output) {
        throw new Error('cumulative counters decreased');
      }
      next = {
        model: c.model,
        kind: c.kind,
        lastSeq: c.seq,
        input: c.input,
        cachedInput: c.cachedInput,
        output: c.output,
      };
    }
  } else {
    next = {
      model: c.model,
      kind: c.kind,
      lastSeq: c.seq,
      input: c.input,
      cachedInput: c.cachedInput,
      output: c.output,
    };
  }

  // Commit atomically. Once validation passed nothing below can fail.
  state.ids[c.id] = { ...c };
  state.streams[c.stream] = next;
}

export function report(state, rates) {
  const byModel = {};

  for (const key of Object.keys(state.streams)) {
    const s = state.streams[key];
    // s.input is either the summed deltas or the latest cumulative totals;
    // uncached = input (incl. cached) - cacheRead.
    const uncached = s.input - s.cachedInput;
    if (!Object.prototype.hasOwnProperty.call(byModel, s.model)) {
      byModel[s.model] = { uncachedInput: 0, cacheRead: 0, output: 0 };
    }
    const m = byModel[s.model];
    m.uncachedInput += uncached;
    m.cacheRead += s.cachedInput;
    m.output += s.output;
  }

  const models = Object.keys(byModel);
  if (models.length === 0) {
    return { complete: true, totalUsd: 0, byModel: {} };
  }

  let microUsd = 0;
  let complete = true;
  const r = typeof rates === 'object' && rates !== null ? rates : {};

  for (const model of models) {
    const rate = own(r, model) ? r[model] : undefined;
    const usable =
      typeof rate === 'object' &&
      rate !== null &&
      isFiniteNonNeg(rate.uncachedInput) &&
      isFiniteNonNeg(rate.cacheRead) &&
      isFiniteNonNeg(rate.output);
    if (!usable) {
      complete = false;
      continue; // preserve token totals in byModel
    }
    const m = byModel[model];
    microUsd += m.uncachedInput * rate.uncachedInput;
    microUsd += m.cacheRead * rate.cacheRead;
    microUsd += m.output * rate.output;
  }

  if (!complete) {
    return { complete: false, totalUsd: null, byModel };
  }
  return { complete: true, totalUsd: microUsd / 1e6, byModel };
}
