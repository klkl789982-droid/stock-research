import test from"node:test";import assert from"node:assert/strict";
import{createFixedBatchGroup}from"./batch-creation.mjs";
const group=Array.from({length:50},(_,i)=>({id:`synthetic-fixed-${i}`,params:{codes:["900000","900001","900002","900003"]}}));
test("lost create acknowledgement retries the exact immutable IDs without creating replacements",async()=>{
 const ids=new Set(),seen=[];let calls=0;
 const workflow={async createBatch({instances}){seen.push(instances.map(d=>d.id));const created=[],errors=[];
   instances.forEach((d,index)=>{if(ids.has(d.id))errors.push({index,code:10405});else{ids.add(d.id);created.push({id:d.id});}});
   if(++calls===1)throw Error("synthetic response dropped after creation");return{created,errors};}};
 await assert.rejects(createFixedBatchGroup(workflow,group),/UNCONFIRMED/);
 assert.deepEqual(await createFixedBatchGroup(workflow,group),{batches:50,symbols:200});
 assert.equal(ids.size,50);assert.deepEqual(seen[0],seen[1]);
});
test("partial, foreign, conflicting and nonduplicate errors fail closed",async()=>{
 for(const result of[{created:[],errors:[]},{created:[{id:"foreign"}],errors:[]},
  {created:[],errors:[{index:0,id:group[1].id,code:10405}]},{created:[],errors:[{index:0,code:10410}]}]){
  await assert.rejects(createFixedBatchGroup({createBatch:async()=>result},group),/UNCONFIRMED/);
 }
});
