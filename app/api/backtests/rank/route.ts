import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest){
  let result;
  try{result=JSON.parse(await fs.readFile(path.join(process.cwd(),"data","backtests","rank-evaluation","latest.json"),"utf8"));}
  catch{return NextResponse.json({error:{code:"BACKTEST_RESULT_NOT_AVAILABLE",message:"저장된 순위 백테스트 결과가 없습니다."}},{status:404});}
  const model=request.nextUrl.searchParams.get("model"),horizon=request.nextUrl.searchParams.get("horizon"),evaluation=request.nextUrl.searchParams.get("evaluation");
  const select=(items: Array<Record<string, unknown>>)=>items.filter((item)=>(!model||item.modelVersion===model)&&(!horizon||item.horizon===horizon)&&(!evaluation||item.evaluation===evaluation));
  return NextResponse.json({...result,metrics:select(result.metrics??[]),commonComparisonMetrics:select(result.commonComparisonMetrics??[])},{headers:{"Cache-Control":"no-store"}});
}
