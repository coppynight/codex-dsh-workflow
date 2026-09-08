const $=id=>document.getElementById(id);
const notes={
 'pilot-01':'三个明确规格的组件任务。高思考强度 DSH 与原生 Astra 对照。可选专家是否调用，由 DSH 自己决定。',
 'pilot-low-01':'在同样三题上降低 DSH 思考强度。重复配置探索，不是新增能力样本。Astra 行复用原始同题基线。',
 'pilot-compatible-01':'同样三题，将自测改为 Node 同进程执行；保持 DSH 沙箱不变。此处仍要求最终 JSON，记录了由此产生的中断。',
 'pilot-feedback-01':'同样三题，以原生完成状态和独立验收驱动交付；失败后最多一次高思考强度 Flash 修复，计入全部费用。验收失败输出已反馈，因此不是盲测。',
 'pilot-next-01':'未完成的对照：Astra 多次连接超时后退出，完整重试费用未知，独立验收 7/8。费用保护停止了预定修复、两个 DSH 臂和另行准备的 Pro 尝试。此阶段不能比较模型优劣。'
};
function cell(row,text,className){const td=document.createElement('td');td.textContent=text;if(className)td.className=className;row.append(td);return td;}
function render(data){
 const phase=$('phase').value;const groups=data.groups.filter(g=>g.runId===phase&&g.attempts>0);
 if(!groups.some(g=>g.arm==='astra')){const baseline=data.groups.find(g=>g.runId==='pilot-01'&&g.arm==='astra');if(baseline)groups.unshift(baseline);}
 $('phase-note').textContent=notes[phase];$('comparison').replaceChildren();
 for(const g of groups){const tr=document.createElement('tr');
  cell(tr,g.arm==='astra'?'Astra 原生执行':g.arm==='dsh-alone'?'DSH 独立执行':'DSH + 可选 Astra');
  cell(tr,`${g.firstAcceptancePasses}/${g.attempts}`);cell(tr,`${g.artifactPasses}/${g.attempts}`);cell(tr,`${g.autonomousSuccesses}/${g.attempts}`,g.autonomousSuccesses===g.attempts?'pass':'fail');
  const price=cell(tr,'');const strong=document.createElement('strong');strong.textContent=g.costRatio===null?'费用未知':`${(g.costRatio*100).toFixed(1)}%`;const small=document.createElement('span');small.className='sub';small.textContent=g.totalApiEquivalentUsd===null?'完整计费证据不足':`$${g.totalApiEquivalentUsd.toFixed(4)} · 合计`;price.append(strong,small);
  cell(tr,g.executionTimeRatio===null?'—':`${g.executionTimeRatio.toFixed(2)}×`);cell(tr,String(g.consultations));$('comparison').append(tr);
 }
}
fetch('dsh-led-data.json').then(r=>{if(!r.ok)throw Error('data');return r.json();}).then(data=>{
 $('task-count').textContent=`${data.uniqueTasks} 类`;$('attempt-count').textContent=`${data.attempts} 次`;$('consult-count').textContent=String(data.runs.reduce((n,r)=>n+r.consultations.length,0));render(data);$('phase').addEventListener('change',()=>render(data));
}).catch(()=>{$('data-error').textContent='数据暂时未能加载。完整原始记录仍可从上方仓库链接查看。';});
function calculate(){const cheap=Number($('cheap').value),strong=Number($('strong').value),expert=Number($('expert').value),p=Number($('frequency').value)/100;$('frequency-label').textContent=`${Math.round(p*100)}%`;
 if(![cheap,strong,expert,p].every(Number.isFinite)||cheap<0||strong<=0||expert<=0){$('calc-cost').textContent='请填写有效价格';$('calc-ratio').textContent='';$('calc-limit').textContent='';return;}
 const total=cheap+p*expert,limit=(strong*.1-cheap)/expert;$('calc-cost').textContent=`$${total.toFixed(3)}`;$('calc-ratio').textContent=`相当于强模型完整任务的 ${(100*total/strong).toFixed(1)}%`;
 $('calc-limit').textContent=limit<0?'这个假设下，便宜路径本身已超过十分之一预算。':limit>=1?'这个假设下，每项任务咨询一次仍在十分之一预算内。':`要维持十分之一成本，咨询任务比例最多约 ${(limit*100).toFixed(1)}%。`;
}
for(const id of ['cheap','strong','expert','frequency'])$(id).addEventListener('input',calculate);calculate();
