"use client";

import { useEffect, useState } from "react";

type ModelId = "A" | "B" | "C" | "D";
type TopStock = {
  rank: number;
  code: string;
  name: string;
  market: string;
  score: number;
  closePrice: number;
  priceBasis: "officialDailyClose";
  priceAsOfDate: string;
};
type TopStocksResponse = {
  dataMode: "historySnapshot";
  model: ModelId;
  modelName: string;
  modelVersion: string | null;
  rankingAsOfDate: string;
  priceAsOfDate: string;
  priceBasis: "officialDailyClose";
  generatedAt: string;
  count: number;
  stocks: TopStock[];
};

const tabs: { id: ModelId; label: string }[] = [
  { id: "A", label: "모델 A · 기술적 강도" },
  { id: "B", label: "모델 B · 추세 강도" },
  { id: "C", label: "모델 C · 진입 강도" },
  { id: "D", label: "모델 D · 결합 점수" },
];

export default function TopStocksPanel() {
  const [activeModel, setActiveModel] = useState<ModelId>("A");
  const [data, setData] = useState<TopStocksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(null);
      setData(null);
      try {
        const response = await fetch(`/api/top-stocks?model=${activeModel}&limit=50`, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error?.message ?? "실제 TOP50 데이터를 불러오지 못했습니다.");
        if (result.dataMode !== "historySnapshot" || result.model !== activeModel) throw new Error("TOP50 응답의 데이터 모드 또는 모델이 올바르지 않습니다.");
        setData(result as TopStocksResponse);
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "실제 TOP50 데이터를 불러오지 못했습니다.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, [activeModel, requestVersion]);

  return (
    <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 sm:p-5">
      <p className="text-sm text-gray-500">History Snapshot Ranking</p>
      <h2 className="mt-1 text-xl font-bold text-gray-900">시장 TOP 종목</h2>

      <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" role="tablist" aria-label="시장 TOP 종목 모델">
        {tabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={activeModel === tab.id} onClick={() => setActiveModel(tab.id)}
            className={`rounded-xl border px-3 py-3 text-sm transition-colors ${activeModel === tab.id ? "border-gray-900 bg-gray-900 font-semibold text-white" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {data && (
        <div className="mt-5 grid grid-cols-2 gap-3 rounded-xl bg-gray-50 p-4 text-xs text-gray-600 sm:grid-cols-5">
          <div><p className="text-gray-400">순위 기준일</p><p className="mt-1 font-semibold text-gray-800">{data.rankingAsOfDate}</p></div>
          <div><p className="text-gray-400">가격 기준일</p><p className="mt-1 font-semibold text-gray-800">{data.priceAsOfDate}</p></div>
          <div><p className="text-gray-400">가격 기준</p><p className="mt-1 font-semibold text-gray-800">공식 일봉 종가</p></div>
          <div><p className="text-gray-400">모델 버전</p><p className="mt-1 font-semibold text-gray-800">{data.modelVersion ?? "미등록"}</p></div>
          <div><p className="text-gray-400">데이터 모드</p><p className="mt-1 font-semibold text-gray-800">실제 스냅샷</p></div>
        </div>
      )}

      {loading && <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 px-4 py-12 text-center text-sm text-gray-500">실제 TOP50 데이터를 불러오는 중입니다...</div>}
      {!loading && error && (
        <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-10 text-center">
          <p className="text-sm font-medium text-red-700">{error}</p>
          <p className="mt-2 text-xs text-red-600">예시 데이터로 대체하지 않습니다.</p>
          <button type="button" onClick={() => setRequestVersion((version) => version + 1)} className="mt-4 rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700">다시 시도</button>
        </div>
      )}
      {!loading && !error && data && data.stocks.length === 0 && <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 px-4 py-12 text-center text-sm text-gray-500">실제 TOP50 데이터가 없습니다. 최신 유효 모델 스냅샷을 생성해야 합니다.</div>}
      {!loading && !error && data && data.stocks.length > 0 && (
        <div className="mt-5 overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full min-w-[680px] border-collapse text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500"><tr><th className="px-4 py-3 font-medium">순위</th><th className="px-4 py-3 font-medium">종목명</th><th className="px-4 py-3 font-medium">시장</th><th className="px-4 py-3 text-right font-medium">모델 점수</th><th className="px-4 py-3 text-right font-medium">기준일 종가</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {data.stocks.map((stock) => <tr key={stock.code} className="hover:bg-gray-50"><td className="px-4 py-4 font-semibold text-gray-900">{stock.rank}</td><td className="px-4 py-4 font-semibold text-gray-900">{stock.name}<span className="ml-2 text-xs font-normal text-gray-400">{stock.code}</span></td><td className="px-4 py-4 text-gray-500">{stock.market}</td><td className="px-4 py-4 text-right font-semibold text-gray-800">{stock.score.toFixed(2)}</td><td className="px-4 py-4 text-right text-gray-700">{stock.closePrice.toLocaleString("ko-KR")}원</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
