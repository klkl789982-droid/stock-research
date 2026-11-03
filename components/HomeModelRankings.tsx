import { homeDate } from "../lib/home-presentation.mjs";
import WatchlistStar from "./WatchlistStar";
import styles from "./HomeDashboard.module.css";

export type HomeStock = { code: string; name: string; market?: string };
export type HomeRanking = { modelVersion: string; top: (HomeStock & { rank: number; score: number; previousRank?: number | null; rankChange?: number | null })[];
  comparisonStatus?: string; previousDate?: string | null; rankingUniverseCount?: number };
const purposes: Record<string, string> = { A: "기술적 강도", B: "중기 추세", C: "단기 진입", D: "추세 + 진입" };
const descriptions: Record<string, string> = { A: "상승장 · 주도주 탐색", B: "상승장 · 중기 추세 확인", C: "횡보장 · 단기 반등 신호가 나올 때", D: "상승장 · 추세와 진입 조건 함께 확인" };

export default function HomeModelRankings({ models, limit, source, selectedModel, onSelectStock }: {
  models: HomeRanking[]; limit: 3 | 5; source: "LIVE" | "EOD"; selectedModel: string;
  onSelectStock: (stock: HomeStock) => void | Promise<void>;
}) {
  const model = models.find(m => m.modelVersion === selectedModel + "-v1");
  return <div aria-label={`모델 ${selectedModel} ${source} TOP${limit}`}>
    {model?.top.length ? <table className={styles.rankTable}>
      <caption className="sr-only">모델 {selectedModel} 종목 순위 · {source}</caption>
      <thead><tr><th>순위</th><th>종목</th><th>점수<small className="sr-only"> (100점 만점 · 수익률 아님)</small></th><th>변동</th><th><span className="sr-only">관심종목</span></th></tr></thead>
      <tbody>{model.top.slice(0, limit).map(row => {
        const comparable = source === "EOD" && model.comparisonStatus === "AVAILABLE" && Number.isInteger(row.rankChange);
        const change = comparable ? Number(row.rankChange) : null;
        return <tr key={row.code} data-stock-code={row.code}>
          <td>{row.rank}</td>
          <td><button type="button" onClick={() => void onSelectStock({ code: row.code, name: row.name, market: row.market })} className={"tb-focus " + styles.stock}><strong>{row.name}</strong><small>{row.code}{row.market && " · " + row.market}</small></button></td>
          <td className={styles.score} aria-label={`모델 점수 ${row.score.toFixed(2)}점`}>{row.score.toFixed(2)}</td>
          <td className={change !== null && change > 0 ? styles.up : change !== null && change < 0 ? styles.down : ""}>
            {change === null ? <><span aria-hidden="true">—</span><span className="sr-only">순위 비교 불가</span></> : <><span className="sr-only">{homeDate(model.previousDate)} 순위 {row.previousRank}에서 {row.rank}로 </span>{change > 0 ? `↑${change}` : change < 0 ? `↓${Math.abs(change)}` : "유지"}</>}
          </td>
          <td><WatchlistStar code={row.code} name={row.name} /></td>
        </tr>;
      })}</tbody></table> : <p className="py-4 text-sm text-slate-600">분석 가능한 종목 없음</p>}
    <details className={styles.explain}><summary className="tb-focus">모델 {selectedModel} · {purposes[selectedModel]}</summary>
      <p>{descriptions[selectedModel]} · {selectedModel}-v1</p></details>
    <p className={styles.receipt}>{source === "EOD" && model?.comparisonStatus === "AVAILABLE" ? `${homeDate(model.previousDate)} 대비 · 동일 버전·산식·종목군 확인` : source === "LIVE" ? "저장 점수 · 전일 순위 비교 기록 없음" : "전일 순위 비교 불가"}</p>
  </div>;
}
