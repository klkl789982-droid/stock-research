"use client";

import { useEffect, useState } from "react";

type Choice = { date: string; model: string; horizon: string; topN: number; selected: number; mature: number; pending: number; missing: number };
type Timing = { signalDate: string; generatedAt: string | null; confirmedBy: string; firstKnownRegularOpen: string | null; plannedEntryDate: string | null };
type Stats = { dates: number; observations: number; mean: number | null; excess: number | null; total: number | null; drawdown: number | null };
type TaxPair = { dates: number; unsupportedDates: number; unsupportedMatureLegs: number; immatureOrMissingDates: number;
  meanExcluding: number | null; meanIncluding: number | null; totalIncluding: number | null; drawdownIncluding: number | null };
type Inventory = { choices: Choice[]; confirmedDates: Timing[]; study: { from: string; to: string; topN: number;
  sellTax?: (TaxPair & { version: string; lineage: string })[];
  candidates: { version: string; baselineVersion: string; lineage: string; holdingDays: number; baseline: Stats; candidate: Stats }[]; unavailablePrimaryVersions: string[] } };
type Cohort = { id: string; signalDates: string[]; formulaHash: string; universeCount: number; matureDates: number; mature: number; pending: number; missing: number;
  distinctStocks: number; repeats: number; stockMean: number | null; basketMean: number | null; scenarioMean: number | null; benchmarkDates: number; grossExcess: number | null;
  taxComparison?: TaxPair | null; account: { status: string; total: number | null; maxDrawdown: number | null; exposure: number | null; buys: number | null } };
type Report = { cohorts: Cohort[]; confirmedDates: Timing[] };
const versions = ["A-v1", "A-v2", "B-v1", "C-v1", "D-v1"];
const days = [1, 5, 20], depths = [5, 10, 20];
const isModel = (row: Choice, model: string, topN: number) => row.model === model && row.topN === topN;
const select = "block mt-1 w-full min-w-0 rounded-md border border-[var(--tb-border)] bg-white px-2 py-2 text-sm text-slate-900";
const dateText = (stamp: string | null) => stamp ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(stamp)) : "미확인";
const percent = (v: number | null, unit = "%") => v == null ? "자료 부족" : `${v > 0 ? "+" : ""}${v.toFixed(2)}${unit}`;
function Values({ items }: { items: [string, string][] }) {
  return <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">{items.map(([label, value]) =>
    <div key={label} className="min-w-0"><dt className="text-xs text-slate-600">{label}</dt><dd className="font-semibold tabular-nums text-slate-900">{value}</dd></div>)}</dl>;
}
async function getResearch(query: string, signal: AbortSignal) {
  const response = await fetch(`/api/model-performance/research?${query}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error("research unavailable");
  return response.json();
}

function TaxResult({ label, pair }: { label?: string; pair: TaxPair }) {
  return <div className="mt-2 text-xs text-slate-700">
    <p><strong>{label ? label+" · " : ""}매도세 비교</strong> · 성숙 신호 {pair.dates}일
      {pair.unsupportedDates > 0 && ` · 세율 미확인 ${pair.unsupportedMatureLegs}건이 있는 ${pair.unsupportedDates}일은 비교 제외`}
      {pair.immatureOrMissingDates > 0 && ` · 미성숙·자료 부족 ${pair.immatureOrMissingDates}일`}</p>
    {pair.dates > 0 && <p>동일 신호일 평균 · 매도세 제외 {percent(pair.meanExcluding)} / 포함 {percent(pair.meanIncluding)} · 세금 포함 가상 계좌 누적 {percent(pair.totalIncluding)} / 최대낙폭 {percent(pair.drawdownIncluding)}</p>}
  </div>;
}

function TaxBasis() {
  return <details className="mt-2 text-xs text-slate-600"><summary className="cursor-pointer">매도세 적용 범위와 근거</summary>
    <p>2026년 국내 보통주 장내 매도, 비과세·면제가 없는 일반 투자자 가정입니다. 슬리피지 적용 후 매도대금에 코스피는 증권거래세 0.05%와 농어촌특별세 0.15%, 코스닥은 증권거래세 0.20%를 적용합니다. 거래 당시 저장된 종목 마스터에서 확인 가능한 상품만 비교합니다. 개인별 양도소득세는 포함하지 않습니다.</p>
    <p><a className="underline" href="https://www.law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=00&joNo=0005&lsiSeq=280901&urlMode=lsScJoRltInfoR">증권거래세법 시행령 제5조</a> · <a className="underline" href="https://www.law.go.kr/LSW/lsLinkCommonInfo.do?lsJoLnkSeq=1031850577">농어촌특별세법 제5조</a></p>
  </details>;
}

export default function BacktestPanel() {
  const [tab, setTab] = useState("published"), [inventory, setInventory] = useState<Inventory | null>(null);
  const [reload, setReload] = useState(0), [inventoryError, setInventoryError] = useState(false);
  const [model, setModel] = useState("B-v1"), [topN, setTopN] = useState(10), [horizon, setHorizon] = useState(1);
  const [from, setFrom] = useState(""), [to, setTo] = useState(""), [cost, setCost] = useState(false);
  const [request, setRequest] = useState<{ key: string } | null>(null), [result, setResult] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getResearch("view=backtest-options", controller.signal).then((v: Inventory) => {
      if (!controller.signal.aborted) { setInventory(v); setInventoryError(false); }
    }).catch(() => { if (!controller.signal.aborted) setInventoryError(true); });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    getResearch(request.key, controller.signal).then((v: Report) => {
      if (!controller.signal.aborted) setResult(v);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [request]);

  const dates = [...new Set(inventory?.choices.map(c => c.date))].sort();
  const rows = (inventory?.choices ?? []).filter(c => (!from || c.date >= from) && (!to || c.date <= to));
  const matches = rows.filter(c => isModel(c, model, topN) && c.horizon === "H" + horizon);
  const sum = (key: "mature" | "pending" | "missing") => matches.reduce((n,c) => n + c[key], 0);
  const eligible = sum("mature") > 0;
  const params = new URLSearchParams({ view: "backtest", classification: "PUBLISHED_PRICE_OBSERVATION", models: model, topN: String(topN),
    horizon: "H" + horizon, benchmark: "MATCHED_MARKET", costMode: cost ? "USER_INPUT" : "GROSS_ONLY" });
  if (from) params.set("from",from);
  if (to) params.set("to",to);
  if (cost) for (const [key, value] of Object.entries({ buyFeeBps: "2", sellFeeBps: "2", buySlippageBps: "5", sellSlippageBps: "5", sellTaxBps: "0",
    basis: "편도 수수료 2bp·슬리피지 5bp 연구 가정, 매도세 미포함", basisDate: "2026-11-03" })) params.set(key,value);
  const key = params.toString(), showResult = request?.key === key;
  const retry = () => { setResult(null); setFailed(false); setRequest({key}); };

  return <section className="tb-card min-w-0 p-4 sm:p-6" aria-labelledby="backtest-heading">
    <h2 id="backtest-heading" className="tb-page-title">백테스트</h2>
    <div className="tb-segmented mt-4" role="tablist" aria-label="백테스트 자료">
      {([["published","게시 종목 가상매매"],["study","연구 후보 비교"]] as const).map(([id,label]) =>
        <button type="button" key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
          className="tb-focus">{label}</button>)}
    </div>
    {inventoryError ? <p role="alert" className="mt-4 text-sm">평가 가능 범위를 조회하지 못했습니다. <button type="button" onClick={() => { setInventoryError(false); setReload(v=>v+1); }} className="tb-focus underline">다시 조회</button></p> :
      !inventory ? <p role="status" className="mt-4 text-sm">저장된 신호와 가격을 확인하고 있습니다.</p> :
      tab === "study" ? <div className="space-y-3 pt-4">
        <h3 className="font-semibold">사후 연구 · {inventory.study.from} ~ {inventory.study.to}</h3>
        <p className="text-sm text-slate-600">이미 검토한 구간의 TOP{inventory.study.topN}입니다. 수수료·슬리피지는 편도 7bp로 가정했고 매도 세금은 제외했습니다.</p>
        {inventory.study.candidates.map(c=><div className="border-t border-[var(--tb-border)] pt-3" key={c.version}>
          <p className="font-semibold">{c.baselineVersion} → {c.version} <span className="text-xs font-normal text-slate-600">연구 전용 · {c.holdingDays}거래일 · 성숙 신호 {c.candidate.dates}일</span></p>
          <Values items={[["신호일 평균 · 세전 가정",`${percent(c.baseline.mean)} → ${percent(c.candidate.mean)}`],["지수 대비 · 세전 가정",`${percent(c.baseline.excess,"%p")} → ${percent(c.candidate.excess,"%p")}`],["가상 계좌 누적",`${percent(c.baseline.total)} → ${percent(c.candidate.total)}`],["계좌 최대낙폭",`${percent(c.baseline.drawdown)} → ${percent(c.candidate.drawdown)}`]]}/>
          {inventory.study.sellTax?.filter(p=>p.lineage===c.lineage && (p.version===c.version || p.version===c.baselineVersion)).map(p=><TaxResult key={p.version} label={p.version} pair={p}/>)}
        </div>)}
        <TaxBasis/>
        <p className="text-xs text-slate-600">{inventory.study.unavailablePrimaryVersions.join(" · ")} 주평가 기간 자료 부족. D 최솟값은 연구 전용입니다. 11월 4일부터 서로 다른 신규 신호일 60개를 모아 5거래일 청산이 확인된 뒤 D-v1과 비교합니다. 같은 날의 선정 10종목은 신호일 1개로 세며, 미성숙 결과는 집계에서 제외합니다.</p>
      </div> : <>
        <p className="mt-4 text-sm text-slate-600">실제 게시된 Daily EOD 순위에서 고릅니다. 게시 확인 후 T+2 공식 시가에 매수하고, 진입일을 포함한 보유기간의 마지막 종가에 청산한다고 가정합니다.</p>
        <form className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" onSubmit={e=>{e.preventDefault(); if (eligible) retry();}}>
          <label className="text-xs">모델·버전<select className={select} value={model} onChange={e=>setModel(e.target.value)}>{versions.map(v=><option key={v} value={v} disabled={!rows.some(r=>r.model===v&&r.mature>0)}>{v}{v === "A-v2" ? " · 게시 병행 버전" : ""}</option>)}</select></label>
          <label className="text-xs">선정 순위<select className={select} value={topN} onChange={e=>setTopN(+e.target.value)}>{depths.map(n=><option key={n} value={n} disabled={!rows.some(r=>isModel(r,model,n)&&r.mature>0)}>TOP{n}</option>)}</select></label>
          <label className="text-xs">보유 기간<select className={select} value={horizon} onChange={e=>setHorizon(+e.target.value)}>{days.map(n=>{
            const period = rows.filter(r => isModel(r,model,topN) && r.horizon === "H"+n);
            const ready = period.some(r => r.mature > 0);
            const reason = period.some(r => r.pending > 0) ? "보유기간 미성숙" : period.length ? "가격·검증 자료 부족" : "조건 충족 0건";
            return <option key={n} value={n} disabled={!ready}>{n}거래일{ready ? "" : " · "+reason}</option>;})}</select></label>
          <label className="text-xs">첫 신호일<select className={select} value={from} onChange={e=>setFrom(e.target.value)}><option value="">처음부터</option>{dates.filter(d=>!to||d<=to).map(d=><option key={d}>{d}</option>)}</select></label>
          <label className="text-xs">마지막 신호일<select className={select} value={to} onChange={e=>setTo(e.target.value)}><option value="">최근까지</option>{dates.filter(d=>!from||d>=from).map(d=><option key={d}>{d}</option>)}</select></label>
          <label className="text-xs">비용 가정<select className={select} value={cost?"stress":"gross"} onChange={e=>setCost(e.target.value==="stress")}><option value="gross">비용 전</option><option value="stress">편도 7bp · 매도세 포함/제외 비교</option></select></label>
          <p className="col-span-2 self-center text-xs text-slate-600 sm:col-span-3 lg:col-span-5" role="status">게시 신호 {new Set(matches.map(r=>r.date)).size}일 · 성숙 {sum("mature")}건 · 대기 {sum("pending")}건 · 자료 부족 {sum("missing")}건</p>
          <button className="tb-primary-button px-4 py-2 text-sm disabled:opacity-50" disabled={!eligible || (showResult&&!failed&&!result)}>계산하기</button>
        </form>
        {!eligible && <p className="mt-3 text-sm text-slate-700">{!matches.length ? "조건을 충족한 게시 신호가 없습니다." : sum("pending") ? "보유기간이 아직 끝나지 않은 관측이 있어 계산할 성숙 표본이 없습니다." : "진입·청산 가격 또는 검증 자료가 부족합니다."}</p>}
        {eligible && showResult && (failed ? <p role="alert" className="mt-4 text-sm text-red-700">연구 자료를 조회하지 못했습니다. 다시 계산해 주세요.</p> : !result ? <p role="status" className="mt-4 text-sm">가상매매 계산 중…</p> :
          <div className="mt-4 space-y-3" aria-label="백테스트 계산 결과">
            {!result.cohorts.length && <p className="text-sm">조건을 충족한 종목이 없습니다.</p>}
            {result.cohorts.length > 1 && <p className="text-xs text-slate-600">공식 또는 순위 대상 종목이 다른 신호일은 별도 계좌로 표시합니다.</p>}
            {result.cohorts.map(c=><section key={c.id} className="border-t border-[var(--tb-border)] pt-3">
              <h3 className="font-semibold">{model} · TOP{topN} · {horizon}거래일</h3>
              <p className="text-xs text-slate-600">{c.signalDates[0]} ~ {c.signalDates.at(-1)} · 당시 순위 대상 {c.universeCount}종목</p>
              <Values items={[["종목 관측 평균 · 비용 전",percent(c.stockMean)],["신호일 동일가중 평균 · 비용 전",percent(c.basketMean)],["시장지수 대비 · 비용 전",c.benchmarkDates ? percent(c.grossExcess,"%p") : "지수 자료 부족"],...(cost ? [["신호일 평균 · 세금 제외",percent(c.scenarioMean)] as [string,string]] : [])]}/>
              <p className="mt-2 text-xs text-slate-600">성숙 {c.mature}건 · 서로 다른 종목 {c.distinctStocks}개 · 반복 관측 {c.repeats}건 · 전체 선정이 성숙한 신호일 {c.matureDates}일 · 지수 비교 {c.benchmarkDates}일</p>
              {cost && c.taxComparison && <TaxResult pair={c.taxComparison}/>}
              <h4 className="mt-3 text-sm font-semibold">현금 한도 가상 계좌 · {cost ? "수수료·슬리피지 가정, 세금 제외" : "거래비용 전체 미포함"}</h4>
              {c.account.status==="VALUED" ? <Values items={[["계좌 누적",percent(c.account.total)],["최대낙폭",percent(c.account.maxDrawdown)],["평균 시장 노출",percent(c.account.exposure)],["매수 건수",String(c.account.buys)]]}/> :
                <p className="mt-1 text-xs text-slate-600">연속 가격 또는 실행 가능한 진입 자료가 부족하여 계좌 성과를 계산할 수 없습니다.</p>}
            </section>)}
          </div>)}
        <details className="mt-4 border-t border-[var(--tb-border)] pt-2 text-xs text-slate-600"><summary className="cursor-pointer font-semibold">체결·비용·자금 배분 기준</summary>
          <p className="mt-2">초기 현금 1억원, 차입·공매도 없이 정수 주로 동일 배분합니다. 매일 전일 자산의 1/보유일수 이내에서 투자하고, 보유 중 재선정은 추가 매수하지 않습니다. 당일 종가 매도대금은 다음 거래일부터 사용합니다.</p>
          <p className="mt-1">비용 전은 수수료·슬리피지·매도세 모두 미포함입니다. 편도 7bp는 수수료 2bp와 슬리피지 5bp의 연구 가정입니다. 실제 주문 체결과 배당·기업행사에 따른 보유수량 조정은 확인되지 않았습니다.</p>
          <TaxBasis/>
          <p className="mt-1">T+2는 일봉 거래일 순서로 고정한 진입 가정입니다. 실제 주문 가능 최초 시각은 확인되지 않았습니다. 보유 구간이 겹칠 수 있어 신호일 평균을 연속 복리로 합치지 않습니다.</p>
          {showResult && result?.confirmedDates.map(t=><p className="mt-1" key={t.signalDate}>{t.signalDate} 신호 · 계산 {dateText(t.generatedAt)} · 사이트 확인 {dateText(t.confirmedBy)} KST · 확인 후 첫 정규 시가 {t.firstKnownRegularOpen??"자료 부족"} · 연구 진입 {t.plannedEntryDate??"대기"}</p>)}
        </details>
      </>}
  </section>;
}
