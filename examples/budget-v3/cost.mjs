import pricing from './pricing.json' with {type:'json'};
const finite=n=>{if(!Number.isFinite(n)||n<0)throw Error('Missing or invalid usage');return n;};
export function astraUsage(events){
 if(!Array.isArray(events)||!events.length)throw Error('Missing usage events');
 return events.reduce((s,e)=>{const u=e.usage;if(!u||u.cache_write_input_tokens!==0)throw Error('Unverified cache-write accounting');const input=finite(u.input_tokens),cache=finite(u.cached_input_tokens);if(cache>input)throw Error('Cache exceeds input');s.uncachedInput+=input-cache;s.cacheRead+=cache;s.output+=finite(u.output_tokens);return s;},{uncachedInput:0,cacheRead:0,output:0});
}
export function dshUsage(events){
 if(!Array.isArray(events)||!events.length)throw Error('Missing usage events');
 return events.reduce((s,e)=>{const u=e.usage;const input=finite(u.inputTokens),cache=finite(u.cacheReadTokens??0),output=finite(u.outputTokens);if((u.cacheWriteTokens??0)!==0||input+cache+output!==finite(u.totalTokens))throw Error('Unverified DSH usage schema');s.uncachedInput+=input;s.cacheRead+=cache;s.output+=output;return s;},{uncachedInput:0,cacheRead:0,output:0});
}
export const price=(usage,rates)=>Object.entries(usage).reduce((s,[key,n])=>s+finite(n)*finite(rates[key]),0)/1e6;
export const astraCost=events=>price(astraUsage(events),pricing.astraStandard);
export const astraCredits=events=>price(astraUsage(events),pricing.astraCodexCredits);
export const dshCost=(events,peak)=>price(dshUsage(events),peak?pricing.deepseekV4FlashPeak:pricing.deepseekV4FlashOffPeak);
export function capacityScenario(retained,qualityRatio=1){if(!(retained>0&&retained<=1&&qualityRatio>=0&&qualityRatio<=1))throw Error('Invalid scenario');return qualityRatio/retained;}
