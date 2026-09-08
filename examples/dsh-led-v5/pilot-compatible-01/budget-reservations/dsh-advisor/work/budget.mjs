// Budget with idempotent reservations, settlements and releases.
// All amounts are integer micro-dollars (safe non-negative integers).
// State is a plain, JSON-serializable object.

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function isNonNegSafeInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function invalidAmount() {
  throw new TypeError('amount must be a safe non-negative integer');
}

function invalidId(id) {
  throw new TypeError(`invalid reservation id: ${JSON.stringify(id)}`);
}

// Recompute derived fields from the authoritative counters.
function recompute(state) {
  state.overdrawn = state.spent + state.reserved > state.limit;
  state.available = Math.max(0, state.limit - state.spent - state.reserved);
}

/**
 * Create a fresh budget state.
 * @param {number} limit spending limit in micro-dollars.
 */
export function createBudget(limit) {
  if (!isNonNegSafeInt(limit)) {
    throw new TypeError('limit must be a safe non-negative integer');
  }
  const state = {
    limit,
    spent: 0,
    reserved: 0,
    available: limit,
    overdrawn: false,
    // id -> { reserve, active, settled, released, actual }
    // `actual` holds the settled amount when settled.
    records: Object.create(null),
  };
  return state;
}

/**
 * Reserve `amount` for the remote call identified by `id`.
 * Repeating reserve(id, amount) with the exact same amount is an idempotent
 * replay (a no-op) even if the reservation was later settled or released.
 */
export function reserve(state, id, amount) {
  if (typeof id !== 'string' || id.length === 0) invalidId(id);
  if (!isNonNegSafeInt(amount)) invalidAmount();

  const rec = state.records[id];
  if (rec) {
    if (rec.reserve !== amount) {
      throw new Error(`reservation id "${id}" was used with a different amount`);
    }
    // Idempotent replay: same id + same amount, regardless of later outcome.
    return state;
  }

  // Brand new reservation.
  if (state.overdrawn) {
    throw new Error('budget is overdrawn; new reservations are rejected');
  }
  if (amount > state.available) {
    throw new Error('reservation exceeds available budget');
  }

  state.records[id] = {
    reserve: amount,
    active: true,
    settled: false,
    released: false,
    actual: null,
  };
  state.reserved += amount;
  recompute(state);
  return state;
}

/**
 * Record the actual spend for `id`, freeing its hold.
 * Idempotent only for exactly the same actual amount.
 */
export function settle(state, id, actual) {
  if (typeof id !== 'string' || id.length === 0) invalidId(id);
  if (!isNonNegSafeInt(actual)) invalidAmount();

  const rec = state.records[id];
  if (!rec) {
    throw new Error(`cannot settle unknown reservation id "${id}"`);
  }
  if (rec.released) {
    throw new Error(`reservation id "${id}" was released and cannot be settled`);
  }
  if (rec.settled) {
    if (rec.actual === actual) {
      // Idempotent replay of the same settlement.
      return state;
    }
    throw new Error(`reservation id "${id}" was already settled with a different amount`);
  }

  // Frees the hold for this reservation.
  if (rec.active) {
    state.reserved -= rec.reserve;
    rec.active = false;
  }
  rec.settled = true;
  rec.actual = actual;
  state.spent += actual;
  recompute(state);
  return state;
}

/**
 * Free the hold for `id` because the remote call is known not to have run.
 * Idempotent for repeats; rejects an already settled id.
 */
export function release(state, id) {
  if (typeof id !== 'string' || id.length === 0) invalidId(id);

  const rec = state.records[id];
  if (!rec) {
    throw new Error(`cannot release unknown reservation id "${id}"`);
  }
  if (rec.settled) {
    throw new Error(`reservation id "${id}" is already settled and cannot be released`);
  }
  if (rec.released) {
    // Idempotent repeat.
    return state;
  }

  if (rec.active) {
    state.reserved -= rec.reserve;
    rec.active = false;
  }
  rec.released = true;
  recompute(state);
  return state;
}

/**
 * Return a plain view of the budget. Does not expose mutable internals.
 */
export function snapshot(state) {
  return {
    limit: state.limit,
    spent: state.spent,
    reserved: state.reserved,
    available: state.available,
    overdrawn: state.overdrawn,
  };
}
