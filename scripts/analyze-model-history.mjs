import fs from "node:fs/promises";
import path from "node:path";

const MODELS = ["modelA", "modelB", "modelC", "modelD", "modelE"];
const HORIZONS = [
  { key: "future1dReturn", label: "1d" },
  { key: "future5dReturn", label: "5d" },
  { key: "future20dReturn", label: "20d" },
];

function round(value) {
  return value == null ? null : Number(value.toFixed(4));
}

function maximumDrawdown(returns) {
  let equity = 1;
  let peak = 1;
  let maximum = 0;

  for (const value of returns) {
    equity *= 1 + value / 100;
    peak = Math.max(peak, equity);
    maximum = Math.min(maximum, ((equity - peak) / peak) * 100);
  }
  return maximum;
}

const historyDirectory = path.join(process.cwd(), "data", "history");
await fs.mkdir(historyDirectory, { recursive: true });
const filenames = (await fs.readdir(historyDirectory))
  .filter((filename) => /^\d{4}-\d{2}-\d{2}\.json$/.test(filename))
  .sort();
const snapshots = await Promise.all(
  filenames.map(async (filename) =>
    JSON.parse(await fs.readFile(path.join(historyDirectory, filename), "utf8")),
  ),
);

const models = {};
for (const model of MODELS) {
  models[model] = {};
  for (const horizon of HORIZONS) {
    const cohorts = [];
    const allHoldingReturns = [];

    for (const snapshot of snapshots) {
      const top50 = snapshot.records
        .filter(
          (record) =>
            Number.isFinite(record.scores?.[model]) &&
            Number.isFinite(record.futureReturns?.[horizon.key]),
        )
        .sort((a, b) => b.scores[model] - a.scores[model])
        .slice(0, 50);

      if (top50.length !== 50) continue;
      const returns = top50.map((record) => record.futureReturns[horizon.key]);
      const averageReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length;
      cohorts.push({ asOfDate: snapshot.asOfDate, averageReturn });
      allHoldingReturns.push(...returns);
    }

    models[model][horizon.label] = {
      completedCohorts: cohorts.length,
      holdingObservations: allHoldingReturns.length,
      averageReturn:
        allHoldingReturns.length > 0
          ? round(allHoldingReturns.reduce((sum, value) => sum + value, 0) / allHoldingReturns.length)
          : null,
      winRate:
        allHoldingReturns.length > 0
          ? round((allHoldingReturns.filter((value) => value > 0).length / allHoldingReturns.length) * 100)
          : null,
      maximumDrawdown:
        cohorts.length > 0
          ? round(maximumDrawdown(cohorts.map((cohort) => cohort.averageReturn)))
          : null,
      cohortReturns: cohorts,
    };
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  snapshotCount: snapshots.length,
  topN: 50,
  returnBasis: "close-to-close",
  mddMethod:
    "각 기준일 TOP50의 평균 미래수익률을 날짜순으로 복리 연결한 실험 포트폴리오의 최대낙폭",
  overlapWarning:
    "5일·20일 미래수익률 코호트는 서로 겹칠 수 있으므로 독립 표본이 아니며 통계적 유의성을 별도로 검정해야 합니다.",
  models,
};

const outputDirectory = path.join(process.cwd(), "data", "backtests");
await fs.mkdir(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, "model-comparison.json");
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`분석 완료: ${outputPath}`);
