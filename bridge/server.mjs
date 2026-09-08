import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as service from './service.mjs';
import { configuredRoots, model as configuredModel } from './runtime.mjs';
import { isMain } from '../scripts/config.mjs';
import { localErrorMessage } from './sanitize.mjs';

/** Build the MCP server with all dsh_* tools registered. */
export function createServer() {
  const modelLine = configuredModel.reasoningEffort
    ? `${configuredModel.provider}/${configuredModel.model} (${configuredModel.reasoningEffort})`
    : `${configuredModel.provider}/${configuredModel.model}`;
  const rootsText = configuredRoots.length ? configuredRoots.join(', ') : '(none configured; delegation is disabled)';
  const server = new McpServer({ name: 'dsh-local', version: '1.0.0' }, { instructions:
    `Codex-led DSH collaboration on this local host. Call dsh_delegate with a unique taskId, an absolute project cwd below an allowed workspace root, bounded requirements and verification commands. DSH uses ${modelLine}. Keep one writer per workspace. Call dsh_wait in <=30-second intervals; use the same taskId and a unique operationId for dsh_followup. Never blindly retry ambiguous writes. A completed model turn is not proof of correct code: inspect files and independently test. Release workspace after verification. Pending approvals/questions must be handled in DSH Web; this bridge does not auto-approve them. Run dsh_host_status first to confirm the Host and the configured model route are ready.` });
  const taskId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
  const observation = {detail: z.enum(['full','summary']).default('full'), afterCursor: z.number().int().nonnegative().optional()};
  const register = (name, description, schema, fn, readOnly = false) => {
    server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: !readOnly } }, async (args) => {
      try { const result = await fn(args); return { content: [{ type: 'text', text: JSON.stringify(result) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: localErrorMessage(error) }] }; }
    });
  };
  register('dsh_host_status', 'Check authenticated local DSH connectivity, the configured model route, and configured workspace roots.', {}, () => service.hostStatus(), true);
  register('dsh_delegate', `Delegate bounded implementation to DSH. taskId is an idempotency key; retain it. Only projects below an allowed workspace root (${rootsText}) are allowed.`, { taskId, cwd: z.string(), prompt: z.string().min(1).max(50000) }, (args) => service.delegate(args));
  register('dsh_status', 'Read this request without resubmitting. Use detail=summary for polling; full for final evidence. afterCursor suppresses repeated progress text.', { taskId, ...observation }, (args) => service.status(args.taskId, 0, undefined, args), true);
  register('dsh_wait', 'Wait up to 30 seconds. Use detail=summary and previous afterCursor to reduce repeated evidence; terminal state remains request-correlated.', { taskId, ...observation, seconds: z.number().int().min(0).max(30).default(20) }, (args) => service.status(args.taskId, args.seconds, undefined, args), true);
  register('dsh_followup', 'Continue the same DSH session after its previous request ended. Reuse operationId only to inspect an ambiguous retry of identical work.', { taskId, operationId: taskId, prompt: z.string().min(1).max(50000) }, (args) => service.followup(args));
  register('dsh_cancel', 'Cancel the active turn; this does not remove pending inbox items or stop separate background jobs.', { taskId }, (args) => service.cancel(args.taskId));
  register('dsh_release_workspace', 'Release a completed idle task workspace after independent verification. The DSH session stays available.', { taskId }, (args) => service.release(args.taskId));
  return server;
}

if (isMain(import.meta.url)) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
