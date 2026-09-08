// budget.mjs
//
// A durable, JSON-serializable micro-dollar budget with reservations.
//
// Model
// -----
// Each state has a fixed `limit` and accumulates `spent` from settlements.
// An operation may be "reserved" (hold a maximum estimate) before a remote
// call. Active (un-settled, un-released) reservations contribute to
// `reserved`, which reduces `available`.
//
// A reservation id + amount pair is the dedupe key. Re-reserving the exact
// same id+amount is an idempotent replay (no-op) no matter whether that
// reservation was later settled or released. Using an id with a different
// amount throws (the id is being reused for a different operation).
//
// settle() records real spend and frees its hold. spend cannot be undone, so
// `actual` may exceed both the reservation and the total limit. release() is
// only valid for a remote call that definitively did not run.
//
// Values are integer micro-dollars. Every public function validates its input
// up front so an invalid call throws *without* mutating the state.

const isSafeNonNeg = (x) => Number.isSafeInteger(x) && x >= 0;

function assertValidId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('id must be a non-empty string');
  }
}

function assertAmount(value, name) {
  if (!isSafeNonNeg(value)) {
    throw new Error(`${name} must be a non-negative safe integer (micro-dollars)`);
  }
}

/**
 * Create a fresh budget state holding `limit` micro-dollars.
 * Returns a plain JSON-serializable object that the other functions mutate.
 */
export function createBudget(limit) {
  assertAmount(limit, 'limit');
  return {
    limit,
    spent: 0, // cumulative actual spend from settled reservations
    reserved: 0, // sum of amounts of reservations currently held (active)
    reservations: Object.create(null), // id -> { amount, status, settledAmount? }
  };
}

function headroom(state) {
  // Money still free for new holds / unspent.
  return state.limit - state.spent - state.reserved;
}

function isOverdrawn(state) {
  return state.spent + state.reserved > state.limit;
}

function findReservation(state, id) {
  return state.reservations[id];
}

/**
 * Hold up to `amount` for the operation identified by `id`.
 * Idempotent for a repeated (id, amount) pair; throws otherwise or when the
 * budget has no room for a brand-new reservation.
 */
export function reserve(state, id, amount) {
  assertValidId(id);
  assertAmount(amount, 'amount');

  const existing = findReservation(state, id);
  if (existing) {
    if (existing.amount !== amount) {
      throw new Error(`reservation "${id}" already used with a different amount`);
    }
    // Same id + amount: idempotent replay, regardless of current status.
    return;
  }

  // Brand-new reservation.
  if (isOverdrawn(state)) {
    // Overdrawn: no new reservation is admitted, even a zero-value one.
    throw new Error('budget is overdrawn; no new reservations allowed');
  }
  if (amount > headroom(state)) {
    throw new Error('reservation exceeds available budget');
  }

  state.reservations[id] = { amount, status: 'active' };
  state.reserved += amount;
}

/**
 * Record that operation `id` actually spent `actual`, freeing its hold.
 * `actual` may exceed the reservation and even the whole limit (a remote
 * charge cannot be undone). Idempotent only for the exact same `actual`.
 */
export function settle(state, id, actual) {
  assertValidId(id);
  assertAmount(actual, 'actual');

  const existing = findReservation(state, id);
  if (!existing) {
    throw new Error(`no reservation for id "${id}"`);
  }
  if (existing.status === 'released') {
    throw new Error(`cannot settle a released reservation "${id}"`);
  }
  if (existing.status === 'settled') {
    if (existing.settledAmount !== actual) {
      throw new Error(`settle amount changed for id "${id}"`);
    }
    return; // idempotent replay
  }

  // active -> settled
  if (state.spent + actual > Number.MAX_SAFE_INTEGER) {
    throw new Error('settle would overflow spent');
  }
  existing.status = 'settled';
  existing.settledAmount = actual;
  state.spent += actual;
  state.reserved -= existing.amount;
}

/**
 * Free the hold of operation `id` because the remote call definitively did
 * not run. Idempotent; rejects a reservation that was already settled.
 */
export function release(state, id) {
  assertValidId(id);

  const existing = findReservation(state, id);
  if (!existing) {
    throw new Error(`no reservation for id "${id}"`);
  }
  if (existing.status === 'settled') {
    throw new Error(`cannot release a settled reservation "${id}"`);
  }
  if (existing.status === 'released') {
    return; // idempotent replay
  }

  existing.status = 'released';
  state.reserved -= existing.amount;
}

/**
 * Return a fresh snapshot object; never exposes mutable internals.
 */
export function snapshot(state) {
  const overdrawn = isOverdrawn(state);
  return {
    limit: state.limit,
    spent: state.spent,
    reserved: state.reserved,
    available: Math.max(0, headroom(state)),
    overdrawn,
  };
}
