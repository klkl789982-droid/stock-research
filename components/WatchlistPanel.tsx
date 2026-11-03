"use client";

import { useEffect, useRef, useState } from "react";
import { toTopIntradayOverlay } from "../lib/top-stocks-intraday-overlay.mjs";

type Stock = { code: string; name: string; market: string };
type Model = { score: number | null; rank: number | null };
type Item = Stock & { date: string | null; close: number | null; closeChangePct: number | null; models: Record<string, Model> | null };
type Quote = { status: "available"; price: number; rate: number | null; at: string } | { status: "loading" | "unverified" | "error" };
const button = "tb-focus min-h-10 rounded-md border border-[var(--tb-border)] px-3 py-1.5 text-sm font-medium text-slate-700 disabled:opacity-50";
const rate = (value: number | null) => value === null ? "등락률 미확인" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const price = (value: number) => `${value.toLocaleString("ko-KR")}원`;

function WatchlistQuote({ item }: { item: Item }) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const controller = useRef<AbortController | null>(null);
  const lastQuery = useRef(0);
  useEffect(() => () => controller.current?.abort(), []);
  async function checkQuote() {
    if (document.hidden || controller.current || Date.now() - lastQuery.current < 5_000) return;
    const request = new AbortController();
    controller.current = request;
    lastQuery.current = Date.now();
    setQuote({ status: "loading" });
    try {
      const res = await fetch(`/api/realtime?code=${item.code}`, { cache: "no-store", signal: request.signal });
      if (!res.ok) throw new Error();
      const data = toTopIntradayOverlay(item.code, await res.json());
      if (!request.signal.aborted) setQuote(data.status === "available" && data.price != null
        ? { status: "available", price: data.price, rate: data.rate ?? null, at: `${data.asOfDate} ${data.asOfTime} KST` }
        : { status: "unverified" });
    } catch { if (!request.signal.aborted) setQuote({ status: "error" }); }
    finally { if (controller.current === request) controller.current = null; }
  }
  return <div className="min-w-0">
    <p className="text-sm font-medium text-slate-900">{item.close !== null ? price(item.close) : "종가 미확인"}
      <span className="ml-2 text-xs font-normal text-slate-600">{item.closeChangePct === null ? "등락률 미확인" : `직전 종가 대비 ${rate(item.closeChangePct)}`}</span></p>
    {item.date && <p className="text-xs text-slate-500">{item.date} 공식 일봉 종가</p>}
    <button type="button" className="tb-focus mt-1 min-h-9 rounded text-left text-xs font-semibold text-[var(--tb-blue)] disabled:text-slate-500"
      onClick={checkQuote} disabled={quote?.status === "loading"} aria-label={`${item.name} 최근 체결가 조회`}>{quote?.status === "loading" ? "시세 조회 중…" : "최근 체결가 조회"}</button>
    <div role="status" className="text-xs text-slate-600">
      {quote?.status === "available" && <p><strong>{price(quote.price)}</strong> · {rate(quote.rate)}<br/>KIS {quote.at}</p>}
      {quote?.status === "unverified" && "기준 시각이 확인된 최근 체결가가 없습니다."}
      {quote?.status === "error" && "최근 시세 조회에 실패했습니다."}
    </div>
  </div>;
}

export default function WatchlistPanel({ onSelectStock, initialQuery = "" }: {
  onSelectStock: (stock: Stock) => void | Promise<void>; initialQuery?: string;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [listStatus, setListStatus] = useState<"loading" | "ready" | "error">("loading");
  const [marketAvailable, setMarketAvailable] = useState(true);
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState(initialQuery);
  const [search, setSearch] = useState<{ query: string } | null>(initialQuery ? { query: initialQuery } : null);
  const [matches, setMatches] = useState<Stock[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const saved = new Set(items.map(row => row.code));

  useEffect(() => {
    const request = new AbortController();
    (async () => {
      setListStatus("loading");
      try {
        const res = await fetch("/api/watchlist", { cache: "no-store", signal: request.signal });
        if (!res.ok) throw new Error();
        const result = await res.json();
        if (!request.signal.aborted) { setItems(result.items); setMarketAvailable(result.marketAvailable); setListStatus("ready"); }
      } catch { if (!request.signal.aborted) setListStatus("error"); }
    })();
    return () => request.abort();
  }, [version]);

  useEffect(() => {
    if (!search) return;
    const request = new AbortController();
    (async () => {
      setSearchStatus("loading");
      setMatches([]);
      try {
        const res = await fetch(`/api/watchlist?search=${encodeURIComponent(search.query)}`, { cache: "no-store", signal: request.signal });
        if (!res.ok) throw new Error();
        const result = await res.json();
        if (!request.signal.aborted) { setMatches(result.candidates); setSearchStatus("ready"); }
      } catch { if (!request.signal.aborted) setSearchStatus("error"); }
    })();
    return () => request.abort();
  }, [search]);

  async function update(row: Stock, method: "PUT" | "DELETE") {
    if (busy || listStatus !== "ready") return;
    setBusy(true); setMessage("");
    try {
      const res = await fetch("/api/watchlist", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: row.code }) });
      if (res.status === 409) { setMessage("관심종목은 최대 50개까지 저장할 수 있습니다."); return; }
      if (!res.ok) throw new Error();
      setMessage(`${row.name} · ${method === "PUT" ? "추가했습니다." : "삭제했습니다."}`);
      setVersion(v => v + 1);
    } catch { setMessage("저장 여부를 확인하지 못했습니다. 목록을 새로 확인해 주세요."); setVersion(v => v + 1); }
    finally { setBusy(false); }
  }

  return <section className="tb-card min-w-0 p-4 sm:p-6" aria-labelledby="watchlist-title">
    <h1 id="watchlist-title" className="text-xl font-bold text-slate-950 sm:text-2xl">관심종목</h1>
    <form className="mt-4 flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if (query.trim()) { setSearch({ query: query.trim() }); setMessage(""); } }}>
      <label className="sr-only" htmlFor="watchlist-search">관심종목 검색</label>
      <input id="watchlist-search" className="tb-focus min-w-0 flex-1 rounded-md border border-[var(--tb-border)] px-3 py-2 text-sm sm:max-w-sm"
        maxLength={64} placeholder="분석 대상 종목명 또는 코드" value={query} onChange={e => { setQuery(e.target.value); setSearch(null); setSearchStatus("idle"); setMatches([]); }} />
      <button className={button} type="submit" disabled={!query.trim()}>종목 찾기</button>
    </form>
    <div aria-live="polite" className="mt-2 text-sm text-slate-600">
      {searchStatus === "loading" && "종목 검색 중…"}
      {searchStatus === "error" && "종목을 검색하지 못했습니다. 다시 시도해 주세요."}
      {searchStatus === "ready" && !matches.length && "분석 대상에서 해당 종목을 찾을 수 없습니다."}
    </div>
    {matches.length > 0 && <ul aria-label="검색된 종목" className="mt-2 max-w-lg divide-y divide-slate-200">
      {matches.map(row => <li key={row.code} className="flex items-center justify-between gap-2 py-1.5">
        <span className="min-w-0 break-words text-sm">{row.name} <small className="text-slate-600">{row.code}</small></span>
        <button className={button} type="button" disabled={busy || listStatus !== "ready" || saved.has(row.code)} aria-label={`${row.name} 관심종목 추가`}
          onClick={() => void update(row, "PUT")}>{saved.has(row.code) ? "저장됨" : "추가"}</button>
      </li>)}</ul>}
    <div className="mt-5 flex items-center justify-between border-b border-slate-200 pb-2">
      <h2 className="text-base font-semibold">내 목록{listStatus === "ready" && ` · ${items.length}종목`}</h2>
      <button type="button" className={button} onClick={() => setVersion(v => v + 1)} disabled={busy || listStatus === "loading"}>목록 새로고침</button>
    </div>
    <div className="mt-2 text-sm text-slate-600" role="status">
      {message && <p>{message}</p>}
      {listStatus === "loading" ? "목록 확인 중…" : listStatus === "error" ? "저장된 목록을 불러오지 못했습니다. 다시 시도해 주세요." :
        !items.length ? "저장된 관심종목이 없습니다." : !marketAvailable ? "종목 목록은 확인했지만 일봉 자료를 불러오지 못했습니다." : ""}
    </div>
    {listStatus === "ready" && <ul aria-label="저장된 관심종목" className="divide-y divide-slate-200">{items.map(row =>
      <li key={row.code} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 py-3 sm:grid-cols-[minmax(9rem,1fr)_minmax(12rem,1.3fr)_minmax(7rem,1fr)_auto]">
        <button className="tb-focus min-w-0 break-words text-left font-semibold text-[var(--tb-blue)]" type="button" aria-label={`${row.name} 종목 상세`} onClick={() => void onSelectStock(row)}>
          {row.name}<small className="block text-xs font-normal text-slate-600">{row.code} · {row.market}</small></button>
        <div className="col-start-1 row-start-2 sm:col-start-2 sm:row-start-1"><WatchlistQuote item={row} /></div>
        <details className="col-start-1 min-w-0 text-xs text-slate-600 sm:col-start-3 sm:row-start-1"><summary className="tb-focus cursor-pointer py-1">
          {row.models?.["B-v1"]?.rank != null ? `일봉 B · ${row.models["B-v1"].rank}위` : "일봉 모델"}</summary>
          {row.models && Object.values(row.models).some(m => m.rank !== null && m.score !== null)
            ? <ul className="mt-1">{Object.entries(row.models).map(([name, m]) => <li key={name}>{name} · {m.score !== null && m.rank !== null ? `${m.score.toFixed(2)}점 · ${m.rank}위` : "분석 자료 없음"}</li>)}</ul> : <p>분석 자료 없음</p>}
        </details>
        <button className={button + " col-start-2 row-start-1 sm:col-start-4"} type="button" disabled={busy} aria-label={`${row.name} 관심종목 삭제`} onClick={() => void update(row, "DELETE")}>삭제</button>
      </li>)}</ul>}
  </section>;
}
