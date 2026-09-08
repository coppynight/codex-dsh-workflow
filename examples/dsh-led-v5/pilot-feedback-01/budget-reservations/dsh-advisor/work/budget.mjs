// Budget module: reservations against a dollar budget.
//
// All amounts are integer micro-dollars (safe, non-negative integers). `id` is
// a non-empty string. Functions mutate a single JSON-serializable `state`
// object that is created by `createBudget`. The module needs no filesystem or
// network access.
//
// Lifecycle of an id:
//   reserve(id, amount)  -> status 'held'   (a hold is placed on the budget)
//   settle(id, actual)   -> status 'settled' (remote charge happened; spend++)
//   release(id)          -> status 'released' (remote call known not to have run)
//
// A held reservation contributes `amount` to `reserved`. Settled/released
// reservations are terminal: they no longer count toward `reserved` and can
// never be reserved again (no resurrection). Repeating `reserve` with the exact
// same id+amount is an idempotent replay only while the hold is still active.

function assertId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('id must be a non-empty string');
  }
}

function assertAmount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertState(state) {
  if (!state || typeof state !== 'object' ||
      !Number.isSafeInteger(state.limit) || state.limit < 0 ||
      !Number.isSafeInteger(state.spent) || state.spent < 0 ||
      !state.reservations || typeof state.reservations !== 'object') {
    throw new TypeError('invalid budget state');
  }
}

// Record storage must treat every string id (including '__proto__',
// 'constructor', ...) as an ordinary own property, and must stay robust after
// a JSON round-trip turns the dictionary back into a plain object.
function readRecord(reservations, id) {
  return Object.hasOwn(reservations, id) ? reservations[id] : undefined;
}

function writeRecord(reservations, id, record) {
  Object.defineProperty(reservations, id, {
    value: record,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

// Sum of the amounts of all active ('held') reservations.
function activeReserved(reservations) {
  let total = 0;
  for (const key of Object.keys(reservations)) {
    const rec = reservations[key];
    if (rec && rec.status === 'held') {
      total += rec.amount;
      if (!Number.isSafeInteger(total)) {
        throw new RangeError('reserved total exceeds safe integer range');
      }
    }
  }
  return total;
}

export function createBudget(limit) {
  assertAmount(limit, 'limit');
  // Plain JSON-serializable state: limit, spent, and a ledger of every id ever
  // reserved (so an unresolved hold survives serialization and keeps blocking).
  // The ledger is null-prototyped so that arbitrary string ids stay own keys.
  return { limit, spent: 0, reservations: Object.create(null) };
}

// Place a reservation, or replay it. Repeating reserve(id, amount) with the
// exact amount the active hold was created for is an idempotent replay (no
// change). Once an id is settled or released it is terminal: reserving it
// again -- same amount or not -- throws, so a finished operation can never be
// resurrected into a fresh hold. A changed amount on an id that still has an
// active hold also throws.
export function reserve(state, id, amount) {
  assertId(id);
  assertAmount(amount, 'amount');
  assertState(state);

  const rec = readRecord(state.reservations, id);

  if (rec) {
    if (rec.amount !== amount) {
      throw new Error('reservation id reused with a changed amount');
    }
    if (rec.status !== 'held') {
      throw new Error('reservation id already settled or released; cannot reserve again');
    }
    return; // idempotent replay of the active hold: nothing to do
  }

  // A fresh hold consumes capacity. Reject when overdrawn (this covers a
  // zero-value reservation too), and reject any amount above available.
  const reserved = activeReserved(state.reservations);
  if (state.spent + reserved > state.limit) {
    throw new Error('budget overdrawn; new reservations rejected');
  }
  const available = state.limit - state.spent - reserved;
  if (amount > available) {
    throw new Error('reservation exceeds available budget');
  }

  writeRecord(state.reservations, id, { amount, status: 'held' });
}

// Record actual spend, freeing the id's hold. Remote charges cannot be undone,
// so `actual` may exceed the reservation and even the total limit: we record
// the full actual spend. Idempotent only for the exact same actual amount.
export function settle(state, id, actual) {
  assertId(id);
  assertAmount(actual, 'actual');
  assertState(state);

  const rec = readRecord(state.reservations, id);
  if (!rec) throw new Error('unknown reservation id');
  if (rec.status === 'released') {
    throw new Error('cannot settle a released reservation');
  }

  if (rec.status === 'held') {
    const newSpent = state.spent + actual;
    if (!Number.isSafeInteger(newSpent)) {
      throw new RangeError('spent exceeds safe integer range');
    }
    state.spent = newSpent;
    rec.status = 'settled';
    rec.actual = actual;
  } else if (rec.actual !== actual) {
    // Already settled: idempotent only for exactly the same actual amount.
    throw new Error('settle amount differs from already-settled id');
  }
}

// Release an active hold for a remote call known not to have run. Repeats
// idempotently, but rejects an id that has already been settled (its charge
// cannot be undone) and rejects unknown ids.
export function release(state, id) {
  assertId(id);
  assertState(state);

  const rec = readRecord(state.reservations, id);
  if (!rec) throw new Error('unknown reservation id');
  if (rec.status === 'settled') {
    throw new Error('cannot release a settled reservation');
  }
  if (rec.status === 'held') {
    rec.status = 'released';
    delete rec.actual;
  }
}

export function snapshot(state) {
  assertState(state);
  const reserved = activeReserved(state.reservations);
  const spent = state.spent;
  const used = spent + reserved;
  return {
    limit: state.limit,
    spent,
    reserved,
    available: Math.max(0, state.limit - used),
    overdrawn: used > state.limit,
  };
}
