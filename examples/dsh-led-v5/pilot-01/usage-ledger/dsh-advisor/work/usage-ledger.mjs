// usage-ledger.mjs
//
// A small, dependency-free usage ledger.
//
// Public API:
//   createLedger()                    -> fresh empty state (plain, JSON-serializable)
//   ingest(state, event)              -> mutates state in place; throws on any invalid
//                                        event WITHOUT changing the state (byte-for-byte)
//   report(state, rates)              -> { complete, totalUsd, byModel }
//
// State shape (all plain data, survives JSON.stringify/parse):
//   {
//     streams: { [stream]: { model, kind, lastSeq, input, cachedInput, output } },
//     ids:     { [id]: { stream, model, seq, kind, input, cachedInput, output } }
//   }
//
// Semantics:
//   * An event id is globally unique. Redelivering an id with the exact same
//     content is a no-op (even after a JSON round trip / "restart"). Redelivering
//     an id with different content is a conflicting reuse -> throw.
//   * A stream is bound to one model and one kind forever.
//   * For a given stream, seq values of NEW ids must strictly increase.
//   * kind 'delta': the event's usage is added to the stream totals.
//   * kind 'cumulative': the event's usage is the stream's LATEST running total;
//     it replaces the previous snapshot and each of the three raw counters
//     (input, cachedInput, output) must never decrease.
//   * Every ingestion is validated fully before any mutation, so a rejection
//     leaves the state byte-for-byte unchanged.

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function fail(message) {
  throw new Error(message);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRateValue(value) {
  // A valid USD-per-million rate: finite and non-negative number.
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Set an own, enumerable property regardless of the map's prototype, so that
// hostile keys (e.g. "__proto__") cannot corrupt state and JSON round trips
// keep working (Object.defineProperty works on plain and null-prototype maps).
function setOwn(map, key, value) {
  Object.defineProperty(map, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return value;
}

export function createLedger() {
  // Null-prototype maps keep stream/id names from colliding with Object.prototype.
  return { streams: Object.create(null), ids: Object.create(null) };
}

export function ingest(state, event) {
  // ---- 1. Validate the event payload (no state mutation here). ----
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    fail('event must be a non-null object');
  }

  const { id, stream, model, seq, kind, input, cachedInput, output } = event;

  if (!isNonEmptyString(id)) fail('id must be a nonempty string');
  if (!isNonEmptyString(stream)) fail('stream must be a nonempty string');
  if (!isNonEmptyString(model)) fail('model must be a nonempty string');
  if (!isNonNegativeSafeInteger(seq)) fail('seq must be a nonnegative safe integer');
  if (kind !== 'delta' && kind !== 'cumulative') {
    fail("kind must be either 'delta' or 'cumulative'");
  }
  // All usage fields are required; a missing field is not treated as zero.
  if (!isNonNegativeSafeInteger(input)) fail('input must be a nonnegative safe integer');
  if (!isNonNegativeSafeInteger(cachedInput)) fail('cachedInput must be a nonnegative safe integer');
  if (!isNonNegativeSafeInteger(output)) fail('output must be a nonnegative safe integer');
  if (cachedInput > input) fail('cachedInput must not exceed input');

  const streams = state.streams;
  const ids = state.ids;

  // ---- 2. Global id deduplication. ----
  // Exact replay of an already-seen id is a no-op; any reuse with different
  // content is a conflicting reuse and throws.
  if (hasOwn(ids, id)) {
    const prev = ids[id];
    if (
      prev.stream === stream &&
      prev.model === model &&
      prev.seq === seq &&
      prev.kind === kind &&
      prev.input === input &&
      prev.cachedInput === cachedInput &&
      prev.output === output
    ) {
      return; // exact replay -> no-op (state already reflects this event)
    }
    fail(`conflicting reuse of event id ${JSON.stringify(id)}`);
  }

  // ---- 3. Stream-level validation (against prior events of this stream). ----
  let streamRecord = hasOwn(streams, stream) ? streams[stream] : undefined;

  if (streamRecord !== undefined) {
    if (streamRecord.model !== model) {
      fail(`stream ${JSON.stringify(stream)} is already bound to model ${JSON.stringify(streamRecord.model)}`);
    }
    if (streamRecord.kind !== kind) {
      fail(`stream ${JSON.stringify(stream)} is already bound to kind '${streamRecord.kind}'`);
    }
    if (seq <= streamRecord.lastSeq) {
      fail(`out-of-order or repeated seq ${seq} for stream ${JSON.stringify(stream)}`);
    }
    if (kind === 'cumulative') {
      // Cumulative snapshots must never move any individual counter backwards.
      if (input < streamRecord.input) fail(`cumulative input decreased on stream ${JSON.stringify(stream)}`);
      if (cachedInput < streamRecord.cachedInput) fail(`cumulative cachedInput decreased on stream ${JSON.stringify(stream)}`);
      if (output < streamRecord.output) fail(`cumulative output decreased on stream ${JSON.stringify(stream)}`);
    }
  }

  // ---- 4. Compute the new stream totals (still no mutation). ----
  let newInput;
  let newCached;
  let newOutput;
  let newLastSeq = seq;

  if (streamRecord === undefined) {
    // Brand-new stream: totals start at this event.
    newInput = input;
    newCached = cachedInput;
    newOutput = output;
  } else if (kind === 'delta') {
    // Deltas accumulate; verify the arithmetic stays within safe integers.
    newInput = streamRecord.input + input;
    newCached = streamRecord.cachedInput + cachedInput;
    newOutput = streamRecord.output + output;
    if (
      !Number.isSafeInteger(newInput) ||
      !Number.isSafeInteger(newCached) ||
      !Number.isSafeInteger(newOutput)
    ) {
      fail('usage totals would exceed the safe-integer range');
    }
  } else {
    // Cumulative: keep only the latest snapshot (never summed).
    newInput = input;
    newCached = cachedInput;
    newOutput = output;
  }

  // ---- 5. Commit atomically (only reached when every check passed). ----
  if (streamRecord === undefined) {
    setOwn(streams, stream, {
      model,
      kind,
      lastSeq: newLastSeq,
      input: newInput,
      cachedInput: newCached,
      output: newOutput,
    });
  } else {
    streamRecord.lastSeq = newLastSeq;
    streamRecord.input = newInput;
    streamRecord.cachedInput = newCached;
    streamRecord.output = newOutput;
  }
  setOwn(ids, id, { stream, model, seq, kind, input, cachedInput, output });
}

export function report(state, rates) {
  // ---- Aggregate every stream into per-model token totals. ----
  const byModel = {};
  const modelsInOrder = [];

  for (const streamName of Object.keys(state.streams)) {
    const s = state.streams[streamName];
    const model = s.model;
    if (!hasOwn(byModel, model)) {
      byModel[model] = { uncachedInput: 0, cacheRead: 0, output: 0 };
      modelsInOrder.push(model);
    }
    const agg = byModel[model];
    agg.uncachedInput += s.input - s.cachedInput;
    agg.cacheRead += s.cachedInput;
    agg.output += s.output;
  }

  // ---- Empty ledger: always complete with zero cost. ----
  if (modelsInOrder.length === 0) {
    return { complete: true, totalUsd: 0, byModel: {} };
  }

  // ---- Validate rates for every actually-used model. ----
  let complete = true;
  for (const model of modelsInOrder) {
    const r = typeof rates === 'object' && rates !== null ? rates[model] : undefined;
    if (
      typeof r !== 'object' ||
      r === null ||
      !isRateValue(r.uncachedInput) ||
      !isRateValue(r.cacheRead) ||
      !isRateValue(r.output)
    ) {
      complete = false;
      break;
    }
  }

  if (!complete) {
    // Token totals are preserved even when pricing is impossible.
    return { complete: false, totalUsd: null, byModel };
  }

  // ---- Cost: rates are USD per million tokens. No rounding anywhere. ----
  let totalUsd = 0;
  for (const model of modelsInOrder) {
    const agg = byModel[model];
    const r = rates[model];
    const modelUsd =
      (agg.uncachedInput * r.uncachedInput +
        agg.cacheRead * r.cacheRead +
        agg.output * r.output) /
      1_000_000;
    totalUsd += modelUsd;
  }

  return { complete: true, totalUsd, byModel };
}
