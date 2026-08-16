import fs from "node:fs/promises";
import path from "node:path";
import { calculateTechnicalStrength } from "../lib/technical-strength.mjs";
import { calculateTechnicalModelFeatures } from "../lib/technical-model-features.mjs";
import { calculateTrendStrength } from "../lib/trend-strength.mjs";
import { calculateEntryStrength } from "../lib/entry-strength.mjs";
import { calculateCombinedTechnicalScore } from "../lib/combined-technical-score.mjs";

const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
const kisAppKey = process.env.KIS_APP_KEY;
const kisAppSecret = process.env.KIS_APP_SECRET;
if (!serviceKey || !kisAppKey || !kisAppSecret) throw new Error("필수 API 키가 없습니다.");
const PRICE_URL = "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";

function normalizeItems(items) { return !items ? [] : Array.isArray(items) ? items : [items]; }
async function fetchHistory(code) {
  const query = new URLSearchParams({ resultType: "json", pageNo: "1", numOfRows: "260", likeSrtnCd: code });
  const response = await fetch(`${PRICE_URL}?serviceKey=${serviceKey}&${query}`);
  if (!response.ok) throw new Error(`${code} 일봉 조회 실패: HTTP ${response.status}`);
  const payload = await response.json();
  const items = normalizeItems(payload?.response?.body?.items?.item);
  if (items.length < 120) throw new Error(`${code} 장기 일봉 부족: ${items.length}개`);
  return items.sort((a, b) => String(b.basDt).localeCompare(String(a.basDt)));
}

async function getToken() {
  const response = await fetch("https://openapi.koreainvestment.com:9443/oauth2/tokenP", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials", appkey: kisAppKey, appsecret: kisAppSecret }) });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`KIS 토큰 발급 실패: ${data.msg1 ?? response.status}`);
  return data.access_token;
}
async function getRealtime(code, token) {
  const response = await fetch(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`, { headers: { "Content-Type": "application/json", authorization: `Bearer ${token}`, appkey: kisAppKey, appsecret: kisAppSecret, tr_id: "FHKST01010100" } });
  const data = await response.json();
  if (!response.ok || !data.output) throw new Error(`${code} 실시간 시세 실패`);
  return { price: Number(data.output.stck_prpr), rate: Number(data.output.prdy_ctrt), volume: Number(data.output.acml_vol), high: Number(data.output.stck_hgpr), low: Number(data.output.stck_lwpr) };
}

function round(value) { return value == null ? null : Number(value.toFixed(2)); }
function statistics(items, key) {
  const values = items.map((item) => item[key]);
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const distribution = { "0-20": 0, "21-40": 0, "41-60": 0, "61-80": 0, "81-100": 0 };
  for (const value of values) {
    if (value <= 20) distribution["0-20"] += 1;
    else if (value <= 40) distribution["21-40"] += 1;
    else if (value <= 60) distribution["41-60"] += 1;
    else if (value <= 80) distribution["61-80"] += 1;
    else distribution["81-100"] += 1;
  }
  return { average: round(mean), median: round((sorted[14] + sorted[15]) / 2), minimum: sorted[0], maximum: sorted.at(-1), standardDeviation: round(Math.sqrt(values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length)), distribution };
}

const previous = JSON.parse(await fs.readFile(path.join(process.cwd(), "data", "technical-validation-sample.json"), "utf8"));
let token = null;
let realtimeError = null;
try { token = await getToken(); } catch (error) { realtimeError = error instanceof Error ? error.message : String(error); console.warn(realtimeError); }
const comparisons = [];

for (const [index, sample] of previous.results.entries()) {
  console.log(`[${index + 1}/30] ${sample.code} ${sample.name}`);
  const history = await fetchHistory(sample.code);
  const realtime = token ? await getRealtime(sample.code, token) : null;
  const modelA = calculateTechnicalStrength(history, realtime);
  const features = calculateTechnicalModelFeatures(history, realtime);
  const modelB = calculateTrendStrength(features);
  const modelC = calculateEntryStrength(features);
  const combinedTechnicalScore = calculateCombinedTechnicalScore(modelB.trendStrength, modelC.entryStrength);
  comparisons.push({
    code: sample.code, name: sample.name, market: sample.market,
    currentPrice: features.currentPrice, dailyChangeRate: round(features.dailyChangeRate),
    technicalStrength: modelA.finalTechnicalScore,
    trendStrength: modelB.trendStrength,
    entryStrength: modelC.entryStrength,
    combinedTechnicalScore,
    rsi: round(features.rsi), momentum: round(features.momentum20), volumeRatio: round(features.volumeRatio), position52w: round(features.position52w),
    riskFlags: modelC.riskFlags, riskPenalty: modelC.riskPenalty,
    trendComponents: modelB.components, entryComponents: modelC.components,
  });
}

const rankA = new Map([...comparisons].sort((a, b) => b.technicalStrength - a.technicalStrength).map((item, index) => [item.code, index + 1]));
const rankD = new Map([...comparisons].sort((a, b) => b.combinedTechnicalScore - a.combinedTechnicalScore).map((item, index) => [item.code, index + 1]));
for (const item of comparisons) {
  item.modelARank = rankA.get(item.code);
  item.modelDRank = rankD.get(item.code);
  item.rankChange = item.modelARank - item.modelDRank;
}
comparisons.sort((a, b) => b.combinedTechnicalScore - a.combinedTechnicalScore);

const summaryItem = (item) => ({ code: item.code, name: item.name, technicalStrength: item.technicalStrength, trendStrength: item.trendStrength, entryStrength: item.entryStrength, combinedTechnicalScore: item.combinedTechnicalScore, dailyChangeRate: item.dailyChangeRate, modelARank: item.modelARank, modelDRank: item.modelDRank, rankChange: item.rankChange, riskFlags: item.riskFlags });
const cases = {
  highAToLowD: comparisons.filter((item) => item.technicalStrength >= 70 && item.combinedTechnicalScore <= item.technicalStrength - 20).map(summaryItem),
  lowAToHighD: comparisons.filter((item) => item.technicalStrength < 50 && item.combinedTechnicalScore >= item.technicalStrength + 15).map(summaryItem),
  highTrendLowEntry: comparisons.filter((item) => item.trendStrength >= 70 && item.entryStrength <= 40).map(summaryItem),
  highEntryLowTrend: comparisons.filter((item) => item.entryStrength >= 70 && item.trendStrength <= 40).map(summaryItem),
  fallingWithHighA: comparisons.filter((item) => item.dailyChangeRate < 0 && item.technicalStrength >= 70).map(summaryItem),
  overheatedWithHighD: comparisons.filter((item) => (item.riskFlags.overbought || item.riskFlags.extendedFromMA20 || item.dailyChangeRate >= 10) && item.combinedTechnicalScore >= 70).map(summaryItem),
};
const output = {
  generatedAt: new Date().toISOString(), dataMode: token ? "realtime-plus-daily-history" : "daily-close-fallback", realtimeError,
  hypotheses: { trend: "MA structure 35%, persistence 25%, momentum 20%, MACD 10%, 52-week position 10%", entry: "price action 25%, volume confirmation 20%, short momentum 20%, RSI/MACD turning 20%, MA integrity 15%, capped risk penalty", combined: "trendStrength * entryStrength / 100" },
  statistics: { modelA: statistics(comparisons, "technicalStrength"), modelB: statistics(comparisons, "trendStrength"), modelC: statistics(comparisons, "entryStrength"), modelD: statistics(comparisons, "combinedTechnicalScore") },
  cases,
  results: comparisons,
};
const outputPath = path.join(process.cwd(), "data", "technical-model-comparison-sample.json");
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`완료: ${outputPath}`);
console.log(JSON.stringify(output.statistics, null, 2));
