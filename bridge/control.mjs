import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { authHeaders, discardCachedAuth } from './client.mjs';
import { muxWebSocketUrl, loadDescriptors } from './runtime.mjs';
import { rpcErrorMessage } from './sanitize.mjs';

/**
 * Read the live Host-wide queue/jobs/control baseline. Read-only: on an HTTP
 * 401/403 handshake the cookie is refreshed once and the stream re-opened.
 */
export async function readControl() {
  const TYPERT_REMOTE = await loadDescriptors();
  const descriptor = TYPERT_REMOTE.descriptors.find((entry) => entry.namespace === 'session' && entry.method === 'control');
  if (!descriptor || descriptor.parameters.length) throw new Error('Unsupported control contract.');
  const run = async (retried) => {
    const headers = await authHeaders();
    return new Promise((resolve, reject) => {
      const streamId = randomUUID();
      let settled = false, handshakeStatus = null;
      const ws = new WebSocket(muxWebSocketUrl, { headers, followRedirects: false });
      const cleanup = () => clearTimeout(timer);
      const finish = (error, value) => {
        if (settled) return; settled = true;
        cleanup();
        if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'cancel', streamId })); ws.close(); }
        else ws.terminate();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Control baseline timed out.')), 15000);
      ws.on('unexpected-response', (request, response) => {
        if (settled) { response.resume(); return; }
        handshakeStatus=response.statusCode; response.resume();
        if (!retried && (handshakeStatus===401 || handshakeStatus===403)) {
          settled=true; cleanup(); ws.terminate(); discardCachedAuth();
          run(true).then(resolve,reject);
        } else finish(new Error('Control stream handshake refused after bounded authentication refresh.'));
      });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/control', payload: { args: {} } })));
      ws.on('error', () => {
        if (settled) return;
        finish(new Error('Control stream failed.'));
      });
      ws.on('close', () => { if (!settled) finish(new Error('Control stream closed before baseline.')); });
      ws.on('message', (data) => {
        if (settled) return;
        try {
          const frame = JSON.parse(data.toString());
          if (frame.streamId !== streamId) return;
          if (frame.type === 'error') throw new Error(rpcErrorMessage(frame.error?.code, frame.error?.message, { endpoint: 'session/control' }));
          if (frame.type === 'item') {
            const value = descriptor.result.schema.parse(frame.value);
            if (value.type === 'baseline') finish(null, value.value);
          }
        } catch (error) { finish(error); }
      });
    });
  };
  return run(false);
}

export function assertNoPendingWork(control, sessionId) {
  if ((control.queues[sessionId] || []).length) throw new Error('Session still has pending inbox messages.');
  if ((control.jobs[sessionId] || []).some((job) => ['running', 'stopping'].includes(job.status))) throw new Error('Session still has active background jobs.');
}
