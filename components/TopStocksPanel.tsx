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
  rankingUniverseCount?: number;
  rankPercentile?: number;
};
type TopStocksResponse = {
  dataMode: "historySnapshot";
  model: ModelId;
  modelName: string;
  modelVersion: string | null;
  modelRole?: "champion" | "challenger";
  promotionStatus?: "notApproved";
  rankingAsOfDate: string;
  priceAsOfDate: string;
  priceBasis: "officialDailyClose";
  generatedAt: string;
  count: number;
  stocks: TopStock[];
  dataQualityGrade?: string;
  structuralStatus?: string;
  eligibleForRankBacktest?: boolean;
  sourceManifestVersion?: number | null;
};

type StockSelection = { code: string; name: string };
type TopStocksPanelProps = { onSelectStock?: (stock: StockSelection) => void | Promise<void> };

const primaryTabs = [
  { id: "B", model: "B" as const, label: "모델 B · 추세 강도" },
  { id: "C", model: "C" as const, label: "모델 C · 진입 강도" },
];
const researchTabs = [
  { id: "A-v1", model: "A" as const, label: "A-v1 · 기존 기술 강도 · 연구 보존" },
  { id: "A-v2", model: "A" as const, version: "A-v2" as const, label: "A-v2 · 기술 강도 · 검증 중" },
  { id: "D", model: "D" as const, label: "D-v1 · 결합 점수 · 연구 보존" },
];
const tabs = [...primaryTabs, ...researchTabs];

export default function TopStocksPanel({ onSelectStock }: TopStocksPanelProps) {
  const [activeTab, setActiveTab] = useState("B");
  const [selectingCode, setSelectingCode] = useState<string | null>(null);
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
        const selectedTab = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
        const selectedVersion = "version" in selectedTab ? selectedTab.version : undefined;
        const versionQuery = selectedVersion ? `&version=${selectedVersion}` : "";
        const response = await fetch(`/api/top-stocks?model=${selectedTab.model}${versionQuery}&limit=50`, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error?.message ?? "실제 TOP50 데이터를 불러오지 못했습니다.");
        if (result.dataMode !== "historySnapshot" || result.model !== selectedTab.model) throw new Error("TOP50 응답의 데이터 모드 또는 모델이 올바르지 않습니다.");
        if (selectedVersion && result.modelVersion !== selectedVersion) throw new Error("요청한 챌린저 모델 버전과 응답이 일치하지 않습니다.");
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
  }, [activeTab, requestVersion]);

  return (
    <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 sm:p-5">
      <p className="text-sm text-gray-500">History Snapshot Ranking</p>
      <h2 className="mt-1 text-xl font-bold text-gray-900">시장 TOP 종목</h2>

      <div className="mt-6 grid grid-cols-2 gap-2" role="tablist" aria-label="활성 비교 모델">
        {primaryTabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}
            className={`rounded-xl border px-3 py-3 text-sm transition-colors ${activeTab === tab.id ? "border-gray-900 bg-gray-900 font-semibold text-white" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"}`}>
            {tab.label}
          </button>
        ))}
      </div>

      <details className="mt-3 rounded-xl border border-gray-200 bg-gray-50">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-700">연구 모델 보기</summary>
        <div className="grid grid-cols-1 gap-2 border-t border-gray-200 p-3 sm:grid-cols-3" role="tablist" aria-label="연구 모델">
          {researchTabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)} className={`min-h-12 rounded-xl border px-3 py-2 text-sm leading-snug ${activeTab === tab.id ? "border-gray-900 bg-gray-900 font-semibold text-white" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-100"}`}>{tab.label}</button>)}
        </div>
      </details>

      {activeTab === "A-v2" && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-semibold">검증 중인 챌린저 모델</p>
          <p className="mt-1 text-xs">운영 모델로 승인되지 않았으며 A-v1과 병렬 성과를 수집한 뒤 사용자 승인으로만 승격할 수 있습니다.</p>
        </div>
      )}

      {data && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="font-semibold">{data.dataQualityGrade && data.dataQualityGrade !== "UNKNOWN" ? "잠정 데이터" : "기존 잠정 스냅샷 · 품질 게이트 도입 전"}</span><span className="ml-2">기준일 {data.rankingAsOfDate}</span>
          <details className="mt-2 text-xs text-amber-800"><summary className="cursor-pointer font-medium">데이터 기준 자세히 보기</summary>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>구조 검증: {data.structuralStatus === "passed" ? "통과" : "정보 없음"}</div><div>순위 기준일: {data.rankingAsOfDate}</div><div>가격 기준일: {data.priceAsOfDate}</div><div>가격 기준: 공식 일봉 종가</div><div>모델 버전: {data.modelVersion ?? "미등록"}</div><div>데이터 모드: 실제 스냅샷</div><div>순위 Universe: {data.stocks[0]?.rankingUniverseCount ?? "정보 없음"}</div><div>공식 최적화: 불가</div><div>Manifest: {data.sourceManifestVersion ?? "도입 전"}</div>
          </div></details>
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
          <table className="w-full min-w-[560px] table-auto border-collapse text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500"><tr><th className="whitespace-nowrap px-3 py-3 font-medium sm:px-4">순위</th><th className="px-3 py-3 font-medium sm:px-4">종목명</th><th className="hidden px-4 py-3 font-medium sm:table-cell">시장</th><th className="whitespace-nowrap px-3 py-3 text-right font-medium sm:px-4">점수</th><th className="whitespace-nowrap px-3 py-3 text-right font-medium sm:px-4">기준일 종가</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {data.stocks.map((stock) => <tr key={stock.code} className="hover:bg-gray-50"><td className="whitespace-nowrap px-3 py-4 font-semibold text-gray-900 sm:px-4">{stock.rank}</td><td className="px-3 py-4 sm:px-4"><button type="button" disabled={selectingCode !== null} aria-label={`${stock.name} ${stock.code} 검색`} onClick={async () => { if (!onSelectStock || selectingCode) return; setSelectingCode(stock.code); try { await onSelectStock({ code: stock.code, name: stock.name }); } finally { setSelectingCode(null); } }} className="cursor-pointer text-left font-semibold text-gray-900 hover:text-blue-700 hover:underline disabled:cursor-wait">{stock.name}<span className="block whitespace-nowrap text-xs font-normal text-gray-400 sm:inline sm:ml-2">{stock.code}</span></button></td><td className="hidden px-4 py-4 text-gray-500 sm:table-cell">{stock.market}</td><td className="whitespace-nowrap px-3 py-4 text-right font-semibold text-gray-800 sm:px-4">{stock.score.toFixed(2)}</td><td className="whitespace-nowrap px-3 py-4 text-right text-gray-700 sm:px-4">{stock.closePrice.toLocaleString("ko-KR")}원</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
