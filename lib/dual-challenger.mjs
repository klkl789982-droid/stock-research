import {frame,mean,midranks,round} from "./dual-target-research.mjs";
export const factors=["5일 수익","시장 내 20일 상대강도","20일 변동성","상승일 빈도","20일 고점 대비","거래대금 근사","거래량 변화","5/20 신규 교차","소속시장 20일 흐름"];
const clip=(x,a,b)=>Math.min(b,Math.max(a,x));
export const logistic=z=>1/(1+Math.exp(-clip(z,-35,35)));
export function features(p,i){
 const f=frame(p,i),market=new Map(),assets=new Map(p.assets.map(a=>[a.code,a]));
 for(const r of f.rows){const v=market.get(r.market)??[0,0];v[0]+=r.raw[1];v[1]++;market.set(r.market,v);}
 for(const r of f.rows){const b=assets.get(r.code).bars.slice(i-20,i+1),m=market.get(r.market),marketReturn=m[0]/m[1];
 r.inputs=[r.raw[0],r.raw[1]-marketReturn,r.raw[2],r.raw[3],b.at(-1)[4]/Math.max(...b.slice(1).map(z=>z[2]))-1,
 Math.log(mean(b.slice(1).map(z=>z[4]*z[5]))),r.raw[5],r.raw[4],clip(marketReturn/.2,-1,1)];r.X=[1];}
 for(let j=0;j<7;j++){const rank=midranks(f.rows.map(r=>r.inputs[j]));f.rows.forEach((r,k)=>r.X.push(2*rank[k]-1));}
 for(const r of f.rows)r.X.push(r.inputs[7],r.inputs[8]);return f;
}
const dot=(a,b)=>a.reduce((s,v,j)=>s+v*b[j],0);
function solve(A,y){
 const a=A.map((r,i)=>[...r,y[i]]),n=y.length;
 for(let k=0;k<n;k++){let t=k;for(let j=k+1;j<n;j++)if(Math.abs(a[j][k])>Math.abs(a[t][k]))t=j;
 [a[t],a[k]]=[a[k],a[t]];const d=a[k][k];if(Math.abs(d)<1e-12)throw Error("SINGULAR");for(let j=k;j<=n;j++)a[k][j]/=d;
 for(let i=0;i<n;i++)if(i!==k){const v=a[i][k];for(let j=k;j<=n;j++)a[i][j]-=v*a[k][j];}}
 return a.map(r=>r[n]);
}
export function regress(days,isProb){
 const n=10,coef=Array(n).fill(0);const samples=days.map(d=>d.rows.filter(r=>Number.isFinite(r.y))).filter(x=>x.length);
 if(samples.length<10)throw Error("TOO_FEW_TRAIN_DATES");
 for(let iter=0;iter<(isProb?7:1);iter++){const G=Array.from({length:n},()=>Array(n).fill(0)),v=Array(n).fill(0);
 for(const rows of samples){const w=1/(samples.length*rows.length);for(const r of rows){const x=r.X,z=dot(coef,x),pred=isProb?logistic(z):z,err=(isProb?+(r.y>0):r.y)-pred;
 const h=w*(isProb?pred*(1-pred):1);for(let j=0;j<n;j++){v[j]+=w*err*x[j];for(let k=0;k<=j;k++)G[j][k]+=h*x[j]*x[k];}}}
 for(let j=0;j<n;j++){if(j){G[j][j]+=.02;v[j]-=.02*coef[j];}for(let k=0;k<j;k++)G[k][j]=G[j][k];}
 const step=solve(G,v);step.forEach((s,j)=>coef[j]+=s);if(Math.max(...step.map(Math.abs))<1e-8)break;}
 return coef;
}
export function trainChallengers(train){
 const cal=train.slice(-20),core=train.filter(d=>d.exitDate<cal[0].date);const R=regress(train,false),P=regress(core,true);
 let offset=0;for(let iter=0;iter<12;iter++){let g=0,k=0;for(const d of cal){const rows=d.rows.filter(r=>Number.isFinite(r.y));for(const r of rows){const v=logistic(dot(P,r.X)+offset);g+=(+(r.y>0)-v)/rows.length;k+=v*(1-v)/rows.length;}}
 if(!(k>0))throw Error("CALIBRATION_EMPTY");const delta=clip(g/k,-1,1);offset+=delta;if(Math.abs(delta)<1e-8)break;}
 return {R,P,offset,calibrationStart:cal[0].date,coreEnd:core.at(-1).exitDate,trainEnd:train.at(-1).exitDate};
}
export function estimate(model,r,target){const z=dot(model[target==="R"?"R":"P"],r.X);return target==="R"?z:logistic(z+(target==="P"?model.offset:0));}
export function challengerRanks(f,model,t){
 const z=f.rows.map(r=>estimate(model,r,t)),ranks=midranks(z);const rows=f.rows.map((r,i)=>{const k=model[t].slice(1).map((v,j)=>({j,c:v*r.X[j+1]})).sort((a,b)=>b.c-a.c);
 return {code:r.code,name:r.name,v:z[i],score:round(100*ranks[i]),reason:k.slice(0,2).map(({j})=>factors[j]).join(" · "),risk:r.x[2]>.8?"상대 고변동":"기업행사·체결 불확실"};}).sort((a,b)=>b.v-a.v||a.code.localeCompare(b.code));
 const tally=new Map();rows.forEach(r=>tally.set(r.v,(tally.get(r.v)??0)+1));let rank=1;
 return rows.map(({v,...r},i)=>{if(i&&rows[i-1].v!==v)rank=i+1;return {...r,rank,tied:tally.get(v)};});
}
