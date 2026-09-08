import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {status,cancel,release} from '../../bridge/service.mjs';
import {readEvents} from '../../bridge/client.mjs';
const [root,id]=process.argv.slice(2);if(!isAbsolute(root||'')||!['original-low','bounded-high','bounded-low'].includes(id))throw Error('Root and registered variant required');
const dir=join(root,id),request=JSON.parse(await readFile(join(dir,'request.json'))),first=await status(request.taskId,0,undefined,{detail:'summary'});
let start,deadlineCancelled=false,current=first;
const events0=await readEvents(first.sessionId);start=events0.events.find(e=>e.type==='turn/start')?.time??Date.now();
await writeFile(join(dir,'checkpoint.json'),JSON.stringify({taskId:request.taskId,sessionId:first.sessionId,requestId:first.requestId,start,deadlineMs:300000}));
for(let i=0;i<21&&!['completed','error','aborted','blocked','max-tokens','interrupted'].includes(current.state);i++){
 if(Date.now()-start>=300000&&!deadlineCancelled){await cancel(request.taskId);deadlineCancelled=true;console.log(JSON.stringify({id,action:'deadline-cancel'}));}
 current=await status(request.taskId,20,undefined,{detail:'summary',afterCursor:current.cursor});
 if(current.pendingApprovalCount||current.pendingQuestionCount)console.log(JSON.stringify({id,state:current.state,pendingApprovals:current.pendingApprovalCount,pendingQuestions:current.pendingQuestionCount}));
}
const data=await readEvents(first.sessionId);await writeFile(join(dir,'private-events.json'),JSON.stringify(data));
await writeFile(join(dir,'private-state.json'),JSON.stringify(await status(request.taskId),null,2));
const record={id,taskId:request.taskId,sessionId:first.sessionId,requestId:first.requestId,state:current.state,deadlineCancelled,selectedModel:data.events.filter(e=>e.type==='model/selection').map(e=>e.data),turnEvents:data.events.filter(e=>['turn/start','turn/end'].includes(e.type)).map(({seq,time,type,data})=>({seq,time,type,data})),usageEvents:data.events.filter(e=>e.type==='assistant/message'&&e.data?.usage).map(e=>({seq:e.seq,time:e.time,usage:e.data.usage})),toolCalls:data.events.filter(e=>e.type==='tool/call').map(e=>({seq:e.seq,time:e.time,name:e.data.name})),approvalRequests:data.events.filter(e=>e.type==='approval/asked').map(e=>({seq:e.seq,time:e.time})),questionRequests:data.events.filter(e=>['tool/call','tool/code-dispatch-start'].includes(e.type)&&e.data.name==='ask_user_question').map(e=>({seq:e.seq,time:e.time}))};
await writeFile(join(dir,'dsh-record.json'),JSON.stringify(record,null,2)+'\n');
const released=await release(request.taskId);await writeFile(join(dir,'release.json'),JSON.stringify(released));
console.log(JSON.stringify({id,state:record.state,deadlineCancelled,usageEvents:record.usageEvents.length,toolCalls:record.toolCalls.length,selectedModel:record.selectedModel,elapsedMs:record.turnEvents.at(-1).time-start,released}));
