# Durable job receipts

Node.js 24 ESM, using only built-ins:

```js
import { claimJob, readJob, finishJob } from './jobs.mjs';
const claim = await claimJob('./receipts', 'payment/客户', { amount: 10 });
if (claim.created) {
  const result = await performRemoteCall();
  await finishJob('./receipts', claim.record.id, result);
}
const receipt = await readJob('./receipts', 'payment/客户');
```

Only `created: true` authorizes the initial remote call. A pending replay is an
unresolved intent, not permission to retry. After a crash, reconcile with the
remote provider (preferably using its idempotency key or transaction lookup),
then record the confirmed result with `finishJob`. The store cannot make a
remote side effect and local completion one atomic transaction.

Receipts use SHA-256 filenames. Per-receipt directory locks serialize writers
across processes; contention retries for at least five seconds before `BUSY`.
Locks are never expired automatically. After a crashed writer, stop or otherwise
prove all writers for that receipt are inactive before manually removing its
`<hash>.lock` directory. Read and reconcile the receipt before resuming. Orphaned
`*.tmp` files can be removed under the same conditions; they are never receipts.
Preserve corrupt receipts for investigation: `JOB_CORRUPT` never resets them.

Writes flush a temporary file before atomic rename, then flush the containing
directory where supported. Windows may not support directory fsync through
Node; power-loss guarantees depend on the OS/filesystem. Use a local filesystem
with atomic rename and exclusive directory creation. Reads create no files and
see either the previous or the new complete record. Returned values are fresh
snapshots. Payload/result objects must contain enumerable data properties;
accessors, symbol keys, sparse arrays, and extra array properties are rejected.

Other error codes are `INVALID_INPUT`, `JOB_UNKNOWN`, and `JOB_CONFLICT`;
filesystem errors retain their native codes. An I/O error can occur after rename,
so read/reconcile before deciding what happened. Never delete a pending receipt
to retry a paid operation.

Run checks with `node --test --test-isolation=none visible.test.mjs receipt.test.mjs`.
