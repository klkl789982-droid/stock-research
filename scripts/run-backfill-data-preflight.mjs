import { inspectSymbol, createPreflightClient } from "../lib/backfill-data-preflight.mjs";

if(!process.argv.includes("--dry-run"))throw new Error("이 진단기는 --dry-run에서만 실행할 수 있습니다.");
const serviceKey=process.env.DATA_GO_KR_SERVICE_KEY;if(!serviceKey)throw new Error("DATA_GO_KR_SERVICE_KEY가 없습니다.");
const endpoint="https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";
const symbols=[
  {code:"005930",name:"삼성전자",category:"longListed"},{code:"000660",name:"SK하이닉스",category:"longListed"},{code:"005380",name:"현대차",category:"longListed"},{code:"035420",name:"NAVER",category:"longListed"},{code:"051910",name:"LG화학",category:"longListed"},
  {code:"0126Z0",name:"삼성에피스홀딩스",category:"mixedCode"},{code:"0009K0",name:"에임드바이오",category:"mixedCode"},{code:"0039P0",name:"매드업",category:"shortHistory"},{code:"475040",name:"스트라드비젼",category:"shortHistory"}
];
if(symbols.length>10)throw new Error("PREFLIGHT_SYMBOL_LIMIT_EXCEEDED");
const option=(name)=>process.argv.find((value)=>value.startsWith(`--${name}=`))?.split("=")[1];
const offset=Number(option("offset")??0),limit=Number(option("limit")??symbols.length);
if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>10)throw new Error("offset/limit이 유효하지 않습니다.");
const selectedSymbols=symbols.slice(offset,offset+limit);
const client=createPreflightClient({fetchImpl:fetch,serviceKey,endpoint,maxRequests:30,intervalMs:150});
const results=[];let stoppedReason=null;
for(const symbol of selectedSymbols){try{results.push(await inspectSymbol(client,symbol));}catch(error){const stop=error.name==="RateLimitStopError"?"HTTP_429":error.name==="AuthenticationStopError"?`HTTP_${error.status}`:null;results.push({...symbol,error:stop??error.message});if(stop){stoppedReason=stop;break;}}}
const safe=results.map((item)=>{const copy={...item};delete copy.dates;return copy;});
console.log(JSON.stringify({mode:"dry-run",source:"data.go.kr/GetStockPriceInfo",requestCount:client.getRequestCount(),requestLimit:30,symbolLimit:10,rawResponseStored:false,stoppedReason,results:safe},null,2));
