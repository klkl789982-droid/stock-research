"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Stock = { code: string; name: string; market: string };
type Item = Stock & { date: string | null; close: number | null; closeChangePct: number | null; models: Record<string, { score: number | null; rank: number | null }> | null };
type ListStatus = "loading" | "ready" | "error";
type Watchlist = {
  items: Item[]; listStatus: ListStatus; marketAvailable: boolean; busy: boolean;
  enable: (value: true) => void; refresh: () => void;
  update: (row: Pick<Stock, "code" | "name">, method: "PUT" | "DELETE") => Promise<void>;
};
const Context = createContext<Watchlist | null>(null);

// A single authenticated list per page session, loaded when the first list or star mounts.
export function WatchlistProvider({ children }: { children: ReactNode }) {
  const [enabled, enable] = useState(false);
  const [version, setVersion] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const [listStatus, setListStatus] = useState<ListStatus>("loading");
  const [marketAvailable, setMarketAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const updating = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const request = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/api/watchlist", { cache: "no-store", signal: request.signal });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!request.signal.aborted) {
          setItems(data.items); setMarketAvailable(data.marketAvailable); setListStatus("ready");
        }
      } catch { if (!request.signal.aborted) setListStatus("error"); }
    };
    void load();
    return () => request.abort();
  }, [enabled, version]);
  const refresh = () => { setListStatus("loading"); setVersion(value => value + 1); };
  async function update(row: Pick<Stock, "code" | "name">, method: "PUT" | "DELETE") {
    if (updating.current || listStatus !== "ready") return;
    updating.current = true;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/watchlist", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: row.code }) });
      if (response.status === 409) { setMessage("관심종목은 최대 50개까지 저장할 수 있습니다."); return; }
      if (response.status === 404) { setMessage("현재 분석 대상에 포함된 종목만 저장할 수 있습니다."); return; }
      if (!response.ok) throw new Error();
      setMessage(`${row.name} · 관심종목${method === "PUT" ? "에 추가했습니다." : "에서 삭제했습니다."}`);
      refresh();
    } catch { setMessage("저장 여부를 확인하지 못했습니다. 관심종목 목록을 확인해 주세요."); refresh(); }
    finally { updating.current = false; setBusy(false); }
  }
  return <Context.Provider value={{ items, listStatus, marketAvailable, busy, enable, refresh, update }}>
    {children}
    {message && <div className="fixed bottom-4 right-4 z-40 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-800 shadow-sm">
      <span role="status">{message}</span><button type="button" className="tb-focus min-h-9 rounded-lg px-2 text-slate-600" onClick={() => setMessage("")} aria-label="관심종목 알림 닫기">닫기</button>
    </div>}
  </Context.Provider>;
}

export function useWatchlist() {
  const list = useContext(Context);
  const enable = list?.enable;
  useEffect(() => { enable?.(true); }, [enable]);
  return list;
}

export default function WatchlistStar({ code, name }: { code: string; name: string }) {
  const list = useWatchlist();
  if (!list) return null;
  const saved = list.items.some(row => row.code === code);
  const label = list.listStatus === "error" ? "관심종목 상태 다시 확인" : `${name} 관심종목 ${saved ? "삭제" : "추가"}`;
  return <button type="button" title={label} aria-label={label} aria-pressed={list.listStatus === "ready" ? saved : undefined}
    disabled={list.busy || list.listStatus === "loading"}
    className="tb-focus inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-blue-50 hover:text-[var(--tb-blue)] aria-pressed:bg-blue-50 aria-pressed:text-[var(--tb-blue)] disabled:opacity-50"
    onClick={() => list.listStatus === "error" ? list.refresh() : void list.update({ code, name }, saved ? "DELETE" : "PUT")}>
    <svg aria-hidden="true" viewBox="0 0 24 24" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" className="h-5 w-5">
      <path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.6-4.5 6.4-.9Z"/>
    </svg>
  </button>;
}
