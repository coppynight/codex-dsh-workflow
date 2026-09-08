/**
 * budget.mjs — reservation-based budget ledger for remote calls.
 *
 * Pure ESM, no dependencies. All amounts are integer micro-dollars
 * (nonnegative safe integers). State is a plain JSON-serializable object:
 *
 *   {
 *     limit:        number,   // budget cap (micro-dollars)
 *     spent:        number,   // sum of settled actual spend
 *     reserved:     number,   // sum of amounts of currently held reservations
 *     reservations: [        // append-only ledger of every reservation id ever seen
 *       { id, amount, status: 'held' | 'settled' | 'released', actual? }
 *     ]
 *   }
 *
 * The reservations ledger is kept append-only so an idempotent replay of a
 * reserve/settle/release message can be recognized after the operation already
 * finished (settled or released). Entries are records in an array rather than
 * an object keyed by id so arbitrary ids (e.g. "__proto__") are safe across
 * JSON round-trips. The aggregate counters (spent/reserved) are updated only
 * when a message actually changes state; replays never double-count.
 *
 * Derived quantities:
 *   overdrawn = spent + reserved > limit
 *   available = max(0, limit - spent - reserved)
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function assertId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    const shown = typeof id === 'string' ? '(empty string)' : JSON.stringify(id);
    throw new TypeError(`id must be a nonempty string, got ${shown}`);
  }
}

function assertNonnegSafeInt(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    const shown = typeof value === 'number' ? String(value) : JSON.stringify(value);
    throw new TypeError(`${name} must be a nonnegative safe integer, got ${shown}`);
  }
}

function assertState(state) {
  if (
    state === null ||
    typeof state !== 'object' ||
    !Number.isSafeInteger(state.limit) ||
    state.limit < 0 ||
    !Array.isArray(state.reservations)
  ) {
    throw new TypeError('state must be an object produced by createBudget()');
  }
}

function findReservation(state, id) {
  return state.reservations.find((r) => r.id === id);
}

/**
 * Create a fresh, empty budget state that caps total (settled + held) spend.
 * @param {number} limit - budget cap in integer micro-dollars.
 */
export function createBudget(limit) {
  assertNonnegSafeInt(limit, 'limit');
  return { limit, spent: 0, reserved: 0, reservations: [] };
}

/**
 * Hold `amount` of budget headroom before a remote call.
 *
 * - Same id + same amount again (at any later time, even after the record was
 *   settled or released) is an idempotent replay: succeeds and changes nothing.
 * - Same id with a different amount is treated as reuse for a different
 *   operation and is rejected.
 * - A brand-new reservation is rejected when it exceeds available budget or
 *   when the budget is already overdrawn (overdrawn rejects even a zero-value
 *   reservation).
 *
 * @returns {void} - throws on invalid input / capacity / reuse violations.
 */
export function reserve(state, id, amount) {
  assertState(state);
  assertId(id);
  assertNonnegSafeInt(amount, 'amount');

  const existing = findReservation(state, id);
  if (existing) {
    if (existing.amount !== amount) {
      throw new Error(
        `id "${id}" was already used for a reservation of ${existing.amount}; ` +
          `a different amount (${amount}) means a different operation`
      );
    }
    return; // idempotent replay: no-op regardless of later settle/release
  }

  // Brand-new reservation: capacity check. When spent + reserved already
  // exceed the limit we reject every new reservation, including amount 0.
  if (state.spent > state.limit - state.reserved) {
    throw new Error('budget is overdrawn; new reservations are rejected');
  }
  const available = state.limit - state.spent - state.reserved; // >= 0 here
  if (amount > available) {
    throw new Error(
      `reservation of ${amount} exceeds available budget ${available}`
    );
  }

  state.reservations.push({ id, amount, status: 'held' });
  state.reserved += amount;
}

/**
 * Record the actual cost of a completed remote call and free its hold.
 *
 * Actual may exceed the reservation and even the total limit (remote charges
 * cannot be undone). Settling the same id with exactly the same actual amount
 * again is idempotent; any other repeat is rejected. Rejects ids that were
 * released or never reserved.
 *
 * @returns {void} - throws on invalid input / protocol violations.
 */
export function settle(state, id, actual) {
  assertState(state);
  assertId(id);
  assertNonnegSafeInt(actual, 'actual');

  const rec = findReservation(state, id);
  if (!rec) {
    throw new Error(`cannot settle unknown reservation "${id}"`);
  }
  if (rec.status === 'released') {
    throw new Error(`cannot settle reservation "${id}": it was released`);
  }
  if (rec.status === 'settled') {
    if (rec.actual === actual) return; // idempotent replay of the same settle
    throw new Error(
      `reservation "${id}" was already settled with actual ${rec.actual}; ` +
        `cannot settle again with ${actual}`
    );
  }
  if (actual > MAX_SAFE - state.spent) {
    throw new RangeError('settle would overflow safe integer arithmetic');
  }

  state.spent += actual;
  state.reserved -= rec.amount;
  rec.status = 'settled';
  rec.actual = actual;
}

/**
 * Free a hold for a remote call that is known not to have run.
 *
 * Repeating a release is idempotent. Rejects ids that were already settled or
 * never reserved. A timeout must never be treated as a release — an unresolved
 * reservation stays held (surviving JSON serialization) and keeps blocking
 * spend until the caller explicitly settles or releases it.
 *
 * @returns {void} - throws on invalid input / protocol violations.
 */
export function release(state, id) {
  assertState(state);
  assertId(id);

  const rec = findReservation(state, id);
  if (!rec) {
    throw new Error(`cannot release unknown reservation "${id}"`);
  }
  if (rec.status === 'settled') {
    throw new Error(`cannot release reservation "${id}": it was already settled`);
  }
  if (rec.status === 'released') return; // idempotent replay

  state.reserved -= rec.amount;
  rec.status = 'released';
}

/**
 * Read-only view of the budget. Never exposes mutable internals: every call
 * returns a fresh plain object of derived primitive values.
 *
 * @returns {{limit:number, spent:number, reserved:number, available:number, overdrawn:boolean}}
 */
export function snapshot(state) {
  assertState(state);
  // reserved <= limit always holds for states built by this API, so
  // `spent > limit - reserved` is an exact integer comparison (avoids any
  // floating-point concern from summing two large safe integers).
  const overdrawn = state.spent > state.limit - state.reserved;
  const available = overdrawn
    ? 0
    : state.limit - state.spent - state.reserved;
  return {
    limit: state.limit,
    spent: state.spent,
    reserved: state.reserved,
    available,
    overdrawn,
  };
}
