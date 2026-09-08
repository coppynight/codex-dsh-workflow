import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parseJobs } from './parse.mjs';
import { summarizeJobs } from './aggregate.mjs';

const USAGE = 'usage: node cli.mjs <INPUT> <OUTPUT>';

function fail(message) {
  process.stderr.write(message + '\n');
  process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    fail(USAGE);
    return;
  }
  const [inputPath, outputPath] = args;

  // Reject identical resolved input/output before touching the filesystem.
  const inResolved = path.resolve(inputPath);
  const outResolved = path.resolve(outputPath);
  if (inResolved === outResolved) {
    fail('input and output paths must differ');
    return;
  }

  // Read input fully before creating output directories or temporary files so
  // an existing output is preserved on an input-read failure.
  let text;
  try {
    text = await readFile(inResolved, 'utf8');
  } catch (err) {
    fail(`failed to read input: ${describe(err)}`);
    return;
  }

  const { jobs, errors } = parseJobs(text);
  const report =
    JSON.stringify({ summary: summarizeJobs(jobs), errors }, null, 2) + '\n';

  // Publish atomically via a uniquely named sibling temporary file.
  const dir = path.dirname(outResolved);
  const base = path.basename(outResolved);
  const tmpName = `.${base}.${randomBytes(16).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  let owned = false;
  let handle = null;
  try {
    await mkdir(dir, { recursive: true });
    handle = await open(tmpPath, 'wx'); // exclusive create; we now own it.
    owned = true;
    await handle.writeFile(report, 'utf8');
    await handle.close();
    handle = null;
    await rename(tmpPath, outResolved); // atomic replace of existing output.
    owned = false; // no longer a temporary file to clean up.
  } catch (err) {
    // Close and remove only the temporary file we exclusively created. Never
    // touch the (possibly pre-existing) output target.
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* ignore secondary close failure */
      }
    }
    if (owned) {
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore secondary unlink failure */
      }
    }
    fail(`failed to write output: ${describe(err)}`);
    return;
  }

  // Publication succeeded. Parser errors imply a non-zero exit but the valid
  // record report is still published.
  process.exitCode = errors.length > 0 ? 2 : 0;
}

function describe(err) {
  if (err && typeof err.code === 'string') return err.code;
  return 'error';
}

main();
