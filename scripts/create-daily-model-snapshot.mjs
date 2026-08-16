import fs from "node:fs/promises";
import path from "node:path";
import { calculateSnapshotModels } from "../lib/model-score-engine.mjs";
import { createMarketPriceLedger, validateMarketPriceLedger } from "../lib/market-price-ledger.mjs";
import {
  MODEL_DEFINITIONS,
  MODEL_HISTORY_SCHEMA_VERSION,
  assignRanks,
  createHistoryRecord,
  createTopLists,
  validateSnapshot,
} from "../lib/model-history-schema.mjs";

const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
if (!serviceKey) throw new Error("DATA_GO_KR_SERVICE_KEY가 없습니다.");

const PRICE_URL =
  "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";
const CONCURRENCY = 4;
const REQUIRED_HISTORY_ROWS = 20;
const EXPECTED_UNIVERSE_COUNT = 553;

function parseRequestedDate() {
  const argument = process.argv.find((value) => value.startsWith("--date="));
  if (!argument) return null;
  const date = argument.slice("--date=".length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date는 YYYY-MM-DD 형식이어야 합니다.");
  return date;
}

const requestedDate = parseRequestedDate();
const requestedCompactDate = requestedDate?.replaceAll("-", "") ?? null;

function normalizeItems(items) {
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

async function fetchHistory(code, attempt = 1) {
  const query = new URLSearchParams({
    resultType: "json",
    pageNo: "1",
    numOfRows: "260",
    likeSrtnCd: code,
  });
  if (requestedCompactDate) query.set("endBasDt", requestedCompactDate);

  try {
    const response = await fetch(`${PRICE_URL}?serviceKey=${serviceKey}&${query}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const rows = normalizeItems(payload?.response?.body?.items?.item)
      .filter((row) => String(row.srtnCd ?? "").replace(/^A/, "") === code)
      .filter((row) => !requestedCompactDate || String(row.basDt) <= requestedCompactDate)
      .sort((a, b) => String(b.basDt).localeCompare(String(a.basDt)));

    if (rows.length < REQUIRED_HISTORY_ROWS) {
      throw new Error(`일봉 부족: ${rows.length}개`);
    }
    return rows;
  } catch (error) {
    if (attempt >= 3) throw new Error(`${code} 일봉 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    return fetchHistory(code, attempt + 1);
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

const universePath = path.join(process.cwd(), "data", "universe.json");
const universe = JSON.parse(await fs.readFile(universePath, "utf8"));
if (universe.finalCount !== EXPECTED_UNIVERSE_COUNT || universe.stocks?.length !== EXPECTED_UNIVERSE_COUNT) {
  throw new Error(`Universe가 553개가 아닙니다: finalCount=${universe.finalCount}, stocks=${universe.stocks?.length ?? 0}`);
}

const historyDirectory = path.join(process.cwd(), "data", "history");
const marketPriceDirectory = path.join(process.cwd(), "data", "market-prices");
await fs.mkdir(historyDirectory, { recursive: true });
await fs.mkdir(marketPriceDirectory, { recursive: true });
if (requestedDate) {
  for (const existingPath of [
    path.join(historyDirectory, `${requestedDate}.json`),
    path.join(marketPriceDirectory, `${requestedDate}.json`),
  ]) {
    try {
      await fs.access(existingPath);
      throw new Error(`${existingPath}가 이미 존재합니다. 덮어쓰지 않습니다.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
const observedDates = new Set();

const records = await mapWithConcurrency(
  universe.stocks,
  CONCURRENCY,
  async (stock, index) => {
    console.log(`[${index + 1}/${universe.stocks.length}] ${stock.code} ${stock.name}`);
    const history = await fetchHistory(stock.code);
    const asOfDate = String(history[0].basDt);
    if (requestedCompactDate && asOfDate !== requestedCompactDate) {
      throw new Error(`${stock.code} 기준일 불일치: 요청 ${requestedCompactDate}, 일봉 ${asOfDate}`);
    }
    observedDates.add(asOfDate);

    const models = calculateSnapshotModels(history);
    const avgVolume20d = history
      .slice(0, 20)
      .reduce((sum, row) => sum + Number(row.trqu), 0) / 20;
    const openPrice = Number(history[0]?.mkp);
    if (!Number.isFinite(openPrice) || openPrice <= 0) {
      throw new Error(`${stock.code} ${asOfDate} 공식 시가(mkp)가 유효하지 않습니다.`);
    }

    return createHistoryRecord({
      stock,
      asOfDate: `${asOfDate.slice(0, 4)}-${asOfDate.slice(4, 6)}-${asOfDate.slice(6, 8)}`,
      closePrice: Number(history[0].clpr),
      openPrice,
      avgVolume20d,
      historyRows: history.length,
      modelA: models.modelA,
      modelB: models.modelB,
      modelC: models.modelC,
      modelD: models.modelD,
      modelE: models.modelE,
    });
  },
);

if (observedDates.size !== 1) {
  throw new Error(`종목별 최신 거래일이 일치하지 않습니다: ${[...observedDates].join(", ")}`);
}

assignRanks(records);
const compactDate = [...observedDates][0];
const asOfDate = `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`;
const snapshot = {
  schemaVersion: MODEL_HISTORY_SCHEMA_VERSION,
  asOfDate,
  computedAt: new Date().toISOString(),
  dataMode: "official-daily-close",
  universe: {
    generatedAt: universe.generatedAt,
    sourceCount: universe.finalCount,
    snapshotCount: records.length,
  },
  modelDefinitions: MODEL_DEFINITIONS,
  topLists: createTopLists(records),
  futureReturnDefinition: {
    purpose: "modelPredictivePower",
    priceBasis: "signalClose-to-futureClose",
    entryAssumption: "none",
    tradingDayOffsets: [1, 5, 20],
    formula: "(futureClose / signalClose - 1) * 100",
    status: "pending",
  },
  records,
};

const validationErrors = validateSnapshot(snapshot, EXPECTED_UNIVERSE_COUNT);
if (validationErrors.length > 0) {
  throw new Error(`스냅샷 검증 실패:\n${validationErrors.slice(0, 20).join("\n")}`);
}

const marketPriceLedger = createMarketPriceLedger(asOfDate, records);
const ledgerValidationErrors = validateMarketPriceLedger(marketPriceLedger, EXPECTED_UNIVERSE_COUNT);
if (ledgerValidationErrors.length > 0) {
  throw new Error(`가격 원장 검증 실패:\n${ledgerValidationErrors.slice(0, 20).join("\n")}`);
}

const outputPath = path.join(historyDirectory, `${asOfDate}.json`);
const temporaryPath = `${outputPath}.tmp`;
const lockPath = `${outputPath}.lock`;
const ledgerPath = path.join(marketPriceDirectory, `${asOfDate}.json`);
const ledgerTemporaryPath = `${ledgerPath}.tmp`;
const ledgerLockPath = `${ledgerPath}.lock`;

try {
  await fs.writeFile(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(ledgerLockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
} catch (error) {
  await fs.rm(lockPath, { force: true });
  await fs.rm(ledgerLockPath, { force: true });
  if (error?.code === "EEXIST") throw new Error(`${asOfDate} 스냅샷 생성이 이미 진행 중이거나 완료되었습니다.`);
  throw error;
}

try {
  try {
    await fs.access(outputPath);
    throw new Error(`${outputPath}가 이미 존재합니다. 과거 스냅샷은 덮어쓰지 않습니다.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await fs.access(ledgerPath);
    throw new Error(`${ledgerPath}가 이미 존재합니다. 가격 원장을 덮어쓰지 않습니다.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(ledgerTemporaryPath, `${JSON.stringify(marketPriceLedger, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.rename(ledgerTemporaryPath, ledgerPath);
  try {
    await fs.rename(temporaryPath, outputPath);
  } catch (error) {
    await fs.rm(ledgerPath, { force: true });
    throw error;
  }
  console.log(`저장 완료: ${outputPath}`);
  console.log(`검증 완료: ${records.length}개, 중복 0개, A/B/C/D 순위 누락 0개`);
  console.warn("Model E: 공식 미등록으로 점수/순위/TOP 목록을 생성하지 않았습니다.");
} finally {
  await fs.rm(temporaryPath, { force: true });
  await fs.rm(ledgerTemporaryPath, { force: true });
  await fs.rm(lockPath, { force: true });
  await fs.rm(ledgerLockPath, { force: true });
}
