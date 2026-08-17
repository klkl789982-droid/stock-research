import fs from "node:fs/promises";
import path from "node:path";

export async function saveRankBacktest(result,{root=process.cwd(),hooks={}}={}){
  const base=path.join(root,"data","backtests","rank-evaluation"),runs=path.join(base,"runs"),latest=path.join(base,"latest.json"),lock=`${latest}.lock`,tmp=`${latest}.tmp`,backup=`${latest}.bak`;
  await fs.mkdir(runs,{recursive:true});
  let handle;
  try{
    handle=await fs.open(lock,"wx");
    const payload=`${JSON.stringify(result,null,2)}\n`,safe=result.generatedAt.replaceAll(":","-");
    const run=path.join(runs,`${safe}.json`);
    await fs.writeFile(run,payload,{flag:"wx"});
    let hadLatest=false;
    try{await fs.copyFile(latest,backup);hadLatest=true;}catch(error){if(error.code!=="ENOENT")throw error;}
    await fs.writeFile(tmp,payload);
    await hooks.beforeRename?.();
    await fs.rename(tmp,latest);
    if(hadLatest)await fs.rm(backup,{force:true});
    return {latest,run};
  }catch(error){
    await fs.rm(tmp,{force:true}).catch(()=>{});
    try{await fs.access(backup);await fs.copyFile(backup,latest);await fs.rm(backup,{force:true});}catch{}
    throw error;
  }finally{
    await handle?.close();
    await fs.rm(lock,{force:true}).catch(()=>{});
  }
}
