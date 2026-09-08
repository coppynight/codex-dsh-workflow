import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root=resolve('.local-runs/dsh-led/mcp-probe-01');await mkdir(root,{recursive:true});
const cwd=resolve('.local-runs/dsh-led/native-probe-01/work');
const configFile=join(root,'config.json');
await writeFile(configFile,JSON.stringify({cwd,task:'Technical probe of a text-only expert adapter, not a task-performance benchmark.',ledgerDir:join(root,'ledger'),maxConsults:1}),{flag:'wx'});
const client=new Client({name:'advisor-capability-probe',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('prototype/consult-mcp.mjs'),configFile],stderr:'pipe'});
try {
 await client.connect(transport);
 const listed=await client.listTools();
 const args={consultationId:'probe-one',question:'A paid API request timed out after submission. Should a budget reservation be released immediately? Explain in at most 80 words.',context:'Submission response was lost. Execution status is unknown. This is a reasoning-only adapter probe; do not use tools.'};
 const first=await client.callTool({name:'consult_astra',arguments:args});
 const repeated=await client.callTool({name:'consult_astra',arguments:args});
 const denied=await client.callTool({name:'consult_astra',arguments:{...args,consultationId:'probe-two'}});
 const record={probeOnly:true,tools:listed.tools.map(t=>t.name),first,repeated,denied};
 await writeFile(join(root,'result.json'),JSON.stringify(record,null,2));
 console.log(JSON.stringify(record));
} finally { await client.close(); }
