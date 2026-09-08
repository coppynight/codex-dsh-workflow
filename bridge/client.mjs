import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { origin, apiUrl, muxWebSocketUrl, logPath, loadDescriptors } from './runtime.mjs';
import { rpcErrorMessage } from './sanitize.mjs';

// Session methods with observable side effects: never auto-retried, even on
// an authentication failure (the bridge may only refresh its cookie once, and
// only on read-only calls).
const READ_METHODS = new Set(['modelCatalog', 'list', 'page']);

let cachedTokenUrl, cachedCookie;

async function exchangeCookie(tokenUrl) {
  let response;
  try { response = await fetch(tokenUrl, { redirect: 'manual', signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error('Cannot authenticate to the local DSH Host.'); }
  try {
    if (response.status !== 303 || response.headers.get('location') !== '/') throw new Error('DSH authentication exchange refused.');
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('dsh-auth-'))?.split(';')[0];
    if (!cookie) throw new Error('DSH authentication cookie missing.');
    return cookie;
  } finally {
    await response.body?.cancel();
  }
}

function forgetCookie() { cachedTokenUrl = undefined; cachedCookie = undefined; }

/** Drop the cached auth cookie so the next request performs a fresh exchange. */
export function discardCachedAuth() { forgetCookie(); }

/**
 * Authenticate against the configured local DSH Host. The one-time token URL
 * is read from the configured startup log and validated against the configured
 * origin; it is never echoed to callers. force=true ignores the cache (used by
 * the single read-only refresh).
 */
export async function authHeaders(force = false) {
  let log;
  try { log = await readFile(logPath, 'utf8'); }
  catch { throw new Error('DSH startup log unavailable. Start the local DSH Host and verify dsh.logPath in the user configuration.'); }
  const raw = [...log.matchAll(/^dsh web:\s+(http:\/\/\S+)\s*$/gm)].at(-1)?.[1];
  if (!raw) throw new Error('DSH has not announced readiness in its startup log.');
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid local DSH startup entry in the startup log.'); }
  if (url.origin !== origin || url.pathname !== '/' || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].length !== 1 || !url.searchParams.get('token')) {
    throw new Error('DSH startup origin does not match the configured local Host (the user configuration dsh.origin).');
  }
  if (force || raw !== cachedTokenUrl || !cachedCookie) {
    cachedCookie = await exchangeCookie(url);
    cachedTokenUrl = raw;
  }
  return { cookie: cachedCookie };
}

async function contract(method, values) {
  const TYPERT_REMOTE = await loadDescriptors();
  const d = TYPERT_REMOTE.descriptors.find((entry) => entry.namespace === 'session' && entry.method === method);
  if (!d || d.parameters.length !== values.length) throw new Error('Unsupported DSH method or argument count.');
  const args = Object.fromEntries(d.parameters.map((parameter, index) => [parameter.wire, parameter.codec.schema.parse(values[index])]));
  return { d, args, endpoint: `session/${method}` };
}

/**
 * One authenticated RPC. Read-only calls refresh the cookie at most once when
 * the Host answers 401/403; writes are never automatically retried.
 */
async function rpc(method, args, write) {
  const endpoint = `session/${method}`;
  const attempt = async (retried) => {
    const rpcId = randomUUID();
    const response = await fetch(apiUrl(endpoint), {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...await authHeaders() },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      if (!write && !retried) { forgetCookie(); return attempt(true); }
      throw new Error(write
        ? 'DSH authentication failed; the write was NOT retried. Inspect the same saved task/request before deciding how to continue.'
        : 'DSH authentication failed.');
    }
    if (!response.ok) {
      const detail = `DSH HTTP ${response.status} for ${endpoint}`;
      await response.body?.cancel();
      throw new Error(write ? `${detail}; writes are not automatically retried.` : detail);
    }
    const body = await response.json();
    if (body.type !== 'server-response' || body.rpcId !== rpcId) throw new Error('DSH RPC correlation failed.');
    if (body.result?.ok !== true) {
      const code = body.result?.error?.code;
      throw new Error(rpcErrorMessage(code, body.result?.error?.message, { endpoint, write }));
    }
    return body.result.value;
  };
  return attempt(false);
}

export async function call(method, ...values) {
  const { d, args } = await contract(method, values);
  if (d.mode === 'stream') throw new Error('Use the stream reader for this method.');
  const value = await rpc(method, args, !READ_METHODS.has(method));
  return d.result.schema.parse(value);
}

export async function observe(sessionId, seconds = 0) {
  const address = typeof sessionId === 'string' ? { kind: 'session', sessionId } : sessionId;
  const { d, args, endpoint } = await contract('follow', [{ address, maxMessages: 100 }]);
  const run = async (retried) => {
    const headers = await authHeaders();
    return new Promise((resolve, reject) => {
      const streamId = randomUUID();
      let snapshot, timer, settled = false, handshakeStatus = null;
      const events = [];
      const ws = new WebSocket(muxWebSocketUrl, { headers, followRedirects: false });
      const cleanup = () => { clearTimeout(handshake); clearTimeout(timer); };
      const finish = (error, value) => {
        if (settled) return; settled = true;
        cleanup();
        if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'cancel', streamId })); ws.close(); }
        else ws.terminate();
        if (error) reject(error); else resolve(value);
      };
      const handshake = setTimeout(() => finish(new Error('DSH stream readiness timed out.')), 15000);
      ws.on('unexpected-response', (request, response) => {
        if (settled) { response.resume(); return; }
        handshakeStatus = response.statusCode; response.resume();
        if (!retried && (handshakeStatus === 401 || handshakeStatus === 403)) {
          settled=true; cleanup(); ws.terminate(); forgetCookie();
          run(true).then(resolve,reject);
        } else finish(new Error('DSH event stream handshake refused after bounded authentication refresh.'));
      });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } })));
      ws.on('error', () => {
        if (settled) return;
        finish(new Error('DSH authenticated event stream failed.'));
      });
      ws.on('close', () => { if (!settled) finish(new Error('DSH stream closed before observation completed.')); });
      ws.on('message', (data) => {
        if (settled) return;
        try {
          const frame = JSON.parse(data.toString());
          if (frame.streamId !== streamId) return;
          if (frame.type === 'error') throw new Error(rpcErrorMessage(frame.error?.code, frame.error?.message, { endpoint }));
          if (frame.type !== 'item') return;
          const value = d.result.schema.parse(frame.value);
          if (value.type === 'snapshot') {
            snapshot = value; clearTimeout(handshake);
            timer = setTimeout(() => finish(null, { snapshot, events }), Math.max(0, Math.min(30, seconds)) * 1000);
          } else if (value.type === 'event') events.push(value.event);
        } catch (error) { finish(error); }
      });
    });
  };
  return run(false);
}

export async function readEvents(sessionId, seconds = 0) {
  const address = typeof sessionId === 'string' ? { kind: 'session', sessionId } : sessionId;
  const { snapshot, events } = await observe(sessionId, seconds);
  let records = [...snapshot.records], more = snapshot.hasMore;
  for (let i = 0; more && i < 20; i++) {
    const first = records[0]?.event?.seq;
    if (!Number.isInteger(first)) throw new Error('Cannot safely page DSH history.');
    const page = await call('page', { address, throughSeq: snapshot.cursor, beforeSeq: first, maxMessages: 100 });
    records = [...page.records, ...records]; more = page.hasMore;
  }
  if (more) throw new Error('DSH history exceeds bounded reader; inspect the session in DSH Web.');
  const all = [...records.filter((r) => r.type === 'event').map((r) => r.event), ...events];
  return { cursor: Math.max(snapshot.cursor, ...events.map((e) => e.seq)), events: all, projections: snapshot.projections, header: snapshot.header };
}

const textBlocks = (content) => (Array.isArray(content) ? content : [])
  .filter((block) => block?.type === 'text' && typeof block.text === 'string')
  .map((block) => ({ type: 'text', text: block.text }));
const clip = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined;
const toolEventTypes = new Set(['tool/call', 'tool/result', 'tool/code-dispatch-start', 'tool/code-dispatch']);

function toolEvidence(event) {
  const data = event.data || {};
  const result = data.message?.content?.find((block) => block?.type === 'tool-result');
  const content = textBlocks(result?.content || data.content).map((block) => block.text).join('\n');
  const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments);
  return { type: event.type, seq: event.seq, data: {
    name: clip(data.name, 120), callId: clip(data.callId || data.subCallId || data.message?.source?.callId, 200),
    argumentsPreview: clip(args, 500), argumentsTruncated: typeof args === 'string' && args.length > 500,
    textPreview: content.slice(0, 1000), textTruncated: content.length > 1000,
    isError: result?.isError ?? data.isError,
    error: data.error ? { name: clip(data.error.name, 120), code: clip(data.error.code, 120) } : undefined,
  } };
}

function pendingInteractions(events) {
  const approvals = new Map(), questions = new Map();
  for (const event of events) {
    const data = event.data || {};
    if (event.type === 'approval/asked' && typeof data.id === 'string') {
      approvals.set(data.id, { id: clip(data.id, 200), seq: event.seq, toolName: clip(data.toolName, 120),
        callId: clip(data.callId, 200), reason: clip(data.reason, 1000) });
    } else if (event.type === 'approval/decided') approvals.delete(data.id);
    if ((event.type === 'tool/call' || event.type === 'tool/code-dispatch-start') && data.name === 'ask_user_question') {
      const callId = data.callId || data.subCallId;
      if (typeof callId !== 'string') continue;
      let args = data.arguments;
      try { if (typeof args === 'string') args = JSON.parse(args); } catch { args = undefined; }
      const items = Array.isArray(args?.questions) ? args.questions : [];
      questions.set(callId, { callId: clip(callId, 200), seq: event.seq, questions: items.slice(0, 3).map((item) => ({
        id: clip(item?.id, 120), question: clip(item?.question, 800), header: clip(item?.header, 80),
        multiSelect: item?.multi_select === true,
        options: (Array.isArray(item?.options) ? item.options : []).slice(0, 6).map((option) => ({
          label: clip(option?.label, 120), description: clip(option?.description, 240),
        })),
      })), questionsOmitted: Math.max(0, items.length - 3) });
    } else if (event.type === 'tool/result') questions.delete(data.message?.source?.callId);
    else if (event.type === 'tool/code-dispatch') questions.delete(data.subCallId);
  }
  return { pendingApprovals: [...approvals.values()].slice(0, 4), pendingQuestions: [...questions.values()].slice(0, 4),
    pendingApprovalCount: approvals.size, pendingQuestionCount: questions.size,
    waitingFor: [...(approvals.size ? ['approval'] : []), ...(questions.size ? ['user-question'] : [])],
    questionCoverage: 'Unsettled ask_user_question calls; other UI-only questions require DSH Web.' };
}

export function summarize(events, requestId) {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const user = ordered.find((e) => e.type === 'user/message' && e.data?.source?.kind === 'user' && e.data.source.rpcId === requestId);
  if (!user) return { state: 'awaiting-admission', requestId };
  // The official loop opens a turn before admitting user messages. Steering
  // and runtime context can add more user/message events within that same turn.
  const isBoundary = (e) => e.type === 'turn/start' || e.type === 'turn/end';
  const start = ordered.findLast((e) => e.seq < user.seq && isBoundary(e));
  if (start?.type !== 'turn/start' || !Number.isSafeInteger(start.data?.turn) || start.data.turn < 1) {
    return { state: 'unresolved-turn', requestId, detail: 'The admitted request has no valid open turn boundary.' };
  }
  const subsequent = ordered.filter((e) => e.seq > user.seq);
  const boundary = subsequent.find(isBoundary);
  if (boundary && (boundary.type !== 'turn/end' || boundary.data?.turn !== start.data.turn)) {
    return { state: 'unresolved-turn', requestId, turn: start.data.turn, detail: 'The request turn has conflicting or incomplete closing boundaries.' };
  }
  const end = boundary;
  const own = end ? subsequent.filter((e) => e.seq <= end.seq) : subsequent;
  const messages = own.filter((e) => e.type === 'assistant/message')
    .map((e) => ({ seq: e.seq, content: textBlocks(e.data?.message?.content), ...(e.data?.interrupted ? { interrupted: true } : {}) }))
    .filter((message) => message.content.length > 0);
  const tools = own.filter((e) => toolEventTypes.has(e.type));
  const reason = end?.data?.reason?.kind;
  const errorCode=end?.data?.reason?.error?.code;
  const code=typeof errorCode==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(errorCode) ? errorCode : 'TASK_ERROR';
  const turnEnd=end ? {turn:start.data.turn,reason:{kind:reason,...(end.data?.reason?.error ? {error:{code,message:rpcErrorMessage(code,undefined,{endpoint:'session turn'})}} : {})}} : undefined;
  return { state: end ? (typeof reason === 'string' && reason ? reason : 'unknown-terminal') : 'running', requestId, turn: start.data.turn, turnEnd,
    messages, toolEvents: tools.slice(-8).map(toolEvidence), toolEventsOmitted: Math.max(0, tools.length - 8),
    ...pendingInteractions(end ? [] : own),
    recentEventTypes: own.slice(-12).map((e) => e.type) };
}
