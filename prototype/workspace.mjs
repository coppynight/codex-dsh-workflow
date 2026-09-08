import { mkdir, open, readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { claimFileName, overlaps } from '../bridge/service.mjs';

export async function claimWorkspace({ stateDir, cwd, taskId, sessionId }) {
  await mkdir(join(stateDir, 'locks'), { recursive: true });
  await mkdir(join(stateDir, 'claims'), { recursive: true });
  const mutex = join(stateDir, 'locks', 'workspace-registry.lock');
  const lock = await open(mutex, 'wx');
  const target = join(stateDir, 'claims', claimFileName(cwd));
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, taskId }));
    for (const file of await readdir(join(stateDir, 'claims'))) {
      const owner = JSON.parse(await readFile(join(stateDir, 'claims', file), 'utf8'));
      if (overlaps(owner.cwd, cwd)) throw Error('Another task owns this workspace or an overlapping directory');
    }
    await writeFile(target, JSON.stringify({ taskId, sessionId, cwd, kind: 'dsh-led-prototype' }), { flag: 'wx' });
  } finally { await lock.close(); await unlink(mutex); }
  return async () => {
    const cleanupLock = await open(mutex, 'wx');
    try {
      const owner = JSON.parse(await readFile(target, 'utf8'));
      if (owner.taskId !== taskId || owner.sessionId !== sessionId) throw Error('Workspace owner changed; do not release');
      await unlink(target);
    } finally { await cleanupLock.close(); await unlink(mutex); }
  };
}
