import {spawn} from 'node:child_process';
export async function verifyCommand(command,cwd,timeoutMs=30000,extraEnv={}){
  const [executable,...args]=command;
  const child=spawn(executable,args,{cwd,env:{...process.env,...extraEnv},windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',d=>{stdout=(stdout+d).slice(-64000);});child.stderr.on('data',d=>{stderr=(stderr+d).slice(-64000);});
  let timedOut=false,cleanupVerified=true,grace,settle,killing;
  const finished=new Promise(done=>{settle=done;child.once('error',e=>done({code:null,error:e.code}));child.once('close',code=>done({code}));});
  const timer=setTimeout(()=>{
    timedOut=true;cleanupVerified=false;
    if(child.exitCode!==null||child.signalCode!==null){child.stdout.destroy();child.stderr.destroy();child.unref();settle({code:null});return;}
    if(process.platform==='win32'&&child.pid){
      killing=new Promise(done=>{const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('error',()=>done(false));killer.once('close',code=>done(code===0));});
    } else {try{process.kill(-child.pid,'SIGTERM');}catch{/* keep unknown */}}
    grace=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();child.unref();settle({code:null});},10000);
  },timeoutMs);
  const result=await finished;clearTimeout(timer);clearTimeout(grace);
  if(killing)cleanupVerified=await Promise.race([killing,new Promise(done=>{const wait=setTimeout(()=>done(false),2000);wait.unref();})]);
  return {status:!timedOut&&result.code===0?'passed':'failed',exitCode:result.code,error:result.error,timedOut,cleanupVerified,stdout,stderr};
}
