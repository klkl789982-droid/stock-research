import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;

if (!serviceKey) {
  console.error("DATA_GO_KR_SERVICE_KEY가 없습니다.");
  process.exit(1);
}

const STOCK_PRICE_URL =
  "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";
const MASTER_FILES = [
  {
    market: "KOSPI",
    url: "https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",
    tailLength: 227,
    widths: [2, 1, 4, 4, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 9, 5, 5, 1, 1, 1, 2, 1, 1, 1, 2, 2, 2, 3, 1, 3, 12, 12, 8, 15, 21, 2, 7, 1, 1, 1, 1, 1, 9, 9, 9, 5, 9, 8, 9, 3, 1, 1, 1],
    etpIndex: 12,
    spacIndex: 19,
    preferredIndex: 54,
  },
  {
    market: "KOSDAQ",
    url: "https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip",
    tailLength: 221,
    widths: [2, 1, 4, 4, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 9, 5, 5, 1, 1, 1, 2, 1, 1, 1, 2, 2, 2, 3, 1, 3, 12, 12, 8, 15, 21, 2, 7, 1, 1, 1, 1, 9, 9, 9, 5, 9, 8, 9, 3, 1, 1, 1],
    etpIndex: 8,
    spacIndex: 14,
    preferredIndex: 49,
  },
];

const MIN_MARKET_CAP = 100_000_000_000;
const MIN_AVERAGE_TRADING_VALUE = 2_000_000_000;
const REQUIRED_TRADING_DAYS = 20;
const PAGE_SIZE = 1000;

function normalizeItems(items) {
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

function createUrl(baseUrl, params) {
  const query = new URLSearchParams({
    ...params,
    resultType: "json",
  });

  return `${baseUrl}?serviceKey=${serviceKey}&${query.toString()}`;
}

async function fetchPage(baseUrl, params, pageNo, pageSize = PAGE_SIZE) {
  const response = await fetch(
    createUrl(baseUrl, {
      ...params,
      pageNo: String(pageNo),
      numOfRows: String(pageSize),
    }),
  );

  if (!response.ok) {
    throw new Error(`${baseUrl} 호출 실패: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const header = payload?.response?.header;

  if (header?.resultCode && header.resultCode !== "00") {
    throw new Error(
      `${baseUrl} API 오류: ${header.resultCode} ${header.resultMsg ?? ""}`,
    );
  }

  const body = payload?.response?.body;

  if (!body) {
    throw new Error(`${baseUrl} 응답에 body가 없습니다.`);
  }

  return {
    items: normalizeItems(body.items?.item),
    totalCount: Number(body.totalCount ?? 0),
  };
}

async function fetchAllPages(baseUrl, params = {}) {
  const firstPage = await fetchPage(baseUrl, params, 1);
  const items = [...firstPage.items];
  const totalPages = Math.ceil(firstPage.totalCount / PAGE_SIZE);

  for (let pageNo = 2; pageNo <= totalPages; pageNo += 1) {
    const page = await fetchPage(baseUrl, params, pageNo);
    items.push(...page.items);
  }

  return items;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function fieldAt(tail, widths, targetIndex) {
  const start = widths
    .slice(0, targetIndex)
    .reduce((sum, width) => sum + width, 0);
  return tail.slice(start, start + widths[targetIndex]).trim();
}

async function downloadAndParseMaster(config) {
  const response = await fetch(config.url);

  if (!response.ok) {
    throw new Error(`${config.market} 종목 마스터 다운로드 실패: HTTP ${response.status}`);
  }

  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const masterEntry = Object.values(zip.files).find((entry) =>
    entry.name.endsWith(".mst"),
  );

  if (!masterEntry) {
    throw new Error(`${config.market} ZIP에 .mst 파일이 없습니다.`);
  }

  const bytes = await masterEntry.async("uint8array");
  const contents = new TextDecoder("euc-kr").decode(bytes);

  return contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const prefix = line.slice(0, -config.tailLength);
      const tail = line.slice(-config.tailLength);

      return {
        code: prefix.slice(0, 9).trim().replace(/^A/, ""),
        isinCode: prefix.slice(9, 21).trim(),
        name: prefix.slice(21).trim(),
        market: config.market,
        securityGroupCode: fieldAt(tail, config.widths, 0),
        etpProductCode: fieldAt(tail, config.widths, config.etpIndex),
        isSpac: fieldAt(tail, config.widths, config.spacIndex) === "Y",
        preferredStockCode: fieldAt(
          tail,
          config.widths,
          config.preferredIndex,
        ),
      };
    })
    .filter((stock) => stock.code && stock.name);
}

function countByMarket(stocks) {
  return stocks.reduce(
    (counts, stock) => {
      if (stock.market === "KOSPI") counts.KOSPI += 1;
      if (stock.market === "KOSDAQ") counts.KOSDAQ += 1;
      return counts;
    },
    { KOSPI: 0, KOSDAQ: 0 },
  );
}

function makeStage(stocks) {
  return {
    count: stocks.length,
    byMarket: countByMarket(stocks),
  };
}

console.log("최신 거래일을 확인합니다...");
const latestPricePage = await fetchPage(STOCK_PRICE_URL, {}, 1, 1);

const latestTradingDate = latestPricePage.items[0]?.basDt;

if (!latestTradingDate) {
  throw new Error("최신 거래일을 확인할 수 없습니다.");
}

console.log(`기준 거래일: ${latestTradingDate}`);

const rangeStart = new Date(
  `${latestTradingDate.slice(0, 4)}-${latestTradingDate.slice(4, 6)}-${latestTradingDate.slice(6, 8)}T00:00:00Z`,
);
rangeStart.setUTCDate(rangeStart.getUTCDate() - 45);

console.log("한국투자증권 KOSPI/KOSDAQ 종목 마스터를 수집합니다...");
const masterGroups = await Promise.all(
  MASTER_FILES.map((config) => downloadAndParseMaster(config)),
);
const allStocks = masterGroups.flat();
const allStockCodes = new Set(allStocks.map((stock) => stock.code));
const afterEtf = allStocks.filter(
  (stock) =>
    stock.securityGroupCode !== "EF" &&
    stock.securityGroupCode !== "FE" &&
    stock.etpProductCode !== "1" &&
    stock.etpProductCode !== "2",
);
const afterEtn = afterEtf.filter(
  (stock) => stock.etpProductCode !== "3" && stock.etpProductCode !== "4",
);
const afterSpac = afterEtn.filter((stock) => !stock.isSpac);
const afterPreferred = afterSpac.filter(
  (stock) => stock.preferredStockCode === "0",
);

console.log("최근 시가총액과 20거래일 거래대금을 수집합니다...");
const priceRows = await fetchAllPages(STOCK_PRICE_URL, {
  beginBasDt: formatDate(rangeStart),
  endBasDt: latestTradingDate,
});

const pricesByCode = new Map();

for (const row of priceRows) {
  const code = String(row.srtnCd ?? "").replace(/^A/, "");
  if (!allStockCodes.has(code)) continue;

  const rows = pricesByCode.get(code) ?? [];
  rows.push(row);
  pricesByCode.set(code, rows);
}

const enrichedStocks = afterPreferred.map((stock) => {
  const rows = (pricesByCode.get(stock.code) ?? [])
    .filter((row) => row.basDt && toNumber(row.trPrc) !== null)
    .sort((a, b) => String(b.basDt).localeCompare(String(a.basDt)));
  const latestRow = rows.find((row) => row.basDt === latestTradingDate) ?? rows[0];
  const recent20 = rows.slice(0, REQUIRED_TRADING_DAYS);
  const marketCap = toNumber(latestRow?.mrktTotAmt);
  const averageTradingValue =
    recent20.length === REQUIRED_TRADING_DAYS
      ? recent20.reduce((sum, row) => sum + Number(row.trPrc), 0) /
        REQUIRED_TRADING_DAYS
      : null;

  return {
    ...stock,
    marketCap,
    averageTradingValue20d: averageTradingValue,
    tradingDays: recent20.length,
  };
});

const afterMarketCap = enrichedStocks.filter(
  (stock) => stock.marketCap !== null && stock.marketCap >= MIN_MARKET_CAP,
);
const finalUniverse = afterMarketCap.filter(
  (stock) =>
    stock.tradingDays === REQUIRED_TRADING_DAYS &&
    stock.averageTradingValue20d !== null &&
    stock.averageTradingValue20d >= MIN_AVERAGE_TRADING_VALUE,
);

const stages = {
  all: makeStage(allStocks),
  afterEtf: makeStage(afterEtf),
  afterEtn: makeStage(afterEtn),
  afterSpac: makeStage(afterSpac),
  afterPreferred: makeStage(afterPreferred),
  afterMarketCap: makeStage(afterMarketCap),
  afterTradingValue: makeStage(finalUniverse),
};

const result = {
  generatedAt: new Date().toISOString(),
  latestTradingDate,
  criteria: {
    markets: ["KOSPI", "KOSDAQ"],
    minimumMarketCap: MIN_MARKET_CAP,
    minimumAverageTradingValue20d: MIN_AVERAGE_TRADING_VALUE,
    requiredTradingDays: REQUIRED_TRADING_DAYS,
    etfFields: "securityGroupCode EF/FE 또는 etpProductCode 1/2",
    etnFields: "etpProductCode 3/4",
    spacField: "isSpac Y",
    preferredStockField: "preferredStockCode 1/2 제외",
  },
  stages,
  finalCount: finalUniverse.length,
  stocks: finalUniverse,
};

const outputPath = path.join(process.cwd(), "data", "universe.json");
await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

const labels = [
  ["전체 종목 수", stages.all],
  ["ETF 제거 후", stages.afterEtf],
  ["ETN 제거 후", stages.afterEtn],
  ["스팩 제거 후", stages.afterSpac],
  ["우선주 제거 후", stages.afterPreferred],
  ["시총 필터 후", stages.afterMarketCap],
  ["거래대금 필터 후", stages.afterTradingValue],
];

console.log("\nUniverse 필터 결과");
for (const [label, stage] of labels) {
  console.log(
    `${label}: ${stage.count} (KOSPI ${stage.byMarket.KOSPI}, KOSDAQ ${stage.byMarket.KOSDAQ})`,
  );
}
console.log(`\n최종 후보군 수: ${finalUniverse.length}`);
console.log(`저장 위치: ${outputPath}`);
