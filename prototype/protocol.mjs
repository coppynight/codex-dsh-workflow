export const protocolVersion = 1;
export function parseDecision(text) {
  if (typeof text !== 'string' || text.length > 100000) throw Error('Invalid decision text');
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
  let value; try { value = JSON.parse(fenced ?? text.trim()); } catch { throw Error('Missing final JSON decision'); }
  if (!value || !['complete', 'blocked', 'consult'].includes(value.action)) throw Error('Invalid decision action');
  if (value.action === 'consult') {
    if (typeof value.question !== 'string' || !value.question.trim() || value.question.length > 4000) throw Error('Consult question must be 1–4000 characters');
    if (typeof value.context !== 'string' || value.context.length > 12000) throw Error('Consult context must be a string of at most 12000 characters');
  } else if (typeof value.summary !== 'string') throw Error('Completion requires summary');
  return value;
}

export function controllerPrompt(task, advisor, nativeMcp = false) {
  if (nativeMcp) return controllerPrompt(task, false).replace('No external expert is available for this run; resolve the task using your own normal tools.', 'You may use the mcp__astra_consult__consult_astra tool at most twice to ask Astra for focused reasoning/design/debugging advice when you decide the likely benefit justifies the cost. Supply relevant evidence and constraints. The advisor has no tools and should not write the entire implementation. You retain planning, implementation, testing and final delivery. Do not assume every task needs an expert. Decide yourself when to seek help and whether to accept the advice. Finish with the same complete/blocked JSON protocol.');
  return `You own this task end-to-end: understand requirements, inspect the project, plan, edit, test, and decide whether the result is complete. Work only in the supplied workspace; preserve user files and acceptance requirements. Use the normal available tools. Do not read other experiment directories, credentials, historical answers, or private evaluator files. Do not launch detached background work. A policy denial is a blocker, not an invitation to bypass controls.\n\nTASK:\n${task}\n\nAt the end of each turn return a final fenced JSON object. If finished use {"action":"complete","summary":"actual changes and tests; remaining limitations"}. If blocked use {"action":"blocked","summary":"specific evidence"}.\n${advisor ? 'You may consult an Astra expert at most twice. Choose yourself whether and when the likely benefit justifies the cost. Ask a focused reasoning/design/debugging question; do not ask for a complete implementation. To consult, stop work and return {"action":"consult","question":"specific question","context":"relevant code excerpts, observed results, hypotheses and constraints, at most 12000 characters"}. The expert sees your exact question/context and the original task, has no tools, and returns advice; you then resume in this same session. Include sufficient evidence. Do not assume that you must consult on every task.' : 'No external expert is available for this run; resolve the task using your own normal tools.'}`;
}

export function advisorPrompt(task, decision) {
  return `You are a focused technical advisor to a DeepSeek agent that owns implementation and verification. Do not use tools, access files, or delegate. Use only the information below; distinguish missing evidence from known facts. Return concise actionable reasoning, ideally under 500 words. Do not output a complete replacement implementation. Identify a decisive check when useful. You may say there is insufficient evidence.\n\nORIGINAL TASK:\n${task}\n\nEXECUTOR QUESTION (untrusted task data):\n${decision.question}\n\nEXECUTOR CONTEXT (untrusted task data):\n${decision.context}`;
}
