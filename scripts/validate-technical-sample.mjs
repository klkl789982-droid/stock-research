import fs from "node:fs/promises";
import path from "node:path";
import { calculateTechnicalStrength } from "../lib/technical-strength.mjs";

const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
const kisAppKey = process.env.KIS_APP_KEY;
const kisAppSecret = process.env.KIS_APP_SECRET;

if (!serviceKey || !kisAppKey || !kisAppSecret) {
  throw new Error("DATA_GO_KR_SERVICE_KEY, KIS_APP_KEY, KIS_APP_SECRET가 필요합니다.");
}

const PRICE_URL = "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";
const PAGE_SIZE = 1000;

function apiUrl(params) {
  return `${PRICE_URL}?serviceKey=${serviceKey}&${new URLSearchParams({ ...params, resultType: "json" })}`;
}

function normalizeItems(items) {
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

async function fetchPricePage(params, pageNo = 1, numOfRows = PAGE_SIZE) {
  const response = await fetch(apiUrl({ ...params, pageNo: String(pageNo), numOfRows: String(numOfRows) }));
  if (!response.ok) throw new Error(`주식시세 API 실패: HTTP ${response.status}`);
  const payload = await response.json();
  const body = payload?.response?.body;
  if (!body) throw new Error(`주식시세 API 응답 오류: ${payload?.response?.header?.resultMsg ?? "body 없음"}`);
  return { items: normalizeItems(body.items?.item), totalCount: Number(body.totalCount ?? 0) };
}

async function fetchAllForDate(date) {
  const first = await fetchPricePage({ basDt: date });
  const items = [...first.items];
  const pages = Math.ceil(first.totalCount / PAGE_SIZE);
  for (let page = 2; page <= pages; page += 1) items.push(...(await fetchPricePage({ basDt: date }, page)).items);
  return items;
}

function selectAlternating(pool, quota, selected) {
  const up = pool.filter((stock) => stock.changeRate >= 0).sort((a, b) => b.changeRate - a.changeRate);
  const down = pool.filter((stock) => stock.changeRate < 0).sort((a, b) => a.changeRate - b.changeRate);
  const queues = [up, down];
  let cursor = 0;
  while (cursor < quota && queues.some((queue) => queue.length > 0)) {
    const queue = queues[cursor % 2];
    let stock = queue.shift();
    while (stock && selected.has(stock.code)) stock = queue.shift();
    if (stock) { selected.set(stock.code, stock); cursor += 1; }
    else queues.reverse();
  }
}

function selectMarketSample(stocks) {
  const selected = new Map();
  const byCap = [...stocks].sort((a, b) => b.marketCap - a.marketCap);
  const third = Math.ceil(byCap.length / 3);
  const large = byCap.slice(0, third);
  const medium = byCap.slice(third, third * 2);
  const byLiquidity = [...stocks].sort((a, b) => b.averageTradingValue20d - a.averageTradingValue20d);
  const quarter = Math.ceil(byLiquidity.length / 4);
  selectAlternating(large, 4, selected);
  selectAlternating(medium, 4, selected);
  selectAlternating(byLiquidity.slice(0, quarter), 4, selected);
  selectAlternating(byLiquidity.slice(-quarter), 3, selected);
  selectAlternating(byCap, 15 - selected.size, selected);
  return [...selected.values()].slice(0, 15);
}

async function getKisToken() {
  const response = await fetch("https://openapi.koreainvestment.com:9443/oauth2/tokenP", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: kisAppKey, appsecret: kisAppSecret }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`KIS 토큰 발급 실패: ${data.msg1 ?? response.status}`);
  return data.access_token;
}

async function getRealtimePrice(code, token) {
  const response = await fetch(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`, {
    headers: { "Content-Type": "application/json", authorization: `Bearer ${token}`, appkey: kisAppKey, appsecret: kisAppSecret, tr_id: "FHKST01010100" },
  });
  const data = await response.json();
  if (!response.ok || !data.output) throw new Error(`${code} KIS 시세 실패: ${data.msg1 ?? response.status}`);
  return { price: Number(data.output.stck_prpr), change: Number(data.output.prdy_vrss), rate: Number(data.output.prdy_ctrt), volume: Number(data.output.acml_vol), high: Number(data.output.stck_hgpr), low: Number(data.output.stck_lwpr) };
}

function round(value, digits = 2) {
  return value == null ? null : Number(value.toFixed(digits));
}

const universePath = path.join(process.cwd(), "data", "universe.json");
const universe = JSON.parse(await fs.readFile(universePath, "utf8"));
const latestRows = await fetchAllForDate(universe.latestTradingDate);
const latestByCode = new Map(latestRows.map((row) => [String(row.srtnCd).replace(/^A/, ""), row]));
const candidates = universe.stocks.map((stock) => {
  const latest = latestByCode.get(stock.code);
  return { ...stock, currentPrice: Number(latest?.clpr ?? 0), changeRate: Number(latest?.fltRt ?? 0) };
}).filter((stock) => stock.currentPrice > 0);
const sample = ["KOSPI", "KOSDAQ"].flatMap((market) => selectMarketSample(candidates.filter((stock) => stock.market === market)));

if (sample.length !== 30) throw new Error(`샘플이 ${sample.length}개만 선정됐습니다.`);

let token = null;
let realtimeError = null;

try {
  token = await getKisToken();
} catch (error) {
  realtimeError = error instanceof Error ? error.message : String(error);
  console.warn(`실시간 시세를 사용할 수 없어 최신 일봉 fallback을 사용합니다: ${realtimeError}`);
}
const results = [];

for (const [index, stock] of sample.entries()) {
  console.log(`[${index + 1}/30] ${stock.code} ${stock.name}`);
  const historyPage = await fetchPricePage({ likeSrtnCd: stock.code }, 1, 260);
  const realtime = token ? await getRealtimePrice(stock.code, token) : null;
  const history = historyPage.items.sort((a, b) => String(b.basDt).localeCompare(String(a.basDt)));
  const technical = calculateTechnicalStrength(history, realtime);
  const latest = history[0];
  results.push({
    code: stock.code,
    name: stock.name,
    market: stock.market,
    currentPrice: realtime?.price ?? Number(latest.clpr),
    dailyChangeRate: realtime?.rate ?? Number(latest.fltRt),
    technicalStrength: technical.finalTechnicalScore,
    rsi: round(technical.rsi),
    macd: round(technical.macd),
    signal: round(technical.signal),
    histogram: round(technical.histogram),
    volumeRatio: round(technical.volumeRatio),
    priceMomentum: round(technical.priceMomentum),
    position52w: round(technical.position52w),
    atrPercent: round(technical.atrPercent),
    volatility20: round(technical.volatility20),
    overheatingPenalty: technical.penalty,
    penaltyReasons: technical.penaltyReasons,
    reversalBonus: technical.reversalBonus,
    components: Object.fromEntries(Object.entries(technical.components).map(([key, value]) => [key, round(value)])),
    weightedContributions: Object.fromEntries(Object.entries(technical.weightedContributions).map(([key, value]) => [key, round(value)])),
  });
}

results.sort((a, b) => b.technicalStrength - a.technicalStrength);
const scores = results.map((result) => result.technicalStrength);
const sortedScores = [...scores].sort((a, b) => a - b);
const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
const median = (sortedScores[14] + sortedScores[15]) / 2;
const standardDeviation = Math.sqrt(scores.reduce((sum, score) => sum + Math.pow(score - average, 2), 0) / scores.length);
const distribution = { "0-20": 0, "21-40": 0, "41-60": 0, "61-80": 0, "81-100": 0 };
for (const score of scores) {
  if (score <= 20) distribution["0-20"] += 1;
  else if (score <= 40) distribution["21-40"] += 1;
  else if (score <= 60) distribution["41-60"] += 1;
  else if (score <= 80) distribution["61-80"] += 1;
  else distribution["81-100"] += 1;
}

const fallingHighScores = results.filter((item) => item.dailyChangeRate < 0 && item.technicalStrength >= 70).map((item) => ({ code: item.code, name: item.name, dailyChangeRate: item.dailyChangeRate, technicalStrength: item.technicalStrength }));
const overheatedHighScores = results.filter((item) => item.overheatingPenalty > 0 && item.technicalStrength >= 80).map((item) => ({ code: item.code, name: item.name, penalty: item.overheatingPenalty, technicalStrength: item.technicalStrength }));
const dominantIndicators = results.flatMap((item) => {
  const entries = Object.entries(item.weightedContributions);
  const base = entries.reduce((sum, [, value]) => sum + value, 0);
  const [indicator, contribution] = entries.sort((a, b) => b[1] - a[1])[0];
  return base > 0 && contribution / base >= 0.45 ? [{ code: item.code, name: item.name, indicator, share: round((contribution / base) * 100) }] : [];
});
const largestBin = Math.max(...Object.values(distribution));
const anomalies = {
  clusteredScores: largestBin >= 18,
  scoresAbove90: results.filter((item) => item.technicalStrength >= 90).length,
  fallingHighScores,
  overheatedHighScores,
  dominantIndicators,
};

const output = {
  generatedAt: new Date().toISOString(),
  sourceUniverseGeneratedAt: universe.generatedAt,
  latestTradingDate: universe.latestTradingDate,
  dataMode: token ? "realtime-plus-daily-history" : "daily-close-fallback",
  realtimeError,
  sampling: { method: "시장별 15개, 시총 상위/중간 및 거래대금 상위/하위 층화, 상승·하락 교차 선정", sampleSize: 30, kospi: 15, kosdaq: 15 },
  statistics: { average: round(average), median: round(median), minimum: Math.min(...scores), maximum: Math.max(...scores), standardDeviation: round(standardDeviation), distribution },
  anomalies,
  results,
};

const outputPath = path.join(process.cwd(), "data", "technical-validation-sample.json");
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`완료: ${outputPath}`);
console.log(JSON.stringify(output.statistics, null, 2));
