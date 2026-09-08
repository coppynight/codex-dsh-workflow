import { readFile, open, mkdir, rm, rename } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseJobs } from './parse.mjs';
import { summarizeJobs } from './aggregate.mjs';

const USAGE = 'usage: node cli.mjs <INPUT> <OUTPUT>';

async function main(argv) {
  if (argv.length !== 2) {
    console.error(USAGE);
    return 1;
  }

  const inputPath = resolve(argv[0]);
  const outputPath = resolve(argv[1]);

  // Reject identical resolved paths before touching either file.
  if (inputPath === outputPath) {
    console.error('error: input and output must be different files');
    return 1;
  }

  // Read the input completely before creating output directories or temp files.
  let text;
  try {
    text = await readFile(inputPath, 'utf8');
  } catch {
    console.error('error: cannot read input file');
    return 1;
  }

  const { jobs, errors } = parseJobs(text);
  const report = JSON.stringify({ summary: summarizeJobs(jobs), errors }, null, 2) + '\n';

  const dir = dirname(outputPath);
  const base = basename(outputPath);
  let tempPath = null;

  try {
    await mkdir(dir, { recursive: true });

    // Exclusively create a uniquely named sibling temporary file.
    let handle = null;
    for (let attempt = 0; attempt < 25 && handle === null; attempt++) {
      const candidate = join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);
      try {
        handle = await open(candidate, 'wx');
        tempPath = candidate;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // Name collision: try another unique name; never touch the existing file.
      }
    }
    if (handle === null) throw new Error('could not create temporary file');

    try {
      await handle.writeFile(report, 'utf8');
      await handle.close();
      handle = null;
    } catch (err) {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          /* best effort */
        }
      }
      throw err;
    }

    await rename(tempPath, outputPath);
    tempPath = null; // successfully published; temp no longer exists
  } catch {
    // Clean up only the temporary file we exclusively created.
    if (tempPath !== null) {
      try {
        await rm(tempPath, { force: true });
      } catch {
        /* best effort */
      }
    }
    console.error('error: cannot write output file');
    return 1;
  }

  return errors.length > 0 ? 2 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch {
  process.exitCode = 1;
}
