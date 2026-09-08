import {mkdir,writeFile,access} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {cases} from './cases.mjs';
const [id,root,taskId]=process.argv.slice(2);
if(!cases[id]||!isAbsolute(root||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(taskId||''))throw new Error('Usage: node prepare-dsh.mjs CASE ABS_RUN_ROOT UNIQUE_TASK_ID');
try{await access(root);throw new Error('Run directory already exists; use a fresh directory.');}catch(e){if(e.code!=='ENOENT')throw e;}
const cwd=join(root,'work');await mkdir(cwd,{recursive:true});await writeFile(join(cwd,'solution.mjs'),'');await writeFile(join(cwd,'visible-test.mjs'),cases[id].visible);
const prompt='Controlled case, baseline empty files (no Git). Implement only solution.mjs. Do not change visible-test.mjs or read outside the workspace. No delegation, network or background work. Run node visible-test.mjs once after implementation and report actual result. Stop on permission errors; do not weaken tests. Requirements: '+cases[id].specification;
await writeFile(join(root,'request.json'),JSON.stringify({taskId,cwd,prompt},null,2)+'\n');console.log(join(root,'request.json'));
