import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildModelValidation } from "../lib/model-validation-engine.mjs";
import { MODEL_VERSIONS } from "../lib/rank-backtest-engine.mjs";

const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith("--")).map((value) => { const [key, ...rest] = value.slice(2).split("="); return [key, rest.length ? rest.join("=") : true]; }));
if (args["dry-run"] !== true) throw new Error("현재 단계는 --dry-run만 지원합니다.");
const models = args.models ? String(args.models).split(",") : MODEL_VERSIONS;
if (models.some((model) => !MODEL_VERSIONS.includes(model))) throw new Error("지원하지 않는 model version입니다.");
const root = process.cwd(), directory = path.join(root, "data", "history");
const validationRules = JSON.parse(await fs.readFile(path.join(root, "config", "model-validation-rules.json"), "utf8"));
const names = (await fs.readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort();
const snapshots = await Promise.all(names.map(async (name) => { const bytes = await fs.readFile(path.join(directory, name)); return { date: name.slice(0, 10), hash: createHash("sha256").update(bytes).digest("hex"), snapshot: JSON.parse(bytes.toString("utf8")) }; }));
const result = buildModelValidation({ snapshots, models, minimumSignalDays: validationRules.minimumTradingDays, generatedAt: new Date().toISOString() });
console.log(JSON.stringify({ dryRun: true, inputSignalDates: result.inputSignalDates, modelVersions: result.modelVersions, dailyMetricCount: result.dailyMetrics.length, periodAggregateCount: result.periodAggregates.length, sufficiencyStatuses: Object.fromEntries([...new Set(result.periodAggregates.map((item) => item.sampleSufficiencyStatus))].map((status) => [status, result.periodAggregates.filter((item) => item.sampleSufficiencyStatus === status).length])), contentHash: result.contentHash }, null, 2));
