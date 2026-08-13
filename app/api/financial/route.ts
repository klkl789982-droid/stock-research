import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";

type CorpItem = {
  corp_code: string;
  corp_name: string;
  stock_code: string;
};

function getTagValue(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
  return match ? match[1].trim() : "";
}
let corpCodeCache:
  | Record<
      string,
      {
        corp_code: string;
        corp_name: string;
        stock_code: string;
      }
    >
  | null = null;
async function findCorpCode(apiKey: string, stockCode: string) {
  const response = await fetch(
  `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`,
  {next: { revalidate: 86400 }}
);

  if (!response.ok) {
    throw new Error("DART 기업코드 파일을 불러오지 못했습니다.");
  }

  const buffer = await response.arrayBuffer();

  const zip = await JSZip.loadAsync(buffer);
  const xmlFile = zip.file("CORPCODE.xml");

  if (!xmlFile) {
    throw new Error("CORPCODE.xml 파일을 찾지 못했습니다.");
  }

  const xml = await xmlFile.async("string");

  const lists = xml.match(/<list>[\s\S]*?<\/list>/g) ?? [];

  if (!corpCodeCache) {
  corpCodeCache = {};

  for (const itemXml of lists) {
    const item: CorpItem = {
      corp_code: getTagValue(itemXml, "corp_code"),
      corp_name: getTagValue(itemXml, "corp_name"),
      stock_code: getTagValue(itemXml, "stock_code"),
    };

    if (item.stock_code) {
      corpCodeCache[item.stock_code] = item;
    }
  }
}

return corpCodeCache[stockCode] ?? null;
}

export async function GET(request: NextRequest) {
  const apiKey = process.env.DART_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "DART_API_KEY가 설정되지 않았습니다." },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(request.url);
  const stockCode = searchParams.get("code");

  if (!stockCode) {
    return NextResponse.json(
      { error: "종목코드가 필요합니다." },
      { status: 400 }
    );
  }

  try {
    const company = await findCorpCode(apiKey, stockCode);

    if (!company) {
      return NextResponse.json(
        { error: "DART 기업코드를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    const year = "2025";

const financialUrl =
  `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json` +
  `?crtfc_key=${apiKey}` +
  `&corp_code=${company.corp_code}` +
  `&bsns_year=${year}` +
  `&reprt_code=11011` +
  `&fs_div=CFS`;

const financialResponse = await fetch(financialUrl, {
  next: { revalidate: 3600 },
});

const financialData = await financialResponse.json();

if (financialData.status !== "000") {
  return NextResponse.json(
    {
      error: "DART 재무제표 조회에 실패했습니다.",
      dartStatus: financialData.status,
      dartMessage: financialData.message,
    },
    { status: 500 }
  );
}

const list = financialData.list ?? [];
console.log(
  "이자 관련 계정:",
  list
    .filter((row: any) =>
      row.account_nm?.includes("이자") ||
      row.account_nm?.includes("금융")
    )
    .map((row: any) => ({
      account_nm: row.account_nm,
      amount: row.thstrm_amount,
    }))
);
console.log(
  "현금흐름표 계정:",
  list
    .filter((row: any) => row.sj_div === "CF")
    .map((row: any) => ({
      account_nm: row.account_nm,
      amount: row.thstrm_amount,
    }))
);
function findAmount(names: string[]) {
  const item = list.find((row: any) =>
    names.includes(row.account_nm)
  );

  if (!item) return null;

  const raw = item.thstrm_amount;

  if (!raw) return null;

  return Number(String(raw).replace(/,/g, ""));
}
function findThreeYearAmounts(names: string[]) {
  const item = list.find((row: any) =>
    names.includes(row.account_nm)
  );

  if (!item) return null;

  const current = item.thstrm_amount
    ? Number(String(item.thstrm_amount).replace(/,/g, ""))
    : null;

  const previous2 = item.bfefrmtrm_amount
    ? Number(String(item.bfefrmtrm_amount).replace(/,/g, ""))
    : null;

  return {
    current,
    previous2,
  };
}

function calculateCAGR(
  current: number | null,
  previous2: number | null
) {
  if (
    current === null ||
    previous2 === null ||
    current <= 0 ||
    previous2 <= 0
  ) {
    return null;
  }

  return (Math.pow(current / previous2, 1 / 2) - 1) * 100;
}

const revenue3Y = findThreeYearAmounts([
  "매출액",
  "수익(매출액)",
  "영업수익",
]);

const operatingProfit3Y = findThreeYearAmounts([
  "영업이익",
  "영업이익(손실)",
]);
const eps3Y = findThreeYearAmounts([
  "기본주당이익",
  "희석주당이익",
  "주당순이익",
  "EPS",
]);
const revenueCagr = revenue3Y
  ? calculateCAGR(revenue3Y.current, revenue3Y.previous2)
  : null;

const operatingProfitCagr = operatingProfit3Y
  ? calculateCAGR(
      operatingProfit3Y.current,
      operatingProfit3Y.previous2
    )
  : null;
  const epsCagr = eps3Y
  ? calculateCAGR(
      eps3Y.current,
      eps3Y.previous2
    )
  : null;
const revenue = findAmount(["매출액", "수익(매출액)", "영업수익"]);
const operatingProfit = findAmount(["영업이익", "영업이익(손실)"]);
const netIncome = findAmount([
  "당기순이익",
  "당기순이익(손실)",
  "연결당기순이익",
]);

const interestExpense = findAmount([
  "이자비용",
  "금융비용",
  "이자비용(금융원가)",
  "이자의 지급",
]);

const interestCoverage =
  operatingProfit != null &&
  interestExpense != null &&
  interestExpense > 0
    ? operatingProfit / interestExpense
    : null;
    const operatingCashFlow = findAmount([
  "영업활동으로 인한 현금흐름",
  "영업활동현금흐름",
]);

const capexTangible = findAmount([
  "유형자산의 취득",
]);

const capexIntangible = findAmount([
  "무형자산의 취득",
]);

const fcf =
  operatingCashFlow != null
    ? operatingCashFlow -
      (capexTangible ?? 0) -
      (capexIntangible ?? 0)
    : null;
const assets = findAmount(["자산총계"]);
const liabilities = findAmount(["부채총계"]);
const equity = findAmount(["자본총계"]);

return NextResponse.json({
  success: true,

  stockCode,
  corpCode: company.corp_code,
  corpName: company.corp_name,

  year,

 revenue,
operatingProfit,
netIncome,
revenueCagr,
operatingProfitCagr,
epsCagr,

interestExpense,
interestCoverage,

operatingCashFlow,
fcf,

assets,
liabilities,
equity,
});
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "DART 기업코드 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}