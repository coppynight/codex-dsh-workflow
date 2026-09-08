function amount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a safe nonnegative integer`);
  }
}

function identifier(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('id must be a nonempty string');
  }
}

function add(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError('Unsafe budget arithmetic');
  return result;
}

// Validate persisted state before using it. Completed operations remain in the
// ledger permanently so their IDs cannot accidentally authorize another call.
function validate(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('Invalid budget state');
  }
  amount(state.limit, 'limit');
  amount(state.spent, 'spent');
  amount(state.reserved, 'reserved');
  if (!Array.isArray(state.operations)) throw new TypeError('Invalid operations');
  const ids = new Set();
  let spent = 0;
  let reserved = 0;
  for (const operation of state.operations) {
    if (!operation || typeof operation !== 'object') throw new TypeError('Invalid operation');
    identifier(operation.id);
    amount(operation.amount, 'reservation amount');
    if (ids.has(operation.id)) throw new TypeError('Duplicate operation ID');
    ids.add(operation.id);
    if (operation.status === 'active') {
      reserved = add(reserved, operation.amount);
    } else if (operation.status === 'settled') {
      amount(operation.actual, 'actual');
      spent = add(spent, operation.actual);
    } else if (operation.status !== 'released') {
      throw new TypeError('Invalid operation status');
    }
  }
  if (spent !== state.spent || reserved !== state.reserved) {
    throw new TypeError('Inconsistent budget totals');
  }
  return add(spent, reserved);
}

export function createBudget(limit) {
  amount(limit, 'limit');
  return { limit, spent: 0, reserved: 0, operations: [] };
}

export function reserve(state, id, estimate) {
  identifier(id);
  amount(estimate, 'amount');
  const committed = validate(state);
  const existing = state.operations.find(operation => operation.id === id);
  if (existing) {
    if (existing.amount !== estimate) throw new Error('Reservation ID already used with a different amount');
    return state;
  }
  if (committed > state.limit || estimate > state.limit - committed) {
    throw new RangeError('Insufficient available budget');
  }
  const reserved = add(state.reserved, estimate);
  state.operations.push({ id, amount: estimate, status: 'active' });
  state.reserved = reserved;
  return state;
}

export function settle(state, id, actual) {
  identifier(id);
  amount(actual, 'actual');
  validate(state);
  const operation = state.operations.find(operation => operation.id === id);
  if (!operation) throw new Error('Unknown reservation');
  if (operation.status === 'released') throw new Error('Reservation already released');
  if (operation.status === 'settled') {
    if (operation.actual !== actual) throw new Error('Settlement amount differs from recorded actual');
    return state;
  }
  const spent = add(state.spent, actual);
  const reserved = state.reserved - operation.amount;
  add(spent, reserved);
  // All validation and arithmetic precede mutation, including the combined
  // commitment check when other remote calls are still unresolved.
  operation.status = 'settled';
  operation.actual = actual;
  state.spent = spent;
  state.reserved = reserved;
  return state;
}

export function release(state, id) {
  identifier(id);
  validate(state);
  const operation = state.operations.find(operation => operation.id === id);
  if (!operation) throw new Error('Unknown reservation');
  if (operation.status === 'settled') throw new Error('Reservation already settled');
  if (operation.status === 'released') return state;
  state.reserved -= operation.amount;
  operation.status = 'released';
  return state;
}

export function snapshot(state) {
  const committed = validate(state);
  return {
    limit: state.limit,
    spent: state.spent,
    reserved: state.reserved,
    available: Math.max(0, state.limit - committed),
    overdrawn: committed > state.limit,
  };
}
