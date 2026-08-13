"use client";

import { useState } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
export default function Home() {
  const [query, setQuery] = useState("");
  const [searchedStock, setSearchedStock] = useState<string | null>(null);
const [activeTab, setActiveTab] = useState<string | null>(null);
const [stockInfo, setStockInfo] = useState<any>(null);
const [priceInfo, setPriceInfo] = useState<any>(null);
const [priceHistory, setPriceHistory] = useState<any[]>([]);
const [financialInfo, setFinancialInfo] = useState<any>(null);
  const formatEok = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "-";

  return `${(Number(value) / 100000000).toLocaleString("ko-KR", {
    maximumFractionDigits: 1,
  })}억`;
};
async function handleSearch() {
  if (query.trim() === "") return;

  try {
    const response = await fetch(
      `/api/stock?query=${encodeURIComponent(query)}`
    );

    const data = await response.json();

    if (data.items && data.items.length > 0) {
  setStockInfo(data.items[0]);
  setSearchedStock(data.items[0].itmsNm);

  const stockCode = data.items[0].srtnCd.replace(/^A/, "");

  const priceResponse = await fetch(
    `/api/price?code=${stockCode}`
  );

  const priceData = await priceResponse.json();

  if (priceData.items && priceData.items.length > 0) {
  setPriceInfo(priceData.items[0]);
  setPriceHistory(priceData.items);

  const financialResponse = await fetch(
    `/api/financial?code=${stockCode}`
  );

  const financialData = await financialResponse.json();

  if (financialData.success) {
    setFinancialInfo(financialData);
  } else {
    setFinancialInfo(null);
  }
}
} else {
      alert("종목을 찾을 수 없습니다.");
    }
  } catch (error) {
    console.error(error);
    alert("검색 중 오류가 발생했습니다.");
  }
}
const ma5 =
  priceHistory.length >= 5
    ? priceHistory
        .slice(0, 5)
        .reduce((sum, item) => sum + Number(item.clpr), 0) / 5
    : null;

const ma20 =
  priceHistory.length >= 20
    ? priceHistory
        .slice(0, 20)
        .reduce((sum, item) => sum + Number(item.clpr), 0) / 20
    : null;
const ma20Prev =
  priceHistory.length >= 21
    ? priceHistory
        .slice(1, 21)
        .reduce((sum, item) => sum + Number(item.clpr), 0) / 20
    : null;

const ma20Slope =
  ma20 !== null && ma20Prev !== null
    ? ((ma20 - ma20Prev) / ma20Prev) * 100
    : null;
    const recent10 = priceHistory.slice(0, 10);
const previous10 = priceHistory.slice(10, 20);

const recentHigh =
  recent10.length === 10
    ? Math.max(...recent10.map((item) => Number(item.hipr)))
    : null;

const previousHigh =
  previous10.length === 10
    ? Math.max(...previous10.map((item) => Number(item.hipr)))
    : null;

const recentLow =
  recent10.length === 10
    ? Math.min(...recent10.map((item) => Number(item.lopr)))
    : null;

const previousLow =
  previous10.length === 10
    ? Math.min(...previous10.map((item) => Number(item.lopr)))
    : null;

const highLowDirection =
  recentHigh !== null &&
  previousHigh !== null &&
  recentLow !== null &&
  previousLow !== null
    ? `고점 ${recentHigh > previousHigh ? "↑" : recentHigh < previousHigh ? "↓" : "→"} · 저점 ${
        recentLow > previousLow ? "↑" : recentLow < previousLow ? "↓" : "→"
      }`
    : "-";
const ma60 =
  priceHistory.length >= 60
    ? priceHistory
        .slice(0, 60)
        .reduce((sum, item) => sum + Number(item.clpr), 0) / 60
    : null;

const ma120 =
  priceHistory.length >= 120
    ? priceHistory
        .slice(0, 120)
        .reduce((sum, item) => sum + Number(item.clpr), 0) / 120
    : null;

const ma200 =
  priceHistory.length >= 200
    ? priceHistory
        .slice(0, 200)
        .reduce((sum, item) => sum + Number(item.clpr), 0) / 200
    : null;
const rsi14 =
  priceHistory.length >= 15
    ? (() => {
        let gains = 0;
        let losses = 0;

        for (let i = 0; i < 14; i++) {
          const current = Number(priceHistory[i].clpr);
          const previous = Number(priceHistory[i + 1].clpr);
          const change = current - previous;

          if (change > 0) {
            gains += change;
          } else {
            losses += Math.abs(change);
          }
        }

        const avgGain = gains / 14;
        const avgLoss = losses / 14;

        if (avgLoss === 0) return 100;

        const rs = avgGain / avgLoss;
        return 100 - 100 / (1 + rs);
      })()
    : null;
    function calculateEMAArray(values: number[], period: number) {
  const result: (number | null)[] = Array(values.length).fill(null);

  if (values.length < period) return result;

  const multiplier = 2 / (period + 1);

  let ema =
    values
      .slice(0, period)
      .reduce((sum, value) => sum + value, 0) / period;

  result[period - 1] = ema;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * multiplier + ema * (1 - multiplier);
    result[i] = ema;
  }

  return result;
}

const closes = priceHistory
  .map((item) => Number(item.clpr))
  .reverse();

const ema12Series = calculateEMAArray(closes, 12);
const ema26Series = calculateEMAArray(closes, 26);

const macdSeries: number[] = [];

for (let i = 0; i < closes.length; i++) {
  const ema12Value = ema12Series[i];
  const ema26Value = ema26Series[i];

  if (ema12Value !== null && ema26Value !== null) {
    macdSeries.push(ema12Value - ema26Value);
  }
}

const signalSeries = calculateEMAArray(macdSeries, 9);

const macd =
  macdSeries.length > 0
    ? macdSeries[macdSeries.length - 1]
    : null;

const signal =
  signalSeries.length > 0
    ? signalSeries[signalSeries.length - 1]
    : null;

const histogram =
  macd !== null && signal !== null
    ? macd - signal
    : null;
    console.log("최근 MACD 10개:", macdSeries.slice(-10));
console.log("현재 MACD / Signal / Histogram:", macd, signal, histogram);
const momentum20 =
  priceHistory.length >= 20
    ? (
        ((Number(priceHistory[0].clpr) -
          Number(priceHistory[19].clpr)) /
          Number(priceHistory[19].clpr)) *
        100
      )
    : null;
    const avgVolume20 =
  priceHistory.length >= 20
    ? priceHistory
        .slice(0, 20)
        .reduce((sum, item) => sum + Number(item.trqu), 0) / 20
    : null;

const volumeRatio =
  avgVolume20 !== null && priceHistory.length > 0
    ? (Number(priceHistory[0].trqu) / avgVolume20) * 100
    : null;
    const obv =
  priceHistory.length >= 2
    ? (() => {
        const ordered = [...priceHistory].reverse();

        let value = 0;

        for (let i = 1; i < ordered.length; i++) {
          const currentClose = Number(ordered[i].clpr);
          const previousClose = Number(ordered[i - 1].clpr);
          const currentVolume = Number(ordered[i].trqu);

          if (currentClose > previousClose) {
            value += currentVolume;
          } else if (currentClose < previousClose) {
            value -= currentVolume;
          }
        }

        return value;
      })()
    : null;
    const rsiSignal =
  rsi14 === null
    ? "-"
    : rsi14 >= 70
    ? "과매수"
    : rsi14 <= 30
    ? "과매도"
    : "중립";

const macdSignal =
  macd !== null && signal !== null
    ? macd > signal
      ? "상승"
      : "하락"
    : "-";

const momentumSignal =
  momentum20 !== null
    ? momentum20 > 10
      ? "강세"
      : momentum20 > 0
      ? "약강세"
      : "약세"
    : "-";

const score =
  (rsi14 !== null && rsi14 > 50 ? 1 : 0) +
  (macd !== null && signal !== null && macd > signal ? 1 : 0) +
  (momentum20 !== null && momentum20 > 0 ? 1 : 0) +
  (ma20Slope !== null && ma20Slope > 0 ? 1 : 0);
  const atr14 =
  priceHistory.length >= 15
    ? (() => {
        const ordered = [...priceHistory].reverse();

        const trueRanges: number[] = [];

        for (let i = 1; i < ordered.length; i++) {
          const high = Number(ordered[i].hipr);
          const low = Number(ordered[i].lopr);
          const prevClose = Number(ordered[i - 1].clpr);

          const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
          );

          trueRanges.push(tr);
        }

        const recent14 = trueRanges.slice(-14);

    
        return (
          recent14.reduce((sum, value) => sum + value, 0) /
          recent14.length
        );
      })()
    : null;
    const atrPercent =
  atr14 !== null && priceInfo !== null && Number(priceInfo.clpr) > 0
    ? (atr14 / Number(priceInfo.clpr)) * 100
    : null;
    const volatility20 =
  priceHistory.length >= 21
    ? (() => {
        const returns: number[] = [];

        for (let i = 0; i < 20; i++) {
          const current = Number(priceHistory[i].clpr);
          const previous = Number(priceHistory[i + 1].clpr);

          returns.push((current - previous) / previous);
        }

        const mean =
          returns.reduce((sum, value) => sum + value, 0) /
          returns.length;

        const variance =
          returns.reduce(
            (sum, value) => sum + Math.pow(value - mean, 2),
            0
          ) / returns.length;

        return Math.sqrt(variance) * 100;
      })()
    : null;
    const ma20Distance =
  priceInfo !== null &&
  ma20 !== null &&
  ma20 > 0
    ? ((Number(priceInfo.clpr) - ma20) / ma20) * 100
    : null;
    const high52w =
  priceHistory.length > 0
    ? Math.max(...priceHistory.map((item) => Number(item.hipr)))
    : null;

const low52w =
  priceHistory.length > 0
    ? Math.min(...priceHistory.map((item) => Number(item.lopr)))
    : null;

const position52w =
  priceInfo !== null &&
  high52w !== null &&
  low52w !== null &&
  high52w > low52w
    ? ((Number(priceInfo.clpr) - low52w) / (high52w - low52w)) * 100
    : null;
    const drawdown52w =
  priceInfo !== null &&
  high52w !== null &&
  high52w > 0
    ? ((Number(priceInfo.clpr) - high52w) / high52w) * 100
    : null;
   const chartSource = priceHistory
  .slice(0, 120)
  .reverse();

const chartDataFull = chartSource.map((item, index, arr) => {
  const close = Number(item.clpr);

  const ma5 =
    index >= 4
      ? arr
          .slice(index - 4, index + 1)
          .reduce((sum, v) => sum + Number(v.clpr), 0) / 5
      : null;

  const ma20 =
    index >= 19
      ? arr
          .slice(index - 19, index + 1)
          .reduce((sum, v) => sum + Number(v.clpr), 0) / 20
      : null;

  const ma60 =
    index >= 59
      ? arr
          .slice(index - 59, index + 1)
          .reduce((sum, v) => sum + Number(v.clpr), 0) / 60
      : null;

  return {
    date: item.basDt?.slice(4, 8),
    close,
    ma5,
    ma20,
    ma60,
    volume: Number(item.trqu),
    up: Number(item.clpr) >= Number(item.mkp),
  };
});

const chartData = chartDataFull.slice(-60);
 const crossSignal =
  ma5 !== null && ma20 !== null
    ? ma5 > ma20
      ? "골든크로스"
      : "데드크로스"
    : "-";

const roe =
  financialInfo?.netIncome != null &&
  financialInfo?.equity != null &&
  Number(financialInfo.equity) !== 0
    ? (Number(financialInfo.netIncome) / Number(financialInfo.equity)) * 100
    : null;

const debtRatio =
  financialInfo?.liabilities != null &&
  financialInfo?.equity != null &&
  Number(financialInfo.equity) !== 0
    ? (Number(financialInfo.liabilities) / Number(financialInfo.equity)) * 100
    : null;

return (
    <main className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-md px-5 py-16">
        <h1 className="text-3xl font-bold text-gray-900">
          Stock Research
        </h1>

        <p className="mt-3 text-gray-600">
          주식 데이터를 쉽고 객관적으로 분석합니다.
        </p>

        <div className="mt-10 flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="종목명을 검색하세요"
            className="w-full rounded-xl border border-gray-300 bg-white px-4 py-4 text-gray-900 outline-none"
          />

          <button
  onClick={handleSearch}
  className="whitespace-nowrap rounded-xl bg-gray-900 px-5 py-4 font-medium text-white"
>
  검색
</button>
        </div>

        <p className="mt-4 text-sm text-gray-500">
          종목명 또는 종목코드를 입력하세요.
        </p>

        {searchedStock && (
          <div className="mt-10 rounded-2xl border border-gray-200 bg-white p-5">
            <p className="text-sm text-gray-500">검색 결과</p>

            <h2 className="mt-2 text-2xl font-bold text-gray-900">
              {searchedStock}
            </h2>

           <div className="mt-2 space-y-1 text-sm text-gray-600">
  <p>시장 : {stockInfo?.mrktCtg}</p>
  <p>종목코드 : {stockInfo?.srtnCd?.replace(/^A/, "")}</p>
  <p>법인명 : {stockInfo?.corpNm}</p>
  <p>ISIN : {stockInfo?.isinCd}</p>
  <p>
    기준일 :
    {stockInfo?.basDt
      ? `${stockInfo.basDt.slice(0, 4)}-${stockInfo.basDt.slice(4, 6)}-${stockInfo.basDt.slice(6, 8)}`
      : ""}
  </p>
</div>
{priceInfo && (
  <div className="mt-5 rounded-xl bg-gray-50 p-4">
    <p className="text-sm font-semibold text-gray-900">
      최근 시세
    </p>

    <div className="mt-3 space-y-2 text-sm text-gray-700">
      <div className="flex justify-between">
        <span>최근 종가</span>
        <span>{Number(priceInfo.clpr).toLocaleString()}원</span>
      </div>

      <div className="flex justify-between">
        <span>전일 대비</span>
        <span>{Number(priceInfo.vs).toLocaleString()}원</span>
      </div>

      <div className="flex justify-between">
  <span>등락률</span>
  <span>{Number(priceInfo.fltRt).toFixed(2)}%</span>
</div>

      <div className="flex justify-between">
        <span>거래량</span>
        <span>{Number(priceInfo.trqu).toLocaleString()}주</span>
      </div>
      <div className="flex justify-between">
  <span>시가총액</span>
  <span>
    {Math.round(Number(priceInfo.mrktTotAmt) / 100000000).toLocaleString()}억
  </span>
</div>

      <div className="flex justify-between">
        <span>시가</span>
        <span>{Number(priceInfo.mkp).toLocaleString()}원</span>
      </div>

      <div className="flex justify-between">
        <span>고가</span>
        <span>{Number(priceInfo.hipr).toLocaleString()}원</span>
      </div>

      <div className="flex justify-between">
        <span>저가</span>
        <span>{Number(priceInfo.lopr).toLocaleString()}원</span>
      </div>

      <div className="flex justify-between">
        <span>시세 기준일</span>
        <span>
          {priceInfo.basDt
            ? `${priceInfo.basDt.slice(0, 4)}-${priceInfo.basDt.slice(4, 6)}-${priceInfo.basDt.slice(6, 8)}`
            : "-"}
        </span>
      </div>
    </div>
  </div>
)}

            <div className="mt-6 grid grid-cols-3 gap-2">
              <button
  onClick={() => setActiveTab("investor")}
  className="rounded-xl border border-gray-200 px-3 py-3 text-sm"
>
  기업 분석
</button>

              <button
  onClick={() => setActiveTab("trader")}
  className="rounded-xl border border-gray-200 px-3 py-3 text-sm"
>
  시장 분석
</button>

              <button
  onClick={() => setActiveTab("dividend")}
  className="rounded-xl border border-gray-200 px-3 py-3 text-sm"
>
  배당 분석
</button>
            </div>
          </div>
        )}
        {activeTab === "investor" && searchedStock && (
  <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-5">
    <p className="text-sm text-gray-500">Investor View</p>

    <h2 className="mt-1 text-xl font-bold text-gray-900">
      기업 분석
    </h2>

    <section className="mt-8">
  <h3 className="font-semibold text-gray-900">가치평가</h3>

  <div className="mt-3 space-y-2 text-sm">
    <div className="flex justify-between">
      <span>매출액</span>
      <span>{formatEok(financialInfo?.revenue)}</span>
    </div>

    <div className="flex justify-between">
      <span>영업이익</span>
      <span>{formatEok(financialInfo?.operatingProfit)}</span>
    </div>
  </div>
</section>

<section className="mt-8">
  <h3 className="font-semibold text-gray-900">수익성</h3>

  <div className="mt-3 space-y-2 text-sm">
    <div className="flex justify-between">
      <span>순이익</span>
      <span>{formatEok(financialInfo?.netIncome)}</span>
    </div>

    <div className="flex justify-between">
      <span>자본총계</span>
      <span>{formatEok(financialInfo?.equity)}</span>
    </div>
    <div className="flex justify-between">
  <span>ROE</span>
  <span>
    {roe !== null ? `${roe.toFixed(1)}%` : "-"}
  </span>
</div>
  </div>
</section>
<section className="mt-8">
  <h3 className="font-semibold text-gray-900">
    성장성 · 최근 3년
  </h3>

  <div className="mt-3 space-y-2 text-sm">
    <div className="flex justify-between">
      <span>매출 CAGR</span>
      <span>-</span>
    </div>

    <div className="flex justify-between">
      <span>영업이익 CAGR</span>
      <span>-</span>
    </div>

    <div className="flex justify-between">
      <span>EPS CAGR</span>
      <span>-</span>
    </div>
  </div>
</section>
<section className="mt-8">
  <h3 className="font-semibold text-gray-900">
    재무안정성
  </h3>

  <div className="mt-3 space-y-2 text-sm">
    <div className="flex justify-between">
      <span>부채비율</span>
<span>
  {debtRatio !== null ? `${debtRatio.toFixed(1)}%` : "-"}
</span>
    </div>

    <div className="flex justify-between">
      <span>이자보상배율</span>
      <span>-</span>
    </div>

    <div className="flex justify-between">
      <span>FCF</span>
      <span>-</span>
    </div>
  </div>
</section>
<section className="mt-8 border-t border-gray-100 pt-6">
  <h3 className="font-semibold text-gray-900">
    사업 현황 및 전망
  </h3>

  <p className="mt-2 text-sm leading-6 text-gray-500">
    회사가 공식적으로 발표한 가이던스, 공시 및 IR 정보를 표시합니다.
  </p>

  <div className="mt-4 space-y-3 text-sm">
    <div className="flex justify-between gap-4">
      <span className="text-gray-500">신규 사업</span>
      <span>-</span>
    </div>

    <div className="flex justify-between gap-4">
      <span className="text-gray-500">수주 · 계약</span>
      <span>-</span>
    </div>

    <div className="flex justify-between gap-4">
      <span className="text-gray-500">CAPEX · 증설</span>
      <span>-</span>
    </div>

    <div className="flex justify-between gap-4">
      <span className="text-gray-500">회사 가이던스</span>
      <span>-</span>
    </div>

    <div className="flex justify-between gap-4">
      <span className="text-gray-500">예정 이벤트</span>
      <span>-</span>
    </div>
  </div>

  <p className="mt-4 text-xs leading-5 text-gray-400">
    ※ 회사의 공식 공시, IR 자료 및 경영진 발표에 기반한 정보만 표시하며
    자체적인 미래 전망은 제공하지 않습니다.
  </p>
</section>
  </div>
)}
  {activeTab === "trader" && searchedStock && (
  <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-5">
    <p className="text-sm text-gray-500">Trader View</p>

    <h2 className="mt-1 text-xl font-bold text-gray-900">
      시장 분석
    </h2>

    <div className="mt-5 flex gap-2">
      <button className="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white">
        일봉
      </button>

      <button className="rounded-lg border border-gray-200 px-4 py-2 text-sm">
        120분봉
      </button>

</div>

<div className="mt-6 h-80 rounded-xl border border-gray-200 bg-white p-4">
  <ResponsiveContainer width="100%" height="100%">
    <LineChart data={chartData}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="date" />
      <YAxis domain={["dataMin", "dataMax"]} />
      <Tooltip />
<Legend />
     <Line
  type="monotone"
  dataKey="close"
  name="종가"
  stroke="#2563eb"
  dot={false}
/>

<Line
  type="monotone"
  dataKey="ma5"
  name="5일선"
  stroke="#16a34a"
  dot={false}
/>

<Line
  type="monotone"
  dataKey="ma20"
  name="20일선"
  stroke="#dc2626"
  dot={false}
/>

<Line
  type="monotone"
  dataKey="ma60"
  name="60일선"
  stroke="#9333ea"
  dot={false}
/>
    </LineChart>
  </ResponsiveContainer>
</div>
<div className="mt-4 h-48 rounded-xl border border-gray-200 bg-white p-4">
  <div className="mb-2 text-sm font-semibold text-gray-700">
    거래량
  </div>

  <ResponsiveContainer width="100%" height="85%">
    <BarChart data={chartData}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="date" />
      <YAxis
  tickFormatter={(value) => {
    if (value >= 100000000) {
      return `${Math.round(value / 100000000)}억`;
    }

    if (value >= 10000) {
      return `${Math.round(value / 10000)}만`;
    }

    return value.toLocaleString();
  }}
/>
      <Tooltip
  formatter={(value) =>
    `${Number(value).toLocaleString()}주`
  }
/>
      <Bar dataKey="volume">
  {chartData.map((entry, index) => (
    <Cell
      key={index}
      fill={entry.up ? "#ef4444" : "#3b82f6"}
    />
  ))}
</Bar>
    </BarChart>
  </ResponsiveContainer>
</div>
<section className="mt-8">
      <h3 className="font-semibold text-gray-900">
        추세
      </h3>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between">
  <span>5일 이동평균선</span>
  <span>
    {ma5 ? Math.round(ma5).toLocaleString() : "-"}
  </span>
</div>

        <div className="flex justify-between">
          <span>20일 이동평균선</span>
          <span>{ma20 ? Math.round(ma20).toLocaleString() : "-"}</span>
        </div>

        <div className="flex justify-between">
          <span>60일 이동평균선</span>
          <span>{ma60 ? Math.round(ma60).toLocaleString() : "-"}</span>
        </div>

        <div className="flex justify-between">
          <span>120일 이동평균선</span>
          <span>{ma120 ? Math.round(ma120).toLocaleString() : "-"}</span>
        </div>

        <div className="flex justify-between">
          <span>200일 이동평균선</span>
          <span>{ma200 ? Math.round(ma200).toLocaleString() : "-"}</span>
        </div>

        <div className="flex justify-between">
          <span>이동평균선 기울기</span>
          <span>
  {ma20Slope !== null
    ? `${ma20Slope >= 0 ? "+" : ""}${ma20Slope.toFixed(2)}%`
    : "-"}
</span>
        </div>

        <div className="flex justify-between">
  <span>고점 · 저점 방향</span>
  <span>{highLowDirection}</span>
</div>

<div className="flex justify-between">
  <span>이평선 상태</span>
  <span>{crossSignal}</span>
</div>
</div>
    </section>

    <section className="mt-8">
      <h3 className="font-semibold text-gray-900">
        모멘텀
      </h3>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between">
          <span>RSI</span>
          <span>{rsi14 !== null ? rsi14.toFixed(1) : "-"}</span>
        </div>

        <div className="flex justify-between">
  <span>MACD</span>
  <span>{macd !== null ? macd.toFixed(2) : "-"}</span>
</div>
<div className="flex justify-between">
  <span>Signal</span>
  <span>{signal !== null ? signal.toFixed(2) : "-"}</span>
</div>

<div className="flex justify-between">
  <span>Histogram</span>
  <span>{histogram !== null ? histogram.toFixed(2) : "-"}</span>
</div>

        <div className="flex justify-between">
          <span>가격 모멘텀</span>
          <span>
  {momentum20 !== null ? `${momentum20.toFixed(2)}%` : "-"}
</span>
        </div>
      </div>
    </section>

    <section className="mt-8">
      <h3 className="font-semibold text-gray-900">
        거래량
      </h3>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between">
  <span>평균 대비 거래량</span>
  <span>
    {volumeRatio !== null ? `${volumeRatio.toFixed(1)}%` : "-"}
  </span>
</div>

        <div className="flex justify-between">
  <span>OBV</span>
  <span>
    {obv !== null ? Math.round(obv).toLocaleString() : "-"}
  </span>
</div>
      </div>
    </section>
<div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-4">
  <h3 className="font-semibold text-gray-900">
    투자 신호 요약
  </h3>

  <div className="mt-3 space-y-2 text-sm">
    <div className="flex justify-between">
      <span>RSI 상태</span>
      <span>{rsiSignal}</span>
    </div>

    <div className="flex justify-between">
      <span>MACD 상태</span>
      <span>{macdSignal}</span>
    </div>

    <div className="flex justify-between">
      <span>모멘텀</span>
      <span>{momentumSignal}</span>
    </div>

    <div className="flex justify-between font-semibold">
      <span>충족 조건</span>
      <span>{score} / 4</span>
    </div>
  </div>
</div>
    <section className="mt-8">
      <h3 className="font-semibold text-gray-900">
        투자자 수급
      </h3>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between">
          <span>외국인 · 1일</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>외국인 · 5일</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>외국인 · 20일</span>
          <span>-</span>
        </div>

        <div className="mt-4 flex justify-between">
          <span>기관 · 1일</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>기관 · 5일</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>기관 · 20일</span>
          <span>-</span>
        </div>

        <div className="mt-4 flex justify-between">
          <span>프로그램 매매</span>
          <span>-</span>
        </div>

        <div className="flex justify-between text-gray-500">
          <span>개인 수급 · 참고</span>
          <span>-</span>
        </div>
      </div>
    </section>

    <section className="mt-8">
      <h3 className="font-semibold text-gray-900">
        가격 위험 특성
      </h3>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between">
  <span>ATR(14)</span>
  <span>
    {atr14 !== null ? `${Math.round(atr14).toLocaleString()}원` : "-"}
  </span>
</div>
<div className="flex justify-between">
  <span>ATR 비율</span>
  <span>
    {atrPercent !== null ? `${atrPercent.toFixed(2)}%` : "-"}
  </span>
</div>
       <div className="flex justify-between">
  <span>이동평균선 이격도</span>
  <span>
    {ma20Distance !== null
      ? `${ma20Distance >= 0 ? "+" : ""}${ma20Distance.toFixed(2)}%`
      : "-"}
  </span>
</div>

        <div className="flex justify-between">
  <span>20일 변동성</span>
  <span>
    {volatility20 !== null
      ? `${volatility20.toFixed(2)}%`
      : "-"}
  </span>
</div>
<div className="flex justify-between">
  <span>52주 고가</span>
  <span>
    {high52w !== null
      ? `${Math.round(high52w).toLocaleString()}원`
      : "-"}
  </span>
</div>

<div className="flex justify-between">
  <span>52주 저가</span>
  <span>
    {low52w !== null
      ? `${Math.round(low52w).toLocaleString()}원`
      : "-"}
  </span>
</div>

<div className="flex justify-between">
  <span>52주 범위 위치</span>
  <span>
    {position52w !== null
      ? `${position52w.toFixed(1)}%`
      : "-"}
  </span>
</div>
<div className="flex justify-between">
  <span>52주 고점 대비</span>
  <span>
    {drawdown52w !== null
      ? `${drawdown52w.toFixed(1)}%`
      : "-"}
  </span>
</div>
      </div>

      <p className="mt-4 text-xs leading-5 text-gray-400">
        ※ 해당 지표들은 현재 가격 움직임의 상태를 나타내며 향후 주가 방향을 의미하지 않습니다.
      </p>
    </section>
  </div>
)}
{activeTab === "trader" && searchedStock && (
  <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-5">
    <p className="text-sm text-gray-500">Short Signal</p>

    <h2 className="mt-1 text-xl font-bold text-gray-900">
      공매도 관련 시장 데이터
    </h2>

    <section className="mt-6">
      <div className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span>공매도 거래 비중</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>공매도 잔고 비중</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>대차잔고 변화</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>최근 주가 변화</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>최근 거래량 변화</span>
          <span>-</span>
        </div>
      </div>
    </section>

    <section className="mt-8 border-t border-gray-100 pt-6">
      <h3 className="font-semibold text-gray-900">
        숏커버링 관련 관측 조건
      </h3>

      <div className="mt-3 flex justify-between text-sm">
        <span>충족 조건</span>
        <span>- / -</span>
      </div>

      <p className="mt-4 text-xs leading-5 text-gray-400">
        ※ 공매도, 대차, 가격 및 거래량 데이터에서 특정 조건의 동시 발생
        여부를 표시합니다. 향후 주가 상승 또는 숏스퀴즈 발생을 예측하지
        않습니다.
      </p>
    </section>
  </div>
)}
{activeTab === "dividend" && searchedStock && (
  <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-5">
    <p className="text-sm text-gray-500">Dividend View</p>

    <h2 className="mt-1 text-xl font-bold text-gray-900">
      배당 분석
    </h2>

    <section className="mt-8">
      <h3 className="font-semibold text-gray-900">
        배당 현황
      </h3>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between">
          <span>배당수익률</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>DPS</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>배당성향</span>
          <span>-</span>
        </div>
      </div>
    </section>

    <section className="mt-8">
      <h3 className="font-semibold text-gray-900">
        배당 성장
      </h3>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between">
          <span>최근 3년 DPS 변화</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>배당 성장률</span>
          <span>-</span>
        </div>
      </div>
    </section>

    <section className="mt-8">
      <h3 className="font-semibold text-gray-900">
        배당 지속성
      </h3>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between">
          <span>연속 배당 기간</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>최근 배당 중단 여부</span>
          <span>-</span>
        </div>
      </div>
    </section>

    <p className="mt-6 text-xs leading-5 text-gray-400">
      ※ 배당 관련 과거 및 현재 데이터를 표시하며, 향후 배당 지급 여부나
      배당 확대를 예측하지 않습니다.
    </p>
  </div>
)}
      </div>
    </main>
  );
}