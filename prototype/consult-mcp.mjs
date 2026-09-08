import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile, mkdir, open, unlink, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runCodex } from './codex.mjs';
import { advisorPrompt } from './protocol.mjs';
import { codexCost } from './usage.mjs';
const [configFile] = process.argv.slice(2);
const config = JSON.parse(await readFile(configFile, 'utf8'));
await mkdir(config.ledgerDir, { recursive: true });
const server = new McpServer({ name: 'dsh-astra-advisor', version: '0.1.0' });
const reply = (value, isError = false) => ({ isError, content: [{ type: 'text', text: JSON.stringify(value) }] });
server.registerTool('consult_astra', {
  description: 'Ask Astra a focused technical question when the expected benefit justifies expert cost. You retain implementation, testing and final delivery. At most two consultations per task. Supply relevant evidence; the advisor has no tools. Reuse the same consultationId only to recover the exact same request.',
  inputSchema: { consultationId: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), question: z.string().min(1).max(4000), context: z.string().max(12000) },
}, async (request, extra) => {
  const hash = createHash('sha256').update(JSON.stringify({ question: request.question, context: request.context })).digest('hex');
  const file = join(config.ledgerDir, `${request.consultationId}.json`);
  let lock, releaseLock = true;
  try { lock = await open(join(config.ledgerDir, 'active.lock'), 'wx'); }
  catch { return reply({ status: 'busy-or-unknown', message: 'A consultation may still be active. Do not create a replacement ID; inspect the existing operation.' }, true); }
  try {
    let previous; try { previous = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (previous) {
      if (previous.hash !== hash) return reply({ status: 'id-conflict' }, true);
      if (previous.status === 'completed') return reply({ status: 'completed', cached: true, advice: previous.expert.answer, cost: previous.cost });
      return reply({ status: 'unknown-or-failed', message: 'Already submitted; not automatically retried.' }, true);
    }
    const used = (await readdir(config.ledgerDir)).filter(f => f.endsWith('.json'));
    if (used.length >= (config.maxConsults ?? 2)) return reply({ status: 'consultation-limit', message: 'Continue independently or report blocked.' }, true);
    let recordedCost = 0;
    for (const name of used) {
      const old = JSON.parse(await readFile(join(config.ledgerDir,name),'utf8'));
      if (!old.cost?.complete) return reply({status:'unknown-cost',message:'Earlier consultation cost is unknown; no additional paid calls.'},true);
      recordedCost += old.cost.usd;
    }
    if (recordedCost >= 1) return reply({status:'budget-stop',message:'Expert stop-before-next-call threshold reached.'},true);
    const entry = { consultationId: request.consultationId, hash, decision: request, status: 'started', startedAt: new Date().toISOString() };
    await writeFile(file, JSON.stringify(entry, null, 2), { flag: 'wx' });
    releaseLock = false;
    entry.expert = await runCodex({ cwd: config.cwd, outputDir: join(config.ledgerDir, request.consultationId), role: 'advisor',
      prompt: advisorPrompt(config.task, request), timeoutMs: 150000, abortSignal: extra.signal });
    entry.cost = codexCost(entry.expert);
    releaseLock = entry.expert.cleanupVerified === true;
    entry.status = !releaseLock ? 'unknown' : entry.cost.complete && !entry.expert.toolResults.length ? 'completed' : 'failed';
    if (entry.expert.toolResults.length) entry.protocolViolation = 'Advisor used tools despite the text-only consultation contract';
    await writeFile(file + '.tmp', JSON.stringify(entry, null, 2)); await rename(file + '.tmp', file);
    return reply({ status: entry.status, ...(entry.status === 'completed' ? {advice:entry.expert.answer} : {message:'Consultation failed its contract; no advice released. Continue independently or report blocked.'}), cost: entry.cost }, entry.status !== 'completed');
  } catch (error) {
    return reply({ status: 'failed', message: error.message }, true);
  } finally { await lock.close(); if (releaseLock) await unlink(join(config.ledgerDir, 'active.lock')); }
});
await server.connect(new StdioServerTransport());
