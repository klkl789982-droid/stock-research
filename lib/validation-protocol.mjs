import fs from "node:fs/promises";
import path from "node:path";
import { loadModelRegistry } from "./model-registry.mjs";

export async function loadValidationConfig(root = process.cwd()) {
  const [periods, rules] = await Promise.all([
    fs.readFile(path.join(root, "config", "model-validation-periods.json"), "utf8"),
    fs.readFile(path.join(root, "config", "model-validation-rules.json"), "utf8"),
  ]);
  return { periods: JSON.parse(periods), rules: JSON.parse(rules) };
}

export function validatePeriodOrder(config) {
  const errors = [];
  const toTime = (value) => new Date(`${value}T00:00:00Z`).getTime();
  const { train, validation, finalHoldout } = config.periods;
  if (toTime(train.start) > toTime(train.end)) errors.push("train 시작일이 종료일보다 늦습니다.");
  if (toTime(validation.start) > toTime(validation.end)) errors.push("validation 시작일이 종료일보다 늦습니다.");
  if (toTime(finalHoldout.start) > toTime(finalHoldout.end)) errors.push("finalHoldout 시작일이 종료일보다 늦습니다.");
  if (toTime(train.end) >= toTime(validation.start)) errors.push("train과 validation 기간이 겹칩니다.");
  if (toTime(validation.end) >= toTime(finalHoldout.start)) errors.push("validation과 finalHoldout 기간이 겹칩니다.");

  for (const window of config.walkForward.windows) {
    if (toTime(window.train.end) >= toTime(window.validation.start)) {
      errors.push(`${window.windowId}: train과 validation 시간 순서가 잘못됐습니다.`);
    }
    if (toTime(window.validation.end) >= toTime(finalHoldout.start)) {
      errors.push(`${window.windowId}: finalHoldout을 침범합니다.`);
    }
  }
  return errors;
}

export async function collectValidationReadiness(root = process.cwd()) {
  const { periods, rules } = await loadValidationConfig(root);
  const historyDirectory = path.join(root, "data", "history");
  await fs.mkdir(historyDirectory, { recursive: true });
  const filenames = (await fs.readdir(historyDirectory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name));
  const snapshots = await Promise.all(filenames.map(async (name) => JSON.parse(await fs.readFile(path.join(historyDirectory, name), "utf8"))));
  const regimes = new Set(snapshots.map((snapshot) => snapshot.marketRegime).filter(Boolean));
  const summary = {
    tradingDays: new Set(snapshots.map((snapshot) => snapshot.asOfDate)).size,
    stockObservations: snapshots.reduce((sum, snapshot) => sum + (snapshot.records?.length ?? 0), 0),
    marketRegimes: regimes.size,
    regimeLabels: [...regimes],
  };
  const warnings = [];
  if (summary.tradingDays < rules.minimumTradingDays) warnings.push(`거래일 부족: ${summary.tradingDays}/${rules.minimumTradingDays}`);
  if (summary.stockObservations < rules.minimumStockObservations) warnings.push(`stock-observations 부족: ${summary.stockObservations}/${rules.minimumStockObservations}`);
  if (summary.marketRegimes < rules.minimumMarketRegimes) warnings.push(`시장 레짐 부족: ${summary.marketRegimes}/${rules.minimumMarketRegimes}`);
  warnings.push(...validatePeriodOrder(periods));
  return { rulesVersion: rules.rulesVersion, warnOnly: rules.warnOnly, summary, warnings };
}

function emptyMetricResult(rules) {
  const result = {};
  for (const market of rules.markets) {
    result[market] = {};
    for (const regime of rules.regimes) {
      result[market][regime] = {};
      for (const topN of rules.topN) {
        result[market][regime][`TOP${topN}`] = {};
        for (const horizon of rules.horizons) {
          result[market][regime][`TOP${topN}`][horizon] = {
            averageReturn: null,
            medianReturn: null,
            winRate: null,
            excessReturn: null,
            MDD: null,
            observations: 0,
          };
        }
      }
    }
  }
  return result;
}

export async function createExperiment(specification, root = process.cwd()) {
  const { periods, rules } = await loadValidationConfig(root);
  const registry = await loadModelRegistry(root);
  const required = rules.requiredPreRegistrationFields;
  const errors = [];
  for (const field of ["experimentId", "modelVersion", ...required]) {
    if (!(field in specification) || specification[field] === "" || specification[field] == null) errors.push(`실험 필수 필드 누락: ${field}`);
  }
  if (!Array.isArray(specification.evaluationMetrics) || specification.evaluationMetrics.length === 0) errors.push("evaluationMetrics가 비어 있습니다.");
  const model = registry.models.find((entry) => entry.modelVersion === specification.modelVersion);
  if (!model) errors.push(`등록되지 않은 모델 버전: ${specification.modelVersion}`);
  if (model?.status === "notConfigured") errors.push(`${specification.modelVersion}은 공식이 정의되지 않았습니다.`);
  const unknownMetrics = (specification.evaluationMetrics ?? []).filter((metric) => !rules.allowedEvaluationMetrics.includes(metric));
  if (unknownMetrics.length > 0) errors.push(`허용되지 않은 metric: ${unknownMetrics.join(", ")}`);
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const readiness = await collectValidationReadiness(root);
  const experiment = {
    experimentId: specification.experimentId,
    modelVersion: specification.modelVersion,
    createdAt: new Date().toISOString(),
    protocolId: periods.protocolId,
    trainPeriod: periods.periods.train,
    validationPeriod: periods.periods.validation,
    holdoutPeriod: periods.periods.finalHoldout,
    walkForwardWindows: periods.walkForward.windows.filter((window) => (specification.walkForwardWindowIds ?? []).includes(window.windowId)),
    hypothesis: specification.hypothesis,
    expectedBenefit: specification.expectedBenefit,
    knownRisk: specification.knownRisk,
    metrics: specification.evaluationMetrics,
    readinessAtCreation: readiness,
    holdoutAccess: { evaluationCount: 0, accesses: [] },
    result: emptyMetricResult(rules),
    decision: "needsMoreData",
    notes: specification.notes ?? "",
  };
  const experimentPath = path.join(root, "data", "experiments", `${experiment.experimentId}.json`);
  await fs.writeFile(experimentPath, `${JSON.stringify(experiment, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return experiment;
}
