// Budget reservations module.
// All money amounts are integer micro-dollars (safe nonnegative integers).
// The state object is JSON-serializable and holds only plain data.

const isSafeNonNegInt = (v) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const isNonEmptyId = (id) => typeof id === 'string' && id.length > 0;

function recompute(state) {
  state._spent = state._spent;
  state._reserved = state._reserved;
  state._overdrawn = state._spent + state._reserved > state._limit;
}

function fail(message) {
  throw new RangeError(message);
}

// Create a fresh budget state. `limit` is the total ceiling in micro-dollars.
export function createBudget(limit) {
  if (!isSafeNonNegInt(limit)) fail('limit must be a safe nonnegative integer');
  return {
    _limit: limit,
    _spent: 0,
    _reserved: 0,
    _overdrawn: false,
    _holds: {}, // id -> active reservation amount
    _reservations: {}, // id -> { amount, status, actual? }
  };
}

// Reserve an estimated maximum amount for id before a remote call.
// A repeated reserve with the same id+amount is an idempotent replay (no-op),
// regardless of whether that reservation was later settled or released.
// A changed amount, or reuse of the id for a different operation, throws.
export function reserve(state, id, amount) {
  if (!isNonEmptyId(id)) fail('id must be a nonempty string');
  if (!isSafeNonNegInt(amount)) fail('amount must be a safe nonnegative integer');

  const existing = state._reservations[id];

  if (existing) {
    // Same id reserved before. Same amount => replay (no-op).
    // Different amount => changed amount / reuse for another operation.
    if (existing.amount !== amount) {
      fail('reservation id reused with a different amount');
    }
    return; // idempotent replay
  }

  // New reservation.
  if (state._overdrawn) {
    fail('budget is overdrawn; new reservations are rejected');
  }
  const available = state._limit - state._spent - state._reserved;
  if (amount > available) {
    fail('reservation exceeds available budget');
  }

  state._holds[id] = amount;
  state._reservations[id] = { amount, status: 'active' };
  state._reserved += amount;
  recompute(state);
}

// settle records the actual spend for id, frees its hold, and is idempotent
// only for exactly the same actual amount. Actual may exceed the reservation
// and even the total limit: remote charges cannot be undone.
export function settle(state, id, actual) {
  if (!isNonEmptyId(id)) fail('id must be a nonempty string');
  if (!isSafeNonNegInt(actual)) fail('actual must be a safe nonnegative integer');

  const r = state._reservations[id];
  if (!r) fail('settle: unknown reservation');
  if (r.status === 'released') fail('settle: reservation was released');
  if (r.status === 'settled') {
    // Idempotent only for exactly the same actual amount.
    if (r.actual === actual) return;
    fail('settle: actual amount changed on replay');
  }

  // r.status === 'active'
  const newSpent = state._spent + actual;
  if (!Number.isSafeInteger(newSpent)) fail('settle: unsafe arithmetic');

  delete state._holds[id];
  r.status = 'settled';
  r.actual = actual;
  state._reserved -= r.amount;
  state._spent = newSpent;
  recompute(state);
}

// release is for a remote call known not to have run. It frees an active hold
// and repeats idempotently; it rejects an already settled id.
export function release(state, id) {
  if (!isNonEmptyId(id)) fail('id must be a nonempty string');

  const r = state._reservations[id];
  if (!r) fail('release: unknown reservation');
  if (r.status === 'settled') fail('release: reservation already settled');
  if (r.status === 'released') return; // idempotent

  delete state._holds[id];
  r.status = 'released';
  state._reserved -= r.amount;
  recompute(state);
}

// snapshot returns a plain object that does not expose mutable internals.
export function snapshot(state) {
  const available = Math.max(0, state._limit - state._spent - state._reserved);
  const overdrawn = state._spent + state._reserved > state._limit;
  return {
    limit: state._limit,
    spent: state._spent,
    reserved: state._reserved,
    available,
    overdrawn,
  };
}
