// A lost/partial control response is not authority to issue replacement IDs.
// The Workflow step may repeat this exact group at most twice. Existing IDs
// are affirmative acknowledgement, never another market observation.
export async function createFixedBatchGroup(workflow,group){
  const fail=()=>{throw Error("LIVE_CLOUD_BATCH_CREATE_UNCONFIRMED");};
  if(!Array.isArray(group)||group.length<1||group.length>50||new Set(group.map(d=>d.id)).size!==group.length)fail();
  let result;try{result=await workflow.createBatch({instances:group});}catch{fail();}
  if(!Array.isArray(result?.created)||!Array.isArray(result?.errors))fail();
  const expected=new Set(group.map(d=>d.id)),known=new Set();
  for(const row of result.created){if(!expected.has(row.id)||known.has(row.id))fail();known.add(row.id);}
  for(const error of result.errors){
    const indexed=Number.isSafeInteger(error.index)&&error.index>=0&&error.index<group.length?group[error.index].id:null;
    const id=error.id??indexed;
    if(error.code!==10405||!expected.has(id)||indexed&&indexed!==id||known.has(id))fail();known.add(id);
  }
  if(known.size!==group.length)fail();
  return{batches:group.length,symbols:group.reduce((n,d)=>n+d.params.codes.length,0)};
}
