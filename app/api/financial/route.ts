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

async function findCorpCode(apiKey: string, stockCode: string) {
  const response = await fetch(
  `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`,
  { cache: "no-store" }
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

  for (const itemXml of lists) {
    const item: CorpItem = {
      corp_code: getTagValue(itemXml, "corp_code"),
      corp_name: getTagValue(itemXml, "corp_name"),
      stock_code: getTagValue(itemXml, "stock_code"),
    };

    if (item.stock_code === stockCode) {
      return item;
    }
  }

  return null;
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
  cache: "no-store",
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

function findAmount(names: string[]) {
  const item = list.find((row: any) =>
    names.includes(row.account_nm)
  );

  if (!item) return null;

  const raw = item.thstrm_amount;

  if (!raw) return null;

  return Number(String(raw).replace(/,/g, ""));
}

const revenue = findAmount(["매출액", "수익(매출액)", "영업수익"]);
const operatingProfit = findAmount(["영업이익", "영업이익(손실)"]);
const netIncome = findAmount([
  "당기순이익",
  "당기순이익(손실)",
  "연결당기순이익",
]);

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