import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { captureDryRunProductionState, compareDryRunProductionState, sanitizeDryRunText } from "../lib/dry-run-safety.mjs";

const argument = process.argv.find((value) => value.startsWith("--date="));
let requestedDate = argument?.slice(7);
const latestMode = process.argv.includes("--latest");
if (!latestMode && (!requestedDate || !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate))) throw new Error("--date=YYYY-MM-DD 또는 --latest가 필요합니다.");
const root = process.cwd();
const startedAt = new Date();
const before = await captureDryRunProductionState(root);

const childResult = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["scripts/create-daily-model-snapshot.mjs", "--dry-run", latestMode ? "--latest" : `--date=${requestedDate}`], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`dry-run 수집 종료 코드 ${code}: ${sanitizeDryRunText(stderr).slice(-2000)}`)));
});
const marker = childResult.stdout.split(/\r?\n/u).findLast((line) => line.startsWith("DRY_RUN_RESULT_JSON="));
if (!marker) throw new Error("dry-run 결과 JSON을 찾을 수 없습니다.");
const result = JSON.parse(marker.slice("DRY_RUN_RESULT_JSON=".length));
const reportDate = result.candidateAsOfDate ?? requestedDate;
requestedDate = reportDate;
const endedAt = new Date();
const after = await captureDryRunProductionState(root);
const integrity = compareDryRunProductionState(before, after);
if (!integrity.unchanged) throw new Error("dry-run 중 production 데이터가 변경되었습니다. 보고서 생성을 중단합니다.");

const q = result.quality.dataQuality;
const models = result.universeSummary.modelEligibleUniverse;
const excludedReasons = Object.fromEntries([...new Set(result.excludedFromScoring.map((item) => item.reason))].sort().map((reason) => [reason, result.excludedFromScoring.filter((item) => item.reason === reason).length]));
const lines = [
  `# Schema v6 Full-Universe Dry-run — ${reportDate}`, "",
  `- 체크포인트 커밋: \`e4920b47f244623bd35df361b7f0ecf056f929ff\``, `- 실행 ID: \`${result.runId ?? "not-created"}\``,
  `- 시작: ${startedAt.toISOString()}`, `- 종료: ${endedAt.toISOString()}`,
  `- 실행시간: ${((endedAt - startedAt) / 1000).toFixed(3)}초`,
  `- 최종 판정: **${result.approvedForSchemaV6Snapshot ? "SCHEMA_V6_SNAPSHOT_APPROVED" : "NOT_APPROVED"}**`, "",
  "## 1. 구현 파일", "", "- `scripts/run-history-dry-run.mjs`", "- `lib/dry-run-safety.mjs`", "- 기존 `scripts/create-daily-model-snapshot.mjs --dry-run` 경로 재사용", "",
  "## 2. 쓰기 차단", "", "dry-run은 history·가격 원장·Universe 아카이브 디렉터리 생성, lock/tmp/backup, 거래일 상태 갱신, resolver 실행 전에 종료한다. 허용된 이 보고서만 기록했다.", "",
  "## 3. API 안전 설정", "", `- endpoint: 공공데이터포털 공식 일봉 getStockPriceInfo`, `- concurrency: ${result.collection.concurrency}`, `- timeout: ${result.collection.timeoutMs}ms`, `- 최대 시도: ${result.collection.maxAttempts}`, "- 429·5xx·timeout·네트워크 오류만 제한 재시도", "- 4xx 인증 오류 재시도 금지", "- 인증 파라미터·키 로그 금지", "",
  "## 4. 실제 수집 통계", "", "| 항목 | 값 |", "|---|---:|",
  `| observed Universe | ${result.collection.observedUniverse} |`, `| API HTTP 요청 | ${result.collection.apiRequests} |`, `| 성공 종목 | ${result.collection.successes} |`, `| 실패 종목 | ${result.collection.failures} |`, `| timeout | ${result.collection.timeouts} |`, `| retry | ${result.collection.retries} |`, "",
  "## 5. 날짜 freshness", "", "| 항목 | 값 |", "|---|---:|", `| requestedDate | ${requestedDate} |`, `| latest basDt 최소 | ${q.freshness.minimumBasDt ?? "-"} |`, `| latest basDt 최대 | ${q.freshness.maximumBasDt ?? "-"} |`, `| exact-date 일치 | ${q.freshness.exactMatchCount} |`, `| stale | ${q.freshness.staleCount} |`, `| 미래 날짜 | ${result.issueCounts.futureDate ?? 0} |`, `| 중복 날짜 | ${q.integrity.duplicateCodeDates} |`, "",
  "## 6. OHLCV 검증", "", "| 항목 | 값 |", "|---|---:|", `| invalid open | ${q.integrity.invalidOpen} |`, `| invalid high | ${q.integrity.invalidHigh} |`, `| invalid low | ${q.integrity.invalidLow} |`, `| invalid close | ${q.integrity.invalidClose} |`, `| invalid OHLC 관계 | ${q.integrity.invalidOhlcRelationships} |`, `| 음수 거래량 | ${q.integrity.negativeVolume} |`, `| 거래량 0 행 | ${q.integrity.zeroVolumeRows} |`, `| 음수 거래대금 | ${result.issueCounts.invalidTradingValue ?? 0} |`, `| exact-date 시총 누락 | ${result.issueCounts.missingExactDateMarketCap ?? 0} |`, `| 20일 거래대금 날짜 오류 | ${result.issueCounts.invalidTradingValueDateWindow ?? 0} |`, "",
  "## 7. 역사 길이 분포", "", "| 구간 | 종목 수 |", "|---|---:|", `| 260일 이상 | ${result.historyDistribution.counts.atLeast260} |`, `| 120~259일 | ${result.historyDistribution.counts.from120To259} |`, `| 34~119일 | ${result.historyDistribution.counts.from34To119} |`, `| 34일 미만 | ${result.historyDistribution.counts.below34} |`, `| 최소/중앙/최대 | ${result.historyDistribution.minimum} / ${result.historyDistribution.median} / ${result.historyDistribution.maximum} |`, "",
  ...Object.entries(result.historyDistribution.codes).flatMap(([key, codes]) => [`### ${key}`, "", codes.length ? codes.join(", ") : "없음", ""]),
  "## 8. 모델별 eligible·excluded", "", "| 모델 | eligible | excluded | TOP50 가능 |", "|---|---:|---:|---|",
  ...Object.entries(models).map(([version, item]) => `| ${version} | ${item.count} | ${item.excludedCount} | ${item.count >= 50 && result.approvedForSchemaV6Snapshot ? "진단 가능" : "NOT_APPROVED"} |`), "", `제외 사유: \`${JSON.stringify(excludedReasons)}\``, "",
  "## 9. Common B/C Universe", "", `- activeModels: ${result.universeSummary.commonComparisonUniverse.activeModels.join(", ")}`, `- count: ${result.universeSummary.commonComparisonUniverse.count}`, `- codesHash: \`${result.universeSummary.commonComparisonUniverse.codesHash}\``, "",
  "## 10. 품질 판정", "", `- fatal: ${result.quality.fatalCount}`, `- ineligible records: ${result.quality.ineligibleCount}`, `- warning: ${result.quality.warningCount}`, `- structuralStatus: ${q.structuralStatus}`, `- overallGrade: ${q.overallGrade}`, `- eligibleForSnapshot: ${result.quality.eligibleForSnapshot}`, `- eligibleForRanking: ${q.certification.eligibleForRanking}`, `- eligibleForRankBacktest: ${q.certification.eligibleForRankBacktest}`, `- eligibleForOptimization: ${q.certification.eligibleForOptimization}`, `- blockingReasons: ${q.blockingReasons.join(", ")}`, "",
  "## 11. Source manifest", "", "```json", JSON.stringify(result.sourceManifest, null, 2), "```", "",
  "## 12. 표본 진단", "", "### Fatal 최대 20", "", "```json", JSON.stringify(result.samples.fatal, null, 2), "```", "", "### Insufficient history 최대 50", "", "```json", JSON.stringify(result.samples.insufficientHistory, null, 2), "```", "", "### Zero volume 최대 20", "", "```json", JSON.stringify(result.samples.zeroVolume, null, 2), "```", "",
  "## 13. 모델별 예상 TOP10", "",
  ...Object.entries(result.diagnosticTop10).flatMap(([version, top]) => [`### ${version} — ${top.status}`, "", top.stocks.length ? ["| rank | code | name | score | universe | percentile | grade |", "|---:|---|---|---:|---:|---:|---|", ...top.stocks.map((stock) => `| ${stock.rank} | ${stock.code} | ${stock.name} | ${stock.score} | ${stock.rankingUniverseCount} | ${stock.rankPercentile} | ${stock.dataQualityGrade} |`)].join("\n") : "NOT_APPROVED", ""]),
  "## 14. Production 데이터 불변", "", `- SHA 및 파일 목록 전후 동일: **${integrity.unchanged}**`, "", "```json", JSON.stringify(after.protectedHashes, null, 2), "```", "",
  "## 15. 다음 조치", "", result.approvedForSchemaV6Snapshot ? "구조적으로 첫 schema v6 스냅샷 생성이 가능하다. 다만 PROVISIONAL 차단 사유를 유지하고 사용자 승인 후 production 실행해야 한다." : "공식 데이터 게시 또는 fatal 원인 해소 전까지 schema v6 스냅샷을 생성하지 않는다.", "",
  "## 16. 테스트·빌드", "", "이 섹션은 구현 검증 명령 완료 후 최종 보고에서 보완한다.", "",
];
if (latestMode) {
  const historyNames = (await fs.readdir(path.join(root, "data", "history"))).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  const latestHistoryDate = historyNames.at(-1)?.slice(0, 10) ?? null;
  const finalDecision = result.quality.fatalCount > 0 ? "DATA_QUALITY_REJECTED" : latestHistoryDate && reportDate <= latestHistoryDate ? "NO_NEW_OFFICIAL_EOD" : result.universeComparison?.sameAsCurrentUniverse ? "APPROVED_WITH_PROVISIONAL_UNIVERSE" : "UNIVERSE_MISMATCH_REQUIRES_REVIEW";
  lines.push(
    "## 17. 제한 probe 및 기준일", "", `- probe: \`${JSON.stringify(result.representativeProbe)}\``, `- candidateAsOfDate: ${reportDate}`, `- 기존 최신 history: ${latestHistoryDate ?? "없음"}`, `- 관계: ${latestHistoryDate && reportDate > latestHistoryDate ? "신규 후보" : "신규 production 대상 아님"}`, "",
    "## 18. Schema v6 메모리 산출물", "", "| 산출물 | schema | records | bytes | hash | validation |", "|---|---:|---:|---:|---|---|",
    ...(result.artifacts ?? []).map((item) => `| ${item.name} | ${item.schemaVersion} | ${item.recordCount} | ${item.estimatedSerializedBytes} | ${item.contentHash} | ${item.validationStatus} |`), "",
    "## 19. Intraday seed 크기", "", `- recordCount: ${result.intradaySeed?.recordCount ?? "-"}`, `- tupleCount: ${result.intradaySeed?.tupleCount ?? "-"}`, `- serializedBytes: ${result.intradaySeed?.serializedBytes ?? "-"}`, `- maximumRowsPerSymbol: ${result.intradaySeed?.maximumRowsPerSymbol ?? "-"}`, `- annual250DayEstimatedBytes: ${result.intradaySeed?.annual250DayEstimatedBytes ?? "-"}`, "",
    "## 20. Universe 비교", "", "```json", JSON.stringify(result.universeComparison ?? null, null, 2), "```", "",
    "## 21. 모델별 점수·순위", "", "```json", JSON.stringify(result.modelStatistics ?? null, null, 2), "```", "",
    "## 22. Source availability", "", "```json", JSON.stringify(result.sourceAvailability ?? null, null, 2), "```", "",
    "## 23. 수익률 초기 상태", "", "```json", JSON.stringify(result.returnsState ?? null, null, 2), "```", "",
    "## 24. 최종 승인 판정", "", `- **${finalDecision}**`, `- eligibleForSnapshotGeneration: ${result.quality.eligibleForSnapshot}`, `- eligibleForRanking: ${q.certification.eligibleForRanking}`, `- eligibleForPredictiveResearch: ${q.certification.eligibleForRanking}`, "- eligibleForExecutableAggregation: false", "- eligibleForOptimization: false", "- 이유: production signalAvailableAt 없음, point-in-time Universe 미인증", "",
    "## 25. 요청 및 재출력", "", `- 실제 외부 HTTP 요청 수: ${result.collection.apiRequests}`, "- 대표 probe 3종목은 request cache로 전체 수집에서 재호출하지 않음", "- 보고서는 수집된 메모리 결과만 사용했으며 보고서 재출력 외부 요청 0건", ""
  );
}
const reportDirectory = path.join(root, "reports");
await fs.mkdir(reportDirectory, { recursive: true });
const reportPath = path.join(reportDirectory, latestMode ? "schema-v6-full-universe-dry-run-2026-08-18.md" : `snapshot-dry-run-${requestedDate}.md`);
await fs.writeFile(reportPath, `${sanitizeDryRunText(lines.join("\n"))}\n`, "utf8");
console.log(`DRY_RUN_REPORT=${reportPath}`);
