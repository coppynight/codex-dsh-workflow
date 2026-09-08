// usage-ledger.mjs
//
// A JSON-portable token-usage ledger.
//
//   createLedger()                      -> fresh, empty state
//   ingest(state, event)                -> mutates state in place, atomically;
//                                          throws (leaving state byte-for-byte
//                                          unchanged) on any invalid event,
//                                          conflicting id reuse, stream
//                                          model/kind change, out-of-order or
//                                          repeated seq with a new id,
//                                          decreasing cumulative counters, or
//                                          safe-integer overflow of delta sums.
//   report(state, rates)                -> { complete, totalUsd, byModel }
//
// State consists only of plain objects/numbers/strings and therefore survives
// JSON.stringify/JSON.parse round-trips.

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// Canonical content of an event; used to fingerprint ids for replay detection.
const EVENT_FIELDS = ['stream', 'seq', 'model', 'kind', 'input', 'cachedInput', 'output'];

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// defineProperty-based key insertion so hostile keys (e.g. "__proto__") become
// ordinary own properties instead of touching the prototype chain.
const put = (obj, key, value) => {
  Object.defineProperty(obj, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

function assertLedgerState(state) {
  if (
    state === null ||
    typeof state !== 'object' ||
    Array.isArray(state) ||
    !hasOwn(state, 'streams') ||
    !hasOwn(state, 'ids') ||
    state.streams === null ||
    typeof state.streams !== 'object' ||
    Array.isArray(state.streams) ||
    state.ids === null ||
    typeof state.ids !== 'object' ||
    Array.isArray(state.ids)
  ) {
    throw new Error('invalid ledger state');
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
}

function assertUsageInt(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
}

export function createLedger() {
  return { streams: {}, ids: {} };
}

export function ingest(state, event) {
  assertLedgerState(state);
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('event must be an object');
  }

  // ---- validate the whole event before touching any state ----
  const id = event.id;
  assertNonEmptyString(id, 'id');
  assertNonEmptyString(event.stream, 'stream');
  assertNonEmptyString(event.model, 'model');

  if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0) {
    throw new Error('seq must be a nonnegative safe integer');
  }
  const kind = event.kind;
  if (kind !== 'delta' && kind !== 'cumulative') {
    throw new Error('kind must be either "delta" or "cumulative"');
  }
  assertUsageInt(event.input, 'input');
  assertUsageInt(event.cachedInput, 'cachedInput');
  assertUsageInt(event.output, 'output');
  if (event.cachedInput > event.input) {
    throw new Error('cachedInput cannot exceed input');
  }

  const { streams, ids } = state;

  // ---- global id dedup: exact replay -> no-op; conflicting reuse -> throw ----
  if (hasOwn(ids, id)) {
    const prev = ids[id];
    for (const f of EVENT_FIELDS) {
      if (event[f] !== prev[f]) {
        throw new Error(`conflicting reuse of event id ${JSON.stringify(id)}`);
      }
    }
    return; // exact replay: no state change at all
  }

  // ---- per-stream rules for a brand-new id ----
  const streamName = event.stream;
  const existing = hasOwn(streams, streamName) ? streams[streamName] : null;

  let record;
  if (existing === null) {
    record = {
      model: event.model,
      kind,
      seq: event.seq,
      input: event.input,
      cachedInput: event.cachedInput,
      output: event.output,
    };
  } else {
    if (existing.model !== event.model) {
      throw new Error('stream already belongs to a different model');
    }
    if (existing.kind !== kind) {
      throw new Error('stream already uses a different kind');
    }
    if (event.seq <= existing.seq) {
      throw new Error('out-of-order or repeated seq on stream');
    }
    if (kind === 'cumulative') {
      // Cumulative snapshots must never decrease individually; the latest
      // snapshot is the whole contribution (nothing is summed).
      if (
        event.input < existing.input ||
        event.cachedInput < existing.cachedInput ||
        event.output < existing.output
      ) {
        throw new Error('cumulative counters cannot decrease');
      }
      record = {
        model: existing.model,
        kind,
        seq: event.seq,
        input: event.input,
        cachedInput: event.cachedInput,
        output: event.output,
      };
    } else {
      // Delta events accumulate; keep totals inside the safe-integer range.
      const input = existing.input + event.input;
      const cachedInput = existing.cachedInput + event.cachedInput;
      const output = existing.output + event.output;
      if (input > MAX_SAFE || cachedInput > MAX_SAFE || output > MAX_SAFE) {
        throw new Error('delta totals would exceed the safe-integer range');
      }
      record = {
        model: existing.model,
        kind,
        seq: event.seq,
        input,
        cachedInput,
        output,
      };
    }
  }

  // ---- commit (every check passed; this cannot throw midway) ----
  put(ids, id, {
    stream: event.stream,
    seq: event.seq,
    model: event.model,
    kind,
    input: event.input,
    cachedInput: event.cachedInput,
    output: event.output,
  });
  put(streams, streamName, record);
}

function isRate(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const u = value.uncachedInput;
  const c = value.cacheRead;
  const o = value.output;
  return (
    typeof u === 'number' && Number.isFinite(u) && u >= 0 &&
    typeof c === 'number' && Number.isFinite(c) && c >= 0 &&
    typeof o === 'number' && Number.isFinite(o) && o >= 0
  );
}

export function report(state, rates) {
  assertLedgerState(state);

  // Aggregate every stream of the same model. For a delta stream the stored
  // counters are the running sum; for a cumulative stream they are the latest
  // snapshot. uncachedInput = input - cachedInput, so cached tokens are never
  // double-counted.
  const byModel = {};
  const { streams } = state;
  for (const streamName of Object.keys(streams)) {
    const rec = streams[streamName];
    const model = rec.model;
    if (!hasOwn(byModel, model)) {
      put(byModel, model, { uncachedInput: 0, cacheRead: 0, output: 0 });
    }
    const agg = byModel[model];
    agg.uncachedInput += rec.input - rec.cachedInput;
    agg.cacheRead += rec.cachedInput;
    agg.output += rec.output;
  }

  const rateTable =
    rates !== null && typeof rates === 'object' && !Array.isArray(rates) ? rates : null;

  let complete = true;
  let numerator = 0; // sum of tokens * rate  (rates are USD per million)
  for (const model of Object.keys(byModel)) {
    const agg = byModel[model];
    const present = rateTable !== null && hasOwn(rateTable, model);
    const r = present ? rateTable[model] : null;
    if (present && isRate(r)) {
      numerator += agg.uncachedInput * r.uncachedInput;
      numerator += agg.cacheRead * r.cacheRead;
      numerator += agg.output * r.output;
    } else {
      complete = false;
    }
  }

  return {
    complete,
    totalUsd: complete ? numerator / 1e6 : null,
    byModel,
  };
}
