import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base=await mkdtemp(join(tmpdir(),'dsh-auth-fixture-'));
const pkg=join(base,'runtime/node_modules/@deepseek-ai/dsh-api-session-controller');
await mkdir(pkg,{recursive:true});
await writeFile(join(base,'runtime/package.json'),'{}');
await writeFile(join(pkg,'package.json'),JSON.stringify({type:'module',exports:{'./remote':'./remote.mjs'}}));
await writeFile(join(pkg,'remote.mjs'),`const codec={schema:{parse:x=>x}};export const TYPERT_REMOTE={descriptors:[{namespace:'session',method:'follow',mode:'stream',parameters:[{wire:'input',codec}],result:codec},{namespace:'session',method:'control',mode:'stream',parameters:[],result:codec}]};`);
let upgrades=0, exchanges=0, rejectAll=false;
const server=createServer((req,res)=>{exchanges++;res.writeHead(303,{location:'/', 'set-cookie':`dsh-auth-fixture=${exchanges}; HttpOnly`});res.end();});
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{
  upgrades++;
  if(rejectAll || upgrades===1){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
  wss.handleUpgrade(req,socket,head,ws=>{
    ws.on('error',()=>{});
    ws.on('message',data=>{
      const request=JSON.parse(String(data));if(request.type!=='open')return;
      const value=request.endpoint==='session/control'?{type:'baseline',value:{queues:{},jobs:{}}}:{type:'snapshot',records:[],cursor:0,hasMore:false,projections:{}};
      ws.send(JSON.stringify({type:'item',streamId:request.streamId,value}));
    });
  });
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`, log=join(base,'host.log'), config=join(base,'config.json');
await writeFile(log,`dsh web: ${origin}/?token=fixture-only\n`);
await writeFile(config,JSON.stringify({dsh:{installDir:join(base,'runtime'),origin,logPath:log,stateDir:join(base,'state')}}));
process.env.WORKFLOW_CONFIG=config;
const {observe,discardCachedAuth}=await import('../bridge/client.mjs');
const {readControl}=await import('../bridge/control.mjs');

for(const [name,run] of [['follow',()=>observe('fixture',0)],['control',()=>readControl()]]) {
  test(`${name}: stale handshake authentication refreshes once and completes promptly`,async()=>{
    upgrades=0;exchanges=0;rejectAll=false;discardCachedAuth();const start=Date.now();
    assert.ok(await run());assert.equal(upgrades,2);assert.equal(exchanges,2);assert.ok(Date.now()-start<5000);
  });
  test(`${name}: repeated 401 is bounded to two handshakes with no late retry`,async()=>{
    upgrades=0;exchanges=0;rejectAll=true;discardCachedAuth();
    await assert.rejects(run(),/handshake refused/);
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(upgrades,2);assert.equal(exchanges,2);
  });
}
test.after(async()=>{for(const ws of wss.clients)ws.terminate();wss.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(base,{recursive:true,force:true});});
