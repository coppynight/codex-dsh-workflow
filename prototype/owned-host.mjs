import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Only the experimental process identified by this private overlay may be stopped.
export async function stopOwnedHost(spec) {
  const marker=JSON.parse(await readFile(join(spec.privateRoot,'host-process.json'),'utf8'));
  if(marker.pid!==spec.hostPid || resolve(marker.privateRoot)!==resolve(spec.privateRoot) || !Number.isInteger(marker.pid)) throw Error('Host ownership mismatch');
  const overlay=join(spec.privateRoot,'overlay.yml');
  if(process.platform!=='win32') return {stopped:false,reason:'Portable process-tree shutdown is not yet validated; inspect the owned Host before stopping it'};
  const literal=value=>"'"+value.replaceAll("'","''")+"'";
  const command=`$ErrorActionPreference='Stop'; $owned=Get-CimInstance Win32_Process -Filter 'ProcessId = ${marker.pid}'; if (!$owned) { Write-Output 'already-stopped'; exit 0 }; if (!$owned.CommandLine.Contains(${literal(overlay)})) { Write-Output 'ownership-mismatch'; exit 3 }; & taskkill.exe /PID ${marker.pid} /T /F | Out-Null; exit $LASTEXITCODE`;
  return await new Promise(done=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',d=>output+=d);
    child.on('error',()=>done({stopped:false,reason:'Could not inspect owned Host'}));
    child.on('close',code=>done({stopped:code===0,reason:code===0?output.trim()||'owned process tree stopped':'Host identity or shutdown was not verified'}));
  });
}
