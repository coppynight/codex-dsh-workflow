export function sessionAddress(row) {
  if(!row)throw Error('Session is missing from the durable list');
  if(row.origin!=='subagent')return {kind:'session',sessionId:row.sessionId};
  const mode=row.projections?.values?.subagent?.mode;
  if(!row.parentSessionId || !['one-shot','continuable'].includes(mode))throw Error('Child ownership or mode cannot be proven');
  return {kind:'subagent',parentSessionId:row.parentSessionId,childSessionId:row.sessionId,mode};
}
