import {call,observe} from './client.mjs';
const catalog=await call('modelCatalog');
console.log(JSON.stringify({default:catalog.default,routableProviders:catalog.routableProviders,models:catalog.groups.map(g=>({id:g.id,models:g.models.map(m=>m.id)})),failures:catalog.failures},null,2));
if(process.argv[2]) { const r=await observe(process.argv[2]);console.log(JSON.stringify(r,null,2)); }
