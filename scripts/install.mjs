#!/usr/bin/env node
import { cp, mkdir, rename, lstat, realpath, open, unlink, rm, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from './config.mjs';

const source = dirname(dirname(fileURLToPath(import.meta.url)));
export async function install(destination, update = false) {
  if (!isAbsolute(destination)) throw new Error('Destination must be absolute.');
  destination=resolve(destination);
  const exists = await lstat(destination).catch(e => { if(e.code !== 'ENOENT') throw e; return null; });
  if (exists && !update) throw new Error('Skill already exists. Use --update to preserve a timestamped backup and replace it.');
  if (exists?.isSymbolicLink()) throw new Error('Destination is a symlink/junction. Choose a regular skill directory.');
  if (exists && (!exists.isDirectory() || !/^name:\s*codex-dsh-workflow\s*$/m.test(await readFile(join(destination,'SKILL.md'),'utf8')))) throw new Error('Destination is not this skill; preserve it and choose another directory.');
  await mkdir(dirname(destination), { recursive: true });
  const parent = await realpath(dirname(destination)), realSource = await realpath(source);
  const actualDestination=join(parent,basename(destination));
  const within=(a,b)=>{const rel=relative(a,b);return rel==='' || (rel!=='..' && !rel.startsWith('..'+(process.platform==='win32'?'\\':'/')) && !isAbsolute(rel));};
  if (within(realSource,actualDestination) || within(actualDestination,realSource)) throw new Error('Destination must be outside the source repository and cannot contain it.');
  const lockPath=join(parent,'.codex-dsh-workflow-install.lock');
  const lock=await open(lockPath,'wx',0o600);
  await lock.writeFile(JSON.stringify({pid:process.pid}));
  try {
  const stage = join(parent, `.workflow-install-${randomUUID()}`);
  await mkdir(stage);
  for (const name of ['SKILL.md', 'README.md', 'package.json', 'package-lock.json', 'scripts', 'references', 'agents', 'bridge']) {
    await cp(join(source, name), join(stage, name), { recursive: true, filter: p => !p.endsWith('.test.mjs') });
  }
  let backup;
  if (exists) {
    // Backups live outside skills discovery; neither existing config nor runtime is deleted.
    const backupRoot = join(homedir(), '.codex-dsh-workflow', 'skill-backups');
    await mkdir(backupRoot, { recursive: true });
    backup = join(backupRoot, `codex-dsh-workflow-${Date.now()}-${randomUUID()}`);
    await cp(destination, backup, {recursive:true,verbatimSymlinks:true,errorOnExist:true,force:false});
  }
  const rollback=join(parent,`.workflow-previous-${randomUUID()}`);
  if(exists) await rename(destination,rollback);
  try { await rename(stage, destination); }
  catch(error) {if(exists) await rename(rollback,destination);throw error;}
  if(exists) {
    // Only the generated sibling we just moved is removed, after a complete backup.
    const actual=await realpath(rollback);
    if(dirname(actual)!==parent || !actual.split(/[\\/]/).at(-1).startsWith('.workflow-previous-')) throw new Error('Unexpected cleanup path; preserved for inspection.');
    await rm(actual,{recursive:true});
  }
  return { destination, backup: backup ?? null, next: 'Run npm ci --prefix <destination>, then follow references/setup.md. Reload Codex skills if needed.' };
  } finally {await lock.close();await unlink(lockPath);}
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('node scripts/install.mjs [--dest ABS_SKILL_DIRECTORY] [--update]'); return; }
  let destination = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills', 'codex-dsh-workflow'), update = false;
  for (let i=0; i<args.length; i++) {
    if (args[i] === '--dest' && args[i+1]) destination = args[++i];
    else if (args[i] === '--update') update = true;
    else throw new Error('Unknown installation argument. Use --help.');
  }
  console.log(JSON.stringify(await install(destination, update)));
}
if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode=2; });
