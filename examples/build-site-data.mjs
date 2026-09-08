import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const read=async name=>JSON.parse(await readFile(join(here,'results',name),'utf8'));
const paired=await read('paired.json'),reliability=await read('reliability.json'),poll=await read('poll-volume.json');
const repo='https://github.com/coppynight/codex-dsh-workflow',base=repo+'/tree/main/examples/results';
const data={updatedAt:paired.date,
 token:{status:paired.totals.astraReductionPct>0?'小样本观察到下降':'两例未观察到节省',...paired.totals,caseCount:paired.cases.length,notes:'本轮工作流 Astra 用量增加 '+Math.abs(paired.totals.astraReductionPct)+'%。两条路径均通过最终验收。这两例审查路径用量更高，读入整份源码可能是原因之一，因此 skill 强化小任务直做、按需审查和精简轮询；尚未取得优化后完整项目的配对收益。'},
 delivery:{regressionsFixed:reliability.cases.filter(c=>c.verified).length,regressionsTotal:reliability.cases.length,notes:'三项明确的恢复/配置故障均可复现并由测试捕获。另一个真实案例中，DSH 自测漏掉的 key=hello 误脱敏，被 Astra 审查修复，独立验收从 11/12 提升到 12/12；Astra 直接生成也通过 12/12。'},
 cases:paired.cases.map(c=>({id:c.id,title:c.title,kind:'实测 · 配对子会话',status:'最终双方通过',summary:`Astra 直接生成 ${c.astra.acceptance.details.passed}/${c.astra.acceptance.details.total}；DSH 自测后独立验收 ${c.workflow.dsh.acceptance.details.passed}/${c.workflow.dsh.acceptance.details.total}，经 Astra 审查后 ${c.workflow.acceptance.details.passed}/${c.workflow.acceptance.details.total}。Astra 用量变化：${c.astraReductionPct}%（下降比例，负值表示增加）。DSH 单列 ${c.workflow.dsh.usageTotals.totalTokens.toLocaleString('en-US')} tokens，未合并为费用。A 路径 ${Math.round(c.astra.elapsedMs/1000)} 秒；B 模型阶段合计 ${Math.round(c.workflow.stageElapsedMs/1000)} 秒，不含父级等待/协调。`,baseline:c.astra.astraTokens,workflow:c.workflow.astraTokens,evidenceUrl:base+'/'+c.id})),
 links:{repo,examples:repo+'/tree/main/examples',methodology:repo+'/blob/main/examples/benchmarks/PROTOCOL.md'}};
data.cases.push({id:'compact-observation',title:'少读重复历史，保留阻塞与错误',kind:'优化 · 合成回放',status:'字节量下降 '+poll.reductionPct+'%',summary:`同一固定夹具的 10 次观察，原响应合计 ${poll.beforeBytes.toLocaleString('en-US')} 字节；摘要轮询 + 一次完整证据合计 ${poll.afterBytes.toLocaleString('en-US')} 字节，下降 ${poll.reductionPct}%。这是序列化 JSON 的 UTF-8 字节量，不是实测模型 tokens。请求身份、审批、问题、结束原因与错误仍保留。`,baseline:null,workflow:null,evidenceUrl:base+'/poll-volume.json'});
data.cases.push({id:'recovery-regressions',title:'配置、冷却与认证的三个故障回放',kind:'验证 · 故障重建',status:'3 / 3 验证',summary:'分别移除自定义配置传递、损坏状态校验、一次认证刷新：三项定向测试均失败；当前实现均通过。运行于本机离线夹具，不推断 Astra 会漏掉这些问题，也不等于真实项目交付率提升。',baseline:null,workflow:null,evidenceUrl:base+'/reliability.json'});
const dest=join(here,'../site/data');await mkdir(dest,{recursive:true});await writeFile(join(dest,'summary.json'),JSON.stringify(data,null,2)+'\n');console.log('site/data/summary.json generated from published evidence');
