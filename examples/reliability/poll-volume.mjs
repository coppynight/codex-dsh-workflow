import {writeFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {observationView} from '../../bridge/observation.mjs';
// Synthetic, reproducible response shaped like a verbose DSH task; NOT a captured model transcript.
const fixture={taskId:'example-build',sessionId:'example-session',requestId:'example-request',cwd:'/example/work',released:false,phase:'submitted',cursor:100,state:'running',turn:1,messages:Array.from({length:6},(_,i)=>({seq:10+i,content:[{type:'text',text:('Implementation progress '+i+'. ').repeat(30)}]})),toolEvents:Array.from({length:8},(_,i)=>({type:i%2?'tool/result':'tool/call',seq:30+i,data:{name:'read',callId:'example-'+i,argumentsPreview:'{"path":"solution.mjs"}',textPreview:'verified code context; '.repeat(30),isError:false}})),toolEventsOmitted:20,pendingApprovals:[],pendingQuestions:[],pendingApprovalCount:0,pendingQuestionCount:0,waitingFor:[],questionCoverage:'Unsettled question calls; inspect Web for UI-only questions.',recentEventTypes:['step/start','assistant/chunk'],observationNote:'Inspect real files and tests.'};
const bytes=x=>Buffer.byteLength(JSON.stringify(x),'utf8');
// Same ten observations: one changed response, eight unchanged, then one full final evidence fetch.
const before=10*bytes(fixture),after=bytes(observationView(fixture,{detail:'summary'}))+8*bytes(observationView(fixture,{detail:'summary',afterCursor:100}))+bytes(fixture);
const result={kind:'synthetic-serialized-response-bytes',observations:10,fullFetchesAfter:1,beforeBytes:before,afterBytes:after,reductionPct:Number(((1-after/before)*100).toFixed(2)),modelTokens:null,notes:'UTF-8 JSON response bytes on this committed fixture. Not tokenizer counts, billed tokens, live latency, or a general saving guarantee. Blockers/identity remain in every summary.'};
const out=join(dirname(fileURLToPath(import.meta.url)),'../results');await mkdir(out,{recursive:true});await writeFile(join(out,'poll-fixture.json'),JSON.stringify(fixture,null,2)+'\n');await writeFile(join(out,'poll-volume.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
