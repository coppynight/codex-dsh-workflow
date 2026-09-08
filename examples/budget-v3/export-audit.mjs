import {readFile,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
const [root]=process.argv.slice(2);if(!isAbsolute(root||''))throw Error('Absolute run root required');
const {events}=JSON.parse(await readFile(join(root,'b','private-events.json')));
const state=JSON.parse(await readFile(join(root,'b','private-final-state.json')));
const toolCalls=events.filter(e=>e.type==='tool/call').map(e=>({seq:e.seq,time:e.time,name:e.data.name}));
const approvalRequests=events.filter(e=>e.type==='approval/asked').map(e=>({seq:e.seq,time:e.time}));
const questionRequests=events.filter(e=>['tool/call','tool/code-dispatch-start'].includes(e.type)&&e.data.name==='ask_user_question').map(e=>({seq:e.seq,time:e.time}));
const sourceMessages=events.filter(e=>e.type==='user/message').map(e=>({seq:e.seq,sourceKind:e.data?.source?.kind}));
const selectedMessages=state.messages.filter(m=>[24788,31053,49107,63447,71212].includes(m.seq));
const audit={kind:'Allowlisted event metadata and executor self-report; no raw reasoning or tool arguments',toolCalls,approvalRequests,questionRequests,sourceMessages,selectedMessages};
await writeFile(new URL('./results/b/execution-audit.json',import.meta.url),JSON.stringify(audit,null,2)+'\n');
const ledger={scope:'Fresh task after credentials/runtime had already been configured. Experiment design and publication conversations excluded.',
 a:{requiredHumanRequests:0,actualHumanActions:0,humanMinutes:null,evidence:'All Astra stages returned structured plan/code/acceptance; no tool items and no user action requested. Parent applied returned source and ran frozen tests.'},
 b:{requiredHumanRequests:approvalRequests.length+questionRequests.length,actualHumanActions:0,humanMinutes:null,evidence:'Complete DSH event history has no approval/asked or ask_user_question events. The two user/message records are the original task and plugin sandbox context. Astra acceptance has no tool items or user requests. Parent requested no extra input.'},
 events:[],automaticWork:['One shared Astra plan; parent constructs and sends task contracts','Parent applies Astra code; DSH writes its own code and self-tests','Parent observes original DSH task, verifies terminal/idle state and releases workspace claim','Parent reruns identical visible tests and sends both snapshots to blind Astra review','Parent runs the withheld 17-check acceptance suite for both arms'],
 dshSelfTestNotes:'DSH corrected two self-authored expectation errors and repeatedly diagnosed PowerShell native output capture. No human was asked. Parent did not intervene in those iterations; their entire cost and time are retained.',
 deviations:['DSH reports creating and cleaning scratch test artifacts in platform temporary directories, although its task contract listed only three allowed source paths. Final workspace contains only the three sources and unchanged visible test before external scoring. This is a process-boundary deviation, not strict contract compliance.','The cost ledger excludes parent model coordination and DSH auxiliary title generation; no complete end-to-end cost or subscription debit was observed.'],
 humanReductionPct:null,setupHumanMinutes:null,conclusion:'Both arms had zero new human requests in this one configured run. No reduction percentage or human-time saving can be inferred.'};
await writeFile(new URL('./results/interventions.json',import.meta.url),JSON.stringify(ledger,null,2)+'\n');console.log(JSON.stringify({a:ledger.a,b:ledger.b,toolCalls:toolCalls.length,deviations:ledger.deviations}));
