import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PHASES = new Set(['planned', 'running', 'completed', 'failed']);
const VALUE_KEYS = ['version', 'taskId', 'phase', 'updatedAt', 'operationIds'];

function requireArgs(directory, id) {
  if (typeof directory !== 'string' || directory.length === 0 || !isAbsolute(directory)) {
    throw new TypeError(
      `directory must be a non-empty absolute path (got ${
        typeof directory === 'string' ? `"${directory}"` : typeof directory
      })`
    );
  }
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new TypeError(
      `id must be a string matching /^[A-Za-z0-9_-]{1,64}$/ (got ${
        typeof id === 'string' ? `"${id}"` : typeof id
      })`
    );
  }
}

function invalidValue(reason) {
  return new TypeError(`invalid checkpoint value: ${reason}`);
}

/**
 * Validate a checkpoint value against the schema and return a normalized
 * copy containing exactly the canonical properties (extra properties are
 * intentionally omitted).
 */
function normalizeValue(value, id) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidValue('expected a plain object');
  }
  for (const key of VALUE_KEYS) {
    if (!(key in value) || value[key] === undefined) {
      throw invalidValue(`missing required property "${key}"`);
    }
  }
  if (value.version !== 1) {
    throw invalidValue('version must be 1');
  }
  if (value.taskId !== id) {
    throw invalidValue(`taskId must equal id "${id}"`);
  }
  if (typeof value.phase !== 'string' || !PHASES.has(value.phase)) {
    throw invalidValue("phase must be one of 'planned', 'running', 'completed', 'failed'");
  }
  if (!Number.isInteger(value.updatedAt) || value.updatedAt < 0) {
    throw invalidValue('updatedAt must be a nonnegative finite integer');
  }
  if (!Array.isArray(value.operationIds)) {
    throw invalidValue('operationIds must be an array of unique nonempty strings');
  }
  const { operationIds } = value;
  for (const op of operationIds) {
    if (typeof op !== 'string' || op.length === 0) {
      throw invalidValue('operationIds must contain only nonempty strings');
    }
  }
  if (new Set(operationIds).size !== operationIds.length) {
    throw invalidValue('operationIds entries must be unique');
  }
  return {
    version: 1,
    taskId: id,
    phase: value.phase,
    updatedAt: value.updatedAt,
    operationIds: [...operationIds],
  };
}

/**
 * Rename `src` over `dest`, retrying bounded transient failures (Windows can
 * report EPERM/EBUSY/EACCES as a temporary sharing violation when the rename
 * races another operation touching `dest`). If retries are exhausted the error
 * propagates and the caller keeps the old destination intact.
 */
async function renameOverwrite(src, dest) {
  const MAX_ATTEMPTS = 8;
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(src, dest);
      return;
    } catch (err) {
      const transient =
        err &&
        (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') &&
        attempt <= MAX_ATTEMPTS;
      if (!transient) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 5 * attempt));
    }
  }
}

/**
 * Persist `value` for checkpoint `id` under `directory`.
 *
 * Writes UTF-8 JSON plus a trailing newline to a unique, exclusively-created
 * temporary file in the target directory, then atomically renames it over the
 * final `<id>.json` file. The previous checkpoint is never touched before the
 * rename; the temporary file is removed on any failure.
 *
 * @returns the normalized saved value
 */
export async function saveCheckpoint(directory, id, value) {
  requireArgs(directory, id);
  const normalized = normalizeValue(value, id);

  const filePath = join(directory, `${id}.json`);
  const tmpPath = join(directory, `.${id}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    await mkdir(directory, { recursive: true });
    handle = await open(tmpPath, 'wx');
    await handle.writeFile(JSON.stringify(normalized) + '\n', 'utf8');
    await handle.close();
    handle = undefined;
    await renameOverwrite(tmpPath, filePath);
  } catch (err) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Best-effort cleanup; the original error is what matters.
      }
    }
    try {
      await rm(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup; the original error is what matters.
    }
    throw err;
  }
  return normalized;
}

/**
 * Read checkpoint `id` from `directory`.
 *
 * @returns the validated, normalized checkpoint, or null when no checkpoint
 *          exists. Throws on malformed JSON or schema violations without
 *          touching (repairing/resetting) the corrupt file.
 */
export async function loadCheckpoint(directory, id) {
  requireArgs(directory, id);

  const filePath = join(directory, `${id}.json`);
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SyntaxError(`malformed JSON in checkpoint ${filePath}: ${err.message}`, {
      cause: err,
    });
  }

  return normalizeValue(parsed, id);
}
