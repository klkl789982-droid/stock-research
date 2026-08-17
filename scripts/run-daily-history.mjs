import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { classifyRequestedDate, isWeekend, updateTradingCalendarDate } from "../lib/trading-calendar-status.mjs";
import { normalizeStockCode } from "../lib/stock-code.mjs";

const PRICE_URL = "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";
const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
const argument = process.argv.find((value) => value.startsWith("--date="));
const requestedDate = argument?.slice("--date=".length);
if (!requestedDate || !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) throw new Error("--date=YYYY-MM-DD가 필요합니다.");
if (!serviceKey) throw new Error("DATA_GO_KR_SERVICE_KEY가 없습니다.");

const root = process.cwd();
const compactDate = requestedDate.replaceAll("-", "");
const universe = JSON.parse(await fs.readFile(path.join(root, "data", "universe.json"), "utf8"));
const referenceCode = normalizeStockCode(universe.stocks?.[0]?.code);
if (!referenceCode) throw new Error("상태 확인용 기준 종목이 없습니다.");

const exists = async (filePath) => {
  try { await fs.access(filePath); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
};
const artifactPaths = {
  model: path.join(root, "data", "history", `${requestedDate}.json`),
  ledger: path.join(root, "data", "market-prices", `${requestedDate}.json`),
  universe: path.join(root, "data", "universe-history", `${requestedDate}.json`),
  marketAnalysis: path.join(root, "data", "analysis", "market", `${requestedDate}.json`),
  marketSeed: path.join(root, "data", "analysis", "market-seeds", `${requestedDate}.json`),
};

async function runScript(script, args = []) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script} 종료 코드: ${code}`)));
  });
}

async function probe() {
  if (isWeekend(requestedDate)) return classifyRequestedDate({ requestedDate });
  const query = new URLSearchParams({ resultType: "json", pageNo: "1", numOfRows: "5", likeSrtnCd: referenceCode, endBasDt: compactDate });
  try {
    const response = await fetch(`${PRICE_URL}?serviceKey=${serviceKey}&${query}`);
    if (!response.ok) return classifyRequestedDate({ requestedDate, error: `HTTP ${response.status}` });
    const payload = await response.json();
    if (payload?.response?.header?.resultCode !== "00") {
      return classifyRequestedDate({ requestedDate, error: `API ${payload?.response?.header?.resultCode ?? "unknown"}` });
    }
    const raw = payload?.response?.body?.items?.item;
    const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const observed = rows
      .filter((row) => normalizeStockCode(row.srtnCd) === referenceCode)
      .map((row) => String(row.basDt ?? ""))
      .filter((value) => /^\d{8}$/u.test(value))
      .sort()
      .at(-1);
    const observedDate = observed ? `${observed.slice(0, 4)}-${observed.slice(4, 6)}-${observed.slice(6, 8)}` : null;
    return classifyRequestedDate({ requestedDate, observedBasDt: observedDate });
  } catch (error) {
    return classifyRequestedDate({ requestedDate, error: error instanceof Error ? error.message : String(error) });
  }
}

const classification = await probe();
if (classification.status === "marketClosed") {
  await updateTradingCalendarDate(requestedDate, {
    status: "marketClosed", observedBasDt: classification.observedBasDt,
    modelSnapshot: "notRequired", marketPriceLedger: "notRequired", reason: classification.reason,
  }, root);
  await runScript("scripts/resolve-history-returns.mjs");
  console.log(JSON.stringify({ requestedDate, ...classification, action: "marketClosed-noArtifacts" }, null, 2));
  process.exit(0);
}

if (classification.status !== "tradingDay") {
  await updateTradingCalendarDate(requestedDate, {
    status: classification.status, observedBasDt: classification.observedBasDt,
    modelSnapshot: "notRequired", marketPriceLedger: "notRequired", reason: classification.reason,
  }, root);
  console.log(JSON.stringify({ requestedDate, ...classification, action: "stopped" }, null, 2));
  process.exitCode = 2;
} else {
  let modelExists = await exists(artifactPaths.model);
  let ledgerExists = await exists(artifactPaths.ledger);
  let universeExists = await exists(artifactPaths.universe);
  let marketAnalysisExists = await exists(artifactPaths.marketAnalysis);
  let marketSeedExists = await exists(artifactPaths.marketSeed);
  if (new Set([modelExists, ledgerExists, universeExists, marketAnalysisExists, marketSeedExists]).size !== 1) {
    await updateTradingCalendarDate(requestedDate, {
      status: "tradingDay", observedBasDt: requestedDate,
      modelSnapshot: modelExists ? "created" : "missing",
      marketPriceLedger: ledgerExists ? "created" : "missing", reason: "partialArtifacts",
      universeArchive: universeExists ? "created" : "missing",
      marketAnalysisSnapshot: marketAnalysisExists ? "created" : "missing",
      intradayMarketSeed: marketSeedExists ? "created" : "missing",
    }, root);
    throw new Error("모델 스냅샷과 가격 원장 중 하나만 존재합니다. 자동 대체하지 않습니다.");
  }
  if (!modelExists) {
    try {
      await runScript("scripts/create-daily-model-snapshot.mjs", [`--date=${requestedDate}`]);
    } catch (error) {
      modelExists = await exists(artifactPaths.model);
      ledgerExists = await exists(artifactPaths.ledger);
      universeExists = await exists(artifactPaths.universe);
      marketAnalysisExists = await exists(artifactPaths.marketAnalysis);
      marketSeedExists = await exists(artifactPaths.marketSeed);
      await updateTradingCalendarDate(requestedDate, {
        status: "tradingDay", observedBasDt: requestedDate,
        modelSnapshot: modelExists ? "created" : "failed",
        marketPriceLedger: ledgerExists ? "created" : "failed", reason: "artifactCreationFailed",
        universeArchive: universeExists ? "created" : "failed",
        marketAnalysisSnapshot: marketAnalysisExists ? "created" : "failed",
        intradayMarketSeed: marketSeedExists ? "created" : "failed",
      }, root);
      throw error;
    }
  }
  const [snapshot, ledger, universeArchive, marketAnalysis, marketSeed] = await Promise.all([
    fs.readFile(artifactPaths.model, "utf8").then(JSON.parse),
    fs.readFile(artifactPaths.ledger, "utf8").then(JSON.parse),
    fs.readFile(artifactPaths.universe, "utf8").then(JSON.parse),
    fs.readFile(artifactPaths.marketAnalysis, "utf8").then(JSON.parse),
    fs.readFile(artifactPaths.marketSeed, "utf8").then(JSON.parse),
  ]);
  if (snapshot.asOfDate !== requestedDate || ledger.date !== requestedDate || universeArchive.requestedDate !== requestedDate || marketAnalysis.requestedDate !== requestedDate || marketSeed.requestedDate !== requestedDate) throw new Error("산출물 날짜가 요청 날짜와 일치하지 않습니다.");
  if (snapshot.records?.length !== universe.finalCount || ledger.records?.length < universe.finalCount || universeArchive.observedUniverse?.length !== universe.finalCount || marketAnalysis.records?.length !== universe.finalCount || marketSeed.records?.length !== universe.finalCount) throw new Error("산출물 종목 수가 Universe와 일치하지 않습니다.");
  await updateTradingCalendarDate(requestedDate, {
    status: "tradingDay", observedBasDt: requestedDate,
    modelSnapshot: "created", marketPriceLedger: "created", reason: null,
    universeArchive: "created",
    marketAnalysisSnapshot: "created",
    intradayMarketSeed: "created",
  }, root);
  await runScript("scripts/resolve-history-returns.mjs");
  console.log(JSON.stringify({ requestedDate, status: "tradingDay", modelSnapshot: "created", marketPriceLedger: "created", resolved: true }, null, 2));
}
