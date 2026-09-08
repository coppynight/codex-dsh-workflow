const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export const rates = {
  astra: { input: 10, cache: 1, output: 50, write: 12.5 },
  deepseek: { input: 0.44, cache: 0.014, output: 1.32, write: 0.44 },
};
// Frozen standard API-equivalent prices, not actual subscription deductions.
// DSH peak prices are used for comparison; actual off-peak charges may be lower.
export function costOf(usageEvents, provider) {
  if (!Array.isArray(usageEvents) || !usageEvents.length) return { complete: false, usd: null, reason: 'missing usage' };
  let usd = 0; const totals = { input: 0, cache: 0, output: 0, write: 0 };
  for (const event of usageEvents) {
    const u = event.usage;
    let row;
    if (provider === 'astra') {
      if (!u || ![u.input_tokens, u.cached_input_tokens, u.output_tokens, u.cache_write_input_tokens].every(valid)) return { complete: false, usd: null, reason: 'unknown Astra usage fields' };
      if (u.cached_input_tokens > u.input_tokens || u.cache_write_input_tokens !== 0) return { complete: false, usd: null, reason: 'unsupported cache-write semantics' };
      row = { input: u.input_tokens - u.cached_input_tokens, cache: u.cached_input_tokens, output: u.output_tokens, write: 0 };
      // CLI usage aggregates a turn; per-request long-context pricing is not exposed.
      if (u.input_tokens > 272000) return { complete: false, usd: null, reason: 'per-request long-context tier unknown' };
    } else {
      if (!u || ![u.inputTokens, u.outputTokens, u.totalTokens].every(valid)) return { complete: false, usd: null, reason: 'unknown DSH usage fields' };
      const cache = u.cacheReadTokens ?? 0, write = u.cacheWriteTokens ?? 0;
      if (![cache, write].every(valid) || write !== 0 || u.inputTokens + cache + u.outputTokens !== u.totalTokens) return { complete: false, usd: null, reason: 'DSH usage accounting mismatch' };
      row = { input: u.inputTokens, cache, output: u.outputTokens, write };
    }
    for (const key of Object.keys(totals)) { totals[key] += row[key]; usd += row[key] * rates[provider][key] / 1e6; }
  }
  return { complete: true, usd, tokens: totals, basis: 'API-equivalent; peak DeepSeek, standard Astra; no subscription claim' };
}
