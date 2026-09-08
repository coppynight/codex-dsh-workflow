#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { configPath, loadConfig, skillRoot, isMain } from './config.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('node scripts/doctor.mjs [--init --workspace ABS_DIR [--auto-start]] [--online-dsh]'); return; }
  let init=false, online=false, autoStart=false, workspace;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--init') init=true;
    else if(args[i]==='--online-dsh') online=true;
    else if(args[i]==='--auto-start') autoStart=true;
    else if(args[i]==='--workspace' && args[i+1]) workspace=args[++i];
    else throw new Error('Unknown doctor argument. Use --help.');
  }
  if((workspace || autoStart) && !init) throw new Error('--workspace and --auto-start require --init. Edit an existing config locally.');
  if(init) {
    if(!workspace || !isAbsolute(workspace) || !existsSync(workspace)) throw new Error('--init requires an existing absolute --workspace directory.');
    const file=configPath(); await mkdir(dirname(file),{recursive:true});
    await writeFile(file,JSON.stringify({version:1,dsh:{workspaceRoots:[workspace],autoStart}},null,2)+'\n',{flag:'wx',mode:0o600});
  }
  const config=loadConfig(), checks=[];
  checks.push({id:'node',ok:Number(process.versions.node.split('.')[0])>=24,version:process.versions.node,action:'Install Node.js 24+ if unavailable.'});
  const require=createRequire(join(skillRoot,'package.json'));
  for(const name of ['@modelcontextprotocol/sdk/server/mcp.js','ws','zod']) {
    let ok=false; try {require.resolve(name);ok=true;}catch{}
    checks.push({id:`dependency:${name}`,ok,action:'Run npm ci in the installed skill directory.'});
  }
  let version=null;
  try {version=JSON.parse(readFileSync(join(config.dsh.installDir,'node_modules/@deepseek-ai/dsh/package.json'),'utf8')).version;}catch{}
  checks.push({id:'dsh-runtime',ok:version==='0.1.2-rc.1',version,action:'Install the tested DSH 0.1.2-rc.1 in dsh.installDir; see references/setup.md. Version mismatch requires compatibility validation.'});
  checks.push({id:'workspaces',ok:config.dsh.workspaceRoots.length>0 && config.dsh.workspaceRoots.every(existsSync),action:'Set existing, narrowly scoped dsh.workspaceRoots in the user configuration.'});
  checks.push({id:'host-log',ok:existsSync(config.dsh.logPath),action:'If configured, run scripts/dsh-recover.mjs to start a stopped Host.'});
  let host=null;
  if(online) {
    try {host=await (await import('../bridge/service.mjs')).hostStatus();}
    catch {host={connected:false,action:'Run dsh-recover.mjs; inspect dependency, log-location and port diagnostics. No model task was submitted.'};}
  }
  console.log(JSON.stringify({configFile:config.file,checks,host,claude:'not-contacted; explicit current-session network confirmation required',fallback:'Codex can implement and review while optional dependencies are unavailable.'},null,2));
  if(checks.some(c=>!c.ok && c.id!=='host-log') || (online && (host?.connected!==true || host?.modelReady===false))) process.exitCode=2;
}
if(isMain(import.meta.url)) main().catch(()=>{console.error('Doctor could not read or initialize configuration. Existing files are preserved. Check paths, JSON and --help; see references/setup.md.');process.exitCode=2;});
