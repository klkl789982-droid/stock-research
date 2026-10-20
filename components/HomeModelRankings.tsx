import { homeDate } from "../lib/home-presentation.mjs";

export type HomeStock = { code: string; name: string; market?: string };
export type HomeRanking = { modelVersion: string; top: (HomeStock & { rank: number; score: number; previousRank?: number | null; rankChange?: number | null })[];
  comparisonStatus?: string; previousDate?: string | null; rankingUniverseCount?: number };
const purposes: Record<string, string> = { A: "기술적 강도", B: "중기 추세", C: "단기 진입", D: "추세 + 진입" };
const descriptions: Record<string, string> = { A: "상승장 · 주도주 탐색", B: "상승장 · 중기 추세 확인", C: "횡보장 · 단기 반등 신호가 나올 때", D: "상승장 · 추세와 진입 조건 함께 확인" };

export default function HomeModelRankings({ models, limit, source, onOpenModel, onSelectStock }: {
  models: HomeRanking[]; limit: 3 | 5; source: "LIVE" | "EOD";
  onOpenModel: (model: string) => void; onSelectStock: (stock: HomeStock) => void | Promise<void>;
}) {
  return <div className="home-model-grid" aria-label={`${source} 모델별 순위`}>
    {["A", "B", "C", "D"].map(letter => {
      const model = models.find(m => m.modelVersion === `${letter}-v1`);
      return <article key={letter} className="home-model-column" aria-label={`모델 ${letter} ${source} TOP${limit}`}>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><h3><button type="button" onClick={() => onOpenModel(letter === "A" ? "A-v1" : letter)} className="tb-focus rounded text-lg font-semibold hover:underline" aria-label={`모델 ${letter}-v1 상세 순위`}>모델 {letter} <span aria-hidden="true" className="text-sm text-slate-500">↗</span></button></h3><span className="text-sm text-slate-600">{purposes[letter]}</span></div>
        <details className="home-model-explanation"><summary className="tb-focus rounded">모델 설명</summary><p>{descriptions[letter]} · {model?.modelVersion ?? `${letter}-v1`}</p><p>장세 설명은 산식의 특성입니다. 수익률 우위가 검증된 모델 구분은 아닙니다.</p></details>
        <div className="home-rank-grid home-rank-heading" aria-hidden="true"><span>순위</span><span>종목</span><span className="text-right">점수</span><span className="text-right">변동</span></div>
        <ol className="home-rank-list">{model?.top.slice(0, limit).map(row => {
          const comparable = source === "EOD" && model.comparisonStatus === "AVAILABLE" && Number.isInteger(row.rankChange);
          const change = comparable ? Number(row.rankChange) : null;
          return <li key={row.code} className="home-rank-grid" data-stock-code={row.code}>
            <span className="home-rank-number">{row.rank}</span>
            <button type="button" onClick={() => void onSelectStock({ code: row.code, name: row.name, market: row.market })} className="tb-focus home-stock-button rounded text-left hover:underline"><span className="home-stock-name">{row.name}</span><span className="home-stock-code">{row.code}</span></button>
            <span className="home-model-score" aria-label={`모델 점수 ${row.score.toFixed(2)}점`}>{row.score.toFixed(2)}</span>
            <span className={`home-rank-change ${change !== null && change > 0 ? "text-red-700" : change !== null && change < 0 ? "text-blue-700" : "text-slate-500"}`}>
              {change === null ? <><span aria-hidden="true">—</span><span className="sr-only">순위 비교 불가</span></> : <><span className="sr-only">{homeDate(model.previousDate)} 순위 {row.previousRank}에서 {row.rank}로 </span>{change > 0 ? `↑${change}` : change < 0 ? `↓${Math.abs(change)}` : "유지"}</>}
            </span>
          </li>;
        })}</ol>
        {!model?.top.length && <p className="py-4 text-sm text-slate-600">분석 가능한 종목 없음</p>}
        <p className="mt-3 text-xs leading-5 text-slate-600">{source === "EOD" && model?.comparisonStatus === "AVAILABLE" ? `${homeDate(model.previousDate)} 대비 · 동일 버전·산식·종목군 확인` : source === "LIVE" ? "저장 점수 · 전일 순위 비교 기록 없음" : "전일 순위 비교 불가"}</p>
      </article>;
    })}
  </div>;
}
