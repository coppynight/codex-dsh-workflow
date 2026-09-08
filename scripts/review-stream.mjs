// Collect public execution metadata, never model reasoning blocks.
export function collectReviewEvent(state, line) {
  let event;
  try { event = JSON.parse(line); } catch { state.invalidLines++; return null; }
  if (!event || typeof event !== 'object' || Array.isArray(event)) { state.invalidLines++; return null; }
  if (event.type === 'system' && event.subtype === 'init') {
    state.initialModel = event.model;
    return { type: 'init', model: event.model, sessionId: event.session_id };
  }
  if (event.type === 'assistant') {
    state.reviewModels.add(event.message?.model || '<missing-model>');
    return { type: 'assistant', model: event.message?.model, tools: (event.message?.content ?? []).filter(block => block.type === 'tool_use').map(block => block.name) };
  }
  if (event.type === 'result') {
    state.result = event;
    return { type: 'result', subtype: event.subtype, isError: event.is_error, sessionId: event.session_id };
  }
  return null;
}

export function verifyReviewModel(state, expected) {
  return state.initialModel === expected && state.reviewModels.size > 0 && [...state.reviewModels].every(model => model === expected);
}
