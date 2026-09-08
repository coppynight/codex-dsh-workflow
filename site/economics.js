(function(){
 'use strict';
 function scenario(offload,overhead){const retained=1-offload/100+overhead/100;if(!Number.isFinite(retained)||retained<=0)throw Error('Invalid scenario');return {retained,factor:1/retained};}
 if(typeof module!=='undefined')module.exports={scenario};
 if(typeof document==='undefined')return;
 const byId=id=>document.getElementById(id);
 function update(){const off=Number(byId('offload').value),over=Number(byId('overhead').value),r=scenario(off,over);byId('offload-value').textContent=off+'%';byId('overhead-value').textContent=over+'%';byId('scenario-result').textContent='此假设下，Astra 保留 '+(r.retained*100).toFixed(0)+'% 工作量，理论容量约 '+r.factor.toFixed(2)+'×。';}
 byId('offload').addEventListener('input',update);byId('overhead').addEventListener('input',update);update();
 fetch('data/budget.json').then(r=>{if(!r.ok)throw Error('Unavailable');return r.json();}).then(data=>{
  const root=byId('economics-result');root.textContent='';
  const table=document.createElement('table');table.className='cost-table';const caption=table.createCaption();caption.textContent='三文件 job-report CLI · 2026-09-08 · 单次配对实测';
  const head=table.createTHead().insertRow();['指标','Astra 全部模型阶段','Astra + DeepSeek'].forEach(s=>{const th=document.createElement('th');th.scope='col';th.textContent=s;head.append(th);});
  const body=table.createTBody();const usd=n=>'$'+n.toFixed(4);const a=data.a,b=data.b;
  const rows=[['最终验收',a.acceptance.passed+'/'+a.acceptance.total,b.acceptance.passed+'/'+b.acceptance.total],['Astra API 等价成本',usd(a.astraUSD),usd(b.astraUSD)],['DeepSeek 额外成本',usd(a.dshUSD),usd(b.dshUSD)],['已记录模型阶段合计',usd(a.totalUSD),usd(b.totalUSD)],['模型阶段用时',Math.round(a.elapsedMs/1000)+' 秒',Math.round(b.elapsedMs/1000)+' 秒'],['新增人工处理请求',a.humanRequests+' 次',b.humanRequests+' 次']];
  rows.forEach(row=>{const tr=body.insertRow();row.forEach((s,i)=>{const el=document.createElement(i?'td':'th');if(!i)el.scope='row';el.textContent=s;tr.append(el);});});root.append(table);
  const p=document.createElement('p');p.className='cost-verdict';p.textContent='本例已记录模型成本下降 '+data.totalReductionPct.toFixed(1)+'%，Astra 等价成本下降 '+data.astraReductionPct.toFixed(1)+'%。双方均未请求人工处理，尚未观察到人工干预差异。';root.append(p);
  const link=document.createElement('a');link.href='https://github.com/coppynight/codex-dsh-workflow/tree/main/examples/budget-v3';link.textContent='查看分阶段用量、源码、验收与局限';root.append(link);
 }).catch(()=>{byId('economics-result').textContent='成本数据暂不可用，请查看仓库 examples/budget-v3 中的公开记录。';});
})();
