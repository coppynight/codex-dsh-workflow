import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseJobs } from './parse.mjs';
import { summarizeJobs } from './aggregate.mjs';

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 2) {
  fail('usage: node cli.mjs INPUT OUTPUT');
}

const [inputArg, outputArg] = args;
const inputPath = path.resolve(inputArg);
const outputPath = path.resolve(outputArg);

if (inputPath === outputPath) {
  fail('INPUT and OUTPUT must be different files');
}

let text;
try {
  text = await readFile(inputArg, 'utf8');
} catch (err) {
  // Preserve existing output on input-read failure.
  fail(`cannot read input: ${short(err)}`);
}

const { jobs, errors } = parseJobs(text);
const report = JSON.stringify(
  { summary: summarizeJobs(jobs), errors },
  null,
  2,
) + '\n';

// Read input succeeded; now build the output atomically via a uniquely named
// sibling temporary file and rename it over OUTPUT. Never pre-delete or
// truncate an existing OUTPUT.
const dir = path.dirname(outputPath);
const base = path.basename(outputPath);
let tempPath = null;
let handle = null;

try {
  await mkdir(dir, { recursive: true });

  // Exclusively create a unique sibling temporary file.
  tempPath = path.join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);
  handle = await open(tempPath, 'wx', 0o600);

  await handle.writeFile(report, 'utf8');
  await handle.sync();
  await handle.close();
  handle = null;

  await rename(tempPath, outputPath);
  tempPath = null; // successfully renamed; no longer owned
} catch (err) {
  if (handle) {
    try {
      await handle.close();
    } catch {
      /* best effort */
    }
  }
  if (tempPath) {
    try {
      await unlink(tempPath);
    } catch {
      /* best effort; only our owned temp is touched */
    }
  }
  fail(`cannot write output: ${short(err)}`);
}

process.exit(errors.length > 0 ? 2 : 0);

function short(err) {
  const m = err && typeof err.message === 'string' ? err.message : String(err);
  return m.length > 200 ? `${m.slice(0, 200)}...` : m;
}
