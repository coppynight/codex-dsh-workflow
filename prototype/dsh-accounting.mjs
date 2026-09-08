import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installDir } from '../bridge/runtime.mjs';
const requireDsh = createRequire(join(installDir, 'package.json'));
const packageRoot = dirname(requireDsh.resolve('@deepseek-ai/dsh-token-meter/package.json'));
const { tokenUsageProjectionDefinition: fold } = await import(pathToFileURL(join(packageRoot, 'lib/types/usage-projection.js')));
const { deriveTurnTokenUsage } = await import(pathToFileURL(join(packageRoot, 'lib/types/turn-usage.js')));

export function accountEvents(rawEvents) {
  const events = [...new Map(rawEvents.map(e => [e.seq, e])).values()].sort((a,b) => a.seq-b.seq);
  const state = events.reduce((s,e) => fold.apply(s,e), fold.init());
  const t = state.totals;
  const completedTurns = []; let own = null;
  for (const event of events) {
    if (event.type === 'turn/start') own = [];
    if (own) own.push(event);
    if (event.type === 'turn/end' && own) { completedTurns.push({ turn: event.data.turn, usage: deriveTurnTokenUsage(own) ?? null }); own = null; }
  }
  const sampleCount = events.filter(e => e.type === 'assistant/message' && e.data?.usage || e.type === 'assistant/chunk' && e.data?.chunk?.type === 'usage').length;
  return {
    method: 'installed DSH tokenUsage v2 fold + deriveTurnTokenUsage; streaming samples replace final samples; retries counted',
    usageEvents: sampleCount ? [{ usage: { inputTokens: t.uncachedInputTokens, cacheReadTokens: t.cacheReadTokens, cacheWriteTokens: t.cacheWriteTokens, outputTokens: t.outputTokens, totalTokens: Object.values(t).reduce((a,b)=>a+b,0) } }] : [],
    coverageComplete: !own && completedTurns.length > 0 && completedTurns.every(t => t.usage !== null), completedTurns,
    routes: events.filter(e=>e.type==='request/header').map(e=>({seq:e.seq,provider:e.data?.header?.config?.provider,model:e.data?.header?.config?.model})),
    auxiliaryEvents: events.filter(e=>/compact|summari/.test(e.type)).map(e=>({seq:e.seq,type:e.type})),
  };
}
