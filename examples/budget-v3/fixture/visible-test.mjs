import assert from 'node:assert/strict';
import {parseJobs} from './parse.mjs';
import {summarizeJobs} from './aggregate.mjs';
const input=[{id:'a',durationMs:4,status:'succeeded'},{id:'b',durationMs:8,status:'failed'},{id:'c',durationMs:99,status:'skipped'}].map(x=>JSON.stringify(x)).join('\n');
const {jobs,errors}=parseJobs(input);
assert.deepEqual(errors,[]);
assert.equal(summarizeJobs(jobs).durationMs,12);
assert.equal(summarizeJobs(jobs).medianSuccessMs,4);
console.log('3 visible assertions passed');
