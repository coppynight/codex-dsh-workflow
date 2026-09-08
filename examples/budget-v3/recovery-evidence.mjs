import {spawnSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
const cases=[
 ['stopped-host','tests/dsh-recover.test.mjs','stopped host: exactly one guarded start','恢复已配置 Host：一次有界启动后健康'],
 ['stale-auth','tests/auth-refresh.test.mjs','follow: stale handshake','过期本地认证：刷新一次并完成'],
 ['foreign-port','tests/dsh-recover.test.mjs','foreign 3080 listener','未知端口占用：停止恢复，不替换外部进程'],
 ['live-not-ready','tests/dsh-recover.test.mjs','matching process alive but not ready','进程未就绪：有限等待，不重复启动'],
 ['missing-key','bridge/client.test.mjs','missing credentials surface','缺凭据：提供配置引导，不泄漏原始错误'],
 ['checkpoint','tests/dsh-recover.test.mjs','task checkpoint persisted on success','故障后保留原任务 checkpoint']
];
const results=cases.map(([id,file,pattern,behavior])=>{const r=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-name-pattern',pattern,file],{encoding:'utf8',timeout:30000,windowsHide:true});const matchedPass=Number(r.stdout.match(/# pass (\d+)/)?.[1]??0),matchedFail=Number(r.stdout.match(/# fail (\d+)/)?.[1]??0);return {id,file,pattern,behavior,exitCode:r.status,matchedPass,matchedFail,verified:r.status===0&&matchedPass===1&&matchedFail===0};});
const data={kind:'offline fault fixtures, not human trial',at:new Date().toISOString(),cases:results,observedHumanMinutes:null,humanReductionPct:null,limitations:'Mocks exercise concrete recovery branches; blocked cases are correct containment, not recovered deliveries. No native Codex or raw-DSH human baseline was measured.'};
await writeFile(new URL('./recovery-results.json',import.meta.url),JSON.stringify(data,null,2)+'\n');console.log(JSON.stringify(data));if(results.some(x=>!x.verified))process.exitCode=1;
