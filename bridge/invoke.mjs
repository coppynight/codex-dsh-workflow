import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain, configPath } from '../scripts/config.mjs';

/** Entry path of the MCP server, always resolved relative to this module. */
export function serverModulePath() {
  return join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');
}

if (isMain(import.meta.url)) {
  const [tool, inputFile] = process.argv.slice(2);
  const client = new Client({ name: 'workflow-verification', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverModulePath()], env: process.env.WORKFLOW_CONFIG ? { WORKFLOW_CONFIG: configPath() } : {}, stderr: 'inherit' });
  try {
    await client.connect(transport);
    const result = tool === 'list'
      ? await client.listTools()
      : await client.callTool({ name: tool, arguments: inputFile ? JSON.parse((await readFile(inputFile, 'utf8')).replace(/^\uFEFF/, '')) : {} });
    console.log(JSON.stringify(result, null, 2));
    if (result.isError) process.exitCode = 1;
  } finally {
    await client.close();
  }
}
