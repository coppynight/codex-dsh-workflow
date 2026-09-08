// budget.mjs
//
// Budget reservations expressed in integer micro-dollars.
//
// A budget state is a JSON-serializable plain object created by
// createBudget(limit) and mutated only through the exported functions:
//
//   reserve(state, id, amount)  hold `amount` against `id` before a remote call
//   settle(state, id, actual)   record actual spend for `id`, free its hold
//   release(state, id)          free the hold because the call never ran
//   snapshot(state)             {limit, spent, reserved, available, overdrawn}
//
// Each `id` identifies one logical operation. Messages for an operation may be
// delivered more than once (at-least-once semantics), so:
//   * reserve(id, sameAmount) is an idempotent replay, whatever the operation's
//     later fate (still held, settled or released); a different amount for an
//     already-known id is a protocol violation and throws.
//   * settle(id, sameActual) after a first settle is an idempotent replay.
//   * release(id) after a release is an idempotent replay.
// Settling never resurrects a released hold and releasing never cancels a
// settlement; both throw when used against the wrong terminal state, and
// unknown ids always throw.
//
// All arithmetic stays inside the safe-integer range; an operation whose
// outcome could not be represented exactly is rejected before any mutation.

const isSafeNonnegInteger = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function checkState(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('budget: state must be a budget state object');
  }
  if (!isSafeNonnegInteger(state.limit)) {
    throw new TypeError('budget: state.limit must be a safe non-negative integer');
  }
  if (!Array.isArray(state.records)) {
    throw new TypeError('budget: state.records must be an array');
  }
}

function checkId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('budget: id must be a non-empty string');
  }
}

function findRecord(state, id) {
  for (const record of state.records) {
    if (record.id === id) return record;
  }
  return undefined;
}

// Derived totals recomputed from the per-id records on every call, so the
// counters can never drift from the records (also after JSON round trips).
// All intermediates stay exactly representable: every total is bounded by the
// safe-integer range because each mutation refuses to push one past it.
function derived(state) {
  let spent = 0;
  let reserved = 0;
  for (const record of state.records) {
    if (record.status === 'held') {
      reserved += record.amount;
    } else if (record.status === 'settled') {
      spent += record.actual;
    }
  }
  const { limit } = state;
  const free = limit - reserved; // exact: |limit - reserved| <= 2^53 - 1
  const overdrawn = free < 0 || spent > free; // i.e. spent + reserved > limit
  const available = overdrawn ? 0 : free - spent;
  return { spent, reserved, available, overdrawn };
}

function totalSpent(state) {
  let spent = 0;
  for (const record of state.records) {
    if (record.status === 'settled') spent += record.actual;
  }
  return spent;
}

/**
 * Create a fresh, JSON-serializable budget state with the given limit
 * (safe non-negative integer of micro-dollars).
 */
export function createBudget(limit) {
  if (!isSafeNonnegInteger(limit)) {
    throw new TypeError('budget: limit must be a safe non-negative integer');
  }
  return { limit, records: [] };
}

/**
 * Hold `amount` (a maximum estimate) for the operation identified by `id`.
 * Active holds reduce the available budget.
 *
 * A repeated call with the exact same id and amount is an idempotent replay
 * and is accepted regardless of whether the operation was later settled or
 * released; it never changes the state. Using an already-known id with a
 * different amount, or reserving a brand-new id for more than is currently
 * available (including any reservation at all while overdrawn) throws without
 * changing the state.
 */
export function reserve(state, id, amount) {
  checkState(state);
  checkId(id);
  if (!isSafeNonnegInteger(amount)) {
    throw new TypeError('budget: reservation amount must be a safe non-negative integer');
  }

  const existing = findRecord(state, id);
  if (existing !== undefined) {
    if (existing.amount === amount) return; // idempotent replay
    throw new RangeError(`budget: id "${id}" is already known with a different amount`);
  }

  const { available, overdrawn } = derived(state);
  if (overdrawn) {
    throw new RangeError('budget: budget is overdrawn; new reservations are rejected');
  }
  if (amount > available) {
    throw new RangeError(`budget: reservation of ${amount} exceeds available ${available}`);
  }

  state.records.push({ id, amount, status: 'held' });
}

/**
 * Record the actual spend for a held reservation and free its hold. The actual
 * may exceed the reservation and even the total limit (remote charges cannot be
 * undone): the full amount is recorded and overdrawn reflects the result.
 *
 * Only the exact same actual amount replays idempotently. Settling an unknown
 * or already-released id throws, as does a second settle with a different
 * actual — all without changing the state.
 */
export function settle(state, id, actual) {
  checkState(state);
  checkId(id);
  if (!isSafeNonnegInteger(actual)) {
    throw new TypeError('budget: actual spend must be a safe non-negative integer');
  }

  const record = findRecord(state, id);
  if (record === undefined) {
    throw new RangeError(`budget: settle: unknown reservation "${id}"`);
  }
  if (record.status === 'released') {
    throw new RangeError(`budget: settle: reservation "${id}" was released`);
  }
  if (record.status === 'settled') {
    if (record.actual === actual) return; // idempotent replay
    throw new RangeError(`budget: settle: reservation "${id}" was already settled with a different actual`);
  }

  // record.status === 'held': this is the first settle for the reservation.
  const nextSpent = totalSpent(state) + actual;
  if (!Number.isSafeInteger(nextSpent)) {
    throw new RangeError('budget: settle: total spend would exceed the safe integer range');
  }

  record.status = 'settled';
  record.actual = actual;
}

/**
 * Free a hold because the remote call is known not to have run. Repeating a
 * release is an idempotent replay; releasing an unknown id or one that was
 * already settled throws without changing the state. Release is never inferred
 * from a timeout — unresolved reservations keep blocking spend across JSON
 * round trips.
 */
export function release(state, id) {
  checkState(state);
  checkId(id);

  const record = findRecord(state, id);
  if (record === undefined) {
    throw new RangeError(`budget: release: unknown reservation "${id}"`);
  }
  if (record.status === 'settled') {
    throw new RangeError(`budget: release: reservation "${id}" is already settled`);
  }
  if (record.status === 'released') return; // idempotent replay

  record.status = 'released'; // held -> released
}

/**
 * Return a fresh plain snapshot {limit, spent, reserved, available, overdrawn}.
 * The returned object shares nothing mutable with the internal state.
 */
export function snapshot(state) {
  checkState(state);
  const { limit } = state;
  const { spent, reserved, available, overdrawn } = derived(state);
  return { limit, spent, reserved, available, overdrawn };
}
