const fields = ['id', 'stream', 'model', 'seq', 'kind', 'input', 'cachedInput', 'output'];
const counters = ['input', 'cachedInput', 'output'];
const own = (object, key) => Object.hasOwn(object, key);

// Define keys explicitly so names such as "__proto__" are ordinary data.
function put(object, key, value) {
  Object.defineProperty(object, key, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

function add(a, b) {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw new RangeError('Usage total exceeds safe integer range');
  return result;
}

export function createLedger() {
  return { events: {}, streams: {}, models: {} };
}

export function ingest(state, event) {
  if (event === null || typeof event !== 'object') throw new TypeError('Event must be an object');
  // Copy only the defined interface; callers cannot subsequently alter history.
  const next = {};
  for (const field of fields) {
    if (!own(event, field)) throw new TypeError(`Missing event field: ${field}`);
    next[field] = event[field];
  }
  for (const field of ['id', 'stream', 'model']) {
    if (typeof next[field] !== 'string' || next[field].length === 0) {
      throw new TypeError(`${field} must be a nonempty string`);
    }
  }
  for (const field of ['seq', ...counters]) {
    if (!Number.isSafeInteger(next[field]) || next[field] < 0) {
      throw new TypeError(`${field} must be a nonnegative safe integer`);
    }
  }
  if (next.kind !== 'delta' && next.kind !== 'cumulative') throw new TypeError('Invalid kind');
  if (next.cachedInput > next.input) throw new RangeError('Cached input exceeds input');

  if (own(state.events, next.id)) {
    const previous = state.events[next.id];
    if (fields.every(field => previous[field] === next[field])) return;
    throw new Error('Conflicting event id');
  }

  const previous = own(state.streams, next.stream) ? state.streams[next.stream] : undefined;
  if (previous) {
    if (previous.model !== next.model || previous.kind !== next.kind) {
      throw new Error('Stream model and kind must remain fixed');
    }
    if (next.seq <= previous.seq) throw new Error('Sequence must increase');
  }

  const stream = { model: next.model, kind: next.kind, seq: next.seq };
  const model = own(state.models, next.model) ? state.models[next.model] : { input: 0, cachedInput: 0, output: 0 };
  const totals = {};
  for (const field of counters) {
    const before = previous ? previous[field] : 0;
    if (next.kind === 'cumulative') {
      if (next[field] < before) throw new RangeError('Cumulative counters must not decrease');
      stream[field] = next[field];
    } else {
      stream[field] = add(before, next[field]);
    }
    totals[field] = add(model[field], stream[field] - before);
  }

  // All validation and arithmetic precede the commit. State contains only JSON data.
  put(state.events, next.id, next);
  put(state.streams, next.stream, stream);
  put(state.models, next.model, totals);
}

export function report(state, rates) {
  const byModel = {};
  let complete = true;
  let totalUsd = 0;
  for (const [model, usage] of Object.entries(state.models)) {
    const tokens = {
      uncachedInput: usage.input - usage.cachedInput,
      cacheRead: usage.cachedInput,
      output: usage.output,
    };
    put(byModel, model, tokens);
    const rate = rates != null && own(rates, model) ? rates[model] : undefined;
    const valid = rate != null && Object.keys(tokens).every(key =>
      own(rate, key) && Number.isFinite(rate[key]) && rate[key] >= 0);
    if (!valid) {
      complete = false;
      continue;
    }
    const weighted = tokens.uncachedInput * rate.uncachedInput
      + tokens.cacheRead * rate.cacheRead + tokens.output * rate.output;
    // Scale first only when the intermediate weighted sum overflows.
    const cost = Number.isFinite(weighted) ? weighted / 1_000_000
      : Object.keys(tokens).reduce((sum, key) => sum + tokens[key] * (rate[key] / 1_000_000), 0);
    totalUsd += cost;
  }
  return { complete, totalUsd: complete ? totalUsd : null, byModel };
}
