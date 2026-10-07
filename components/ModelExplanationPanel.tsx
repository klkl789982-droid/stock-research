"use client";

import { useState } from "react";

type ModelExplanation = {
  id: string;
  label: string;
  title: string;
  purpose: string;
  indicators: string;
  weights: string[];
  formula: string[];
  meaning: string;
  cautions: string[];
};

const MODELS: ModelExplanation[] = [
  {
    id: "A-v1",
    label: "A-v1",
    title: "기술적 강도",
    purpose: "가격의 모멘텀·추세·거래량·MACD·RSI·52주 위치를 함께 반영해 기술적 강도를 비교합니다.",
    indicators: "20·60일 모멘텀, 이동평균선 배열·기울기, 20일 평균 대비 거래량, MACD 히스토그램, RSI14, 52주 가격 위치",
    weights: [
      "모멘텀 25%: 20일 모멘텀 점수 40%와 60일 모멘텀 점수 60%를 결합합니다.",
      "추세 20%: 현재가/20일선, 20·60·120일선 배열, 20·60일선 기울기를 합산합니다.",
      "거래량 20%: 20일 평균 대비 거래량을 점수화하고 20일 모멘텀 방향으로 조정합니다.",
      "MACD 15% · RSI 10% · 52주 위치 10%",
    ],
    formula: [
      "기본점수 = 모멘텀×0.25 + 추세×0.20 + 조정 거래량×0.20 + MACD×0.15 + RSI×0.10 + 52주 위치×0.10",
      "모멘텀은 수익률 구간(30% 이상 100점, 20% 이상 85점, 10% 이상 65점 등)으로 점수화합니다.",
      "MACD는 히스토그램/ATR14와 전일 히스토그램 변화를, RSI는 65에 가까울수록 높은 점수를 사용합니다.",
      "최종점수 = 기본점수 + 반전 보너스(조건 충족 시 +10) − 과열 패널티",
    ],
    meaning: "높은 점수는 중·장기 모멘텀과 이동평균선 추세, 거래량·MACD·RSI·52주 위치가 함께 우호적이고 과열 경고가 적다는 뜻입니다.",
    cautions: [
      "A-v1의 최종점수에는 최종 0~100 clamp가 없습니다. 보너스와 패널티를 반영한 결과가 100을 넘을 수 있습니다.",
      "당일 +15% 이상, 최근 3일 급등, RSI 80 초과, ATR·20일선 이격도·20일 변동성 과열에는 각각 패널티가 누적될 수 있습니다.",
      "기술적 상대강도 지표이며 수익·위험을 보장하거나 매수 지시를 의미하지 않습니다.",
    ],
  },
  {
    id: "A-v2",
    label: "A-v2",
    title: "기술적 강도 · 챌린저",
    purpose: "A-v1과 같은 기술 지표·가중치를 사용하되, 최종 점수 범위를 0~100으로 제한해 병렬 검증하는 챌린저 모델입니다.",
    indicators: "A-v1과 동일: 20·60일 모멘텀, 이동평균선 추세, 거래량, MACD, RSI14, 52주 가격 위치",
    weights: [
      "모멘텀 25% · 추세 20% · 거래량 20% · MACD 15% · RSI 10% · 52주 위치 10%",
      "구성요소의 원천 계산과 반전 보너스·과열 패널티 조건은 A-v1을 그대로 사용합니다.",
    ],
    formula: [
      "원점수 = A-v1과 같은 가중 기본점수 + 반전 보너스 − 패널티",
      "최종점수 = clamp(원점수, 0, 100), 소수점 둘째 자리까지 반올림",
      "동점 정렬은 최종점수 내림차순 → 원점수 내림차순 → 종목코드 오름차순입니다.",
    ],
    meaning: "A-v1과 같은 기술 신호가 강하면서, 결과를 0~100 범위 안에서 비교하기 쉽게 만든 점수입니다.",
    cautions: [
      "현재 모델 등록 상태는 검증 중(challenger/evaluation)입니다. 운영 우위나 성과 우위를 뜻하지 않습니다.",
      "100점은 상한에 도달했다는 뜻이며, 상한 밖 원점수 차이를 보여주지 않습니다.",
      "A-v1과 동일하게 기술 지표만 반영하며 투자 판단을 대체하지 않습니다.",
    ],
  },
  {
    id: "B-v1",
    label: "B-v1",
    title: "중기 추세",
    purpose: "이동평균선 구조와 그 지속성을 중심으로 중기 추세의 상대적 강도를 비교합니다.",
    indicators: "현재가/20일선 거리, 20·60·120일선 배열, 20·60일선 기울기, 최근 20개 관측의 20일선 상회 비율, 20일 모멘텀, MACD 히스토그램/ATR14, 52주 위치",
    weights: [
      "구조 35%: 현재가/20일선 25%, 20일선/60일선 25%, 60일선/120일선 20%, 20일선 기울기 20%, 60일선 기울기 10%를 먼저 결합합니다.",
      "지속성 25% · 20일 모멘텀 20% · MACD 확인 10% · 52주 위치 10%",
    ],
    formula: [
      "중심 점수(x, m) = clamp(50 + x×m, 0, 100)",
      "구조 = [현재가/20일선·이평 배열·기울기 결합]×0.35",
      "최종점수 = clamp(구조 + 20일선 상회 지속성×0.25 + 중심 모멘텀×0.20 + 중심 MACD×0.10 + 52주 위치×0.10, 0, 100)",
    ],
    meaning: "높은 점수는 가격이 이동평균선 위에 있고 단·중·장기 이평 배열과 기울기가 우호적이며, 그 상태가 지속된다는 뜻입니다.",
    cautions: [
      "이 모델은 진입 타이밍보다 중기 추세의 구조와 지속성에 비중을 둡니다.",
      "점수는 0~100으로 제한되며, 변동성이 낮거나 신호가 부족한 종목의 0점이 반드시 부정적 전망을 뜻하지는 않습니다.",
      "시장 국면 변화나 개별 공시·유동성 위험은 별도로 확인해야 합니다.",
    ],
  },
  {
    id: "C-v1",
    label: "C-v1",
    title: "현재 진입 강도",
    purpose: "당일 가격·거래량과 단기 모멘텀·보조지표 전환을 바탕으로 현재 시점의 진입 조건 강도를 비교합니다.",
    indicators: "당일 고가·저가 안의 종가 위치, 등락률, 20일 평균 대비 거래량, 양봉 여부, 3·5일 모멘텀, RSI·RSI 변화, MACD 히스토그램 변화, 5·20일선 대비 가격",
    weights: [
      "가격 행동 25% · 거래량 확인 20% · 단기 모멘텀 20% · 전환 신호 20% · 단기 추세 정합성 15%",
      "위험 패널티는 최대 35점까지 별도로 차감합니다.",
    ],
    formula: [
      "가격 행동 = [종가 위치×0.60 + 등락률 구간 보간점수×0.40]×0.25",
      "거래량 확인은 양봉/음봉 여부와 거래량 비율로 계산하고, 단기 모멘텀은 3일·5일 구간 보간점수의 평균×0.20입니다.",
      "전환 신호 = [RSI 구간 보간×0.40 + RSI 변화 방향×0.20 + MACD 히스토그램 변화 방향×0.40]×0.20",
      "최종점수 = clamp(가격 행동 + 거래량 확인 + 단기 모멘텀 + 전환 신호 + 5·20일선 정합성 − 위험 패널티, 0, 100)",
    ],
    meaning: "높은 점수는 가격이 당일 범위의 상대적 상단에 있고, 거래량·짧은 모멘텀·RSI/MACD 전환·단기 이평 정합성이 함께 좋다는 뜻입니다.",
    cautions: [
      "RSI 75 이상, 일간 −5% 이하, 대량 음봉, 5일선 이탈·급락, 20일선 대비 15% 이상 이격은 패널티 대상입니다.",
      "짧은 구간의 가격·거래량 변화에 민감하므로 중기 추세 자체를 대신하지 않습니다.",
      "장중·단기 신호는 변동성이 크며 체결·유동성·호가 상황을 별도로 확인해야 합니다.",
    ],
  },
  {
    id: "D-v1",
    label: "D-v1",
    title: "추세·진입 결합",
    purpose: "B의 중기 추세와 C의 현재 진입 강도를 동시에 만족하는 종목을 상대적으로 높게 평가합니다.",
    indicators: "B-v1의 이동평균선·추세 지속성·MACD·52주 위치와 C-v1의 당일 가격 행동·거래량·단기 전환 신호",
    weights: [
      "별도 가중합이 아니라 B-v1 점수와 C-v1 점수를 곱해 결합합니다.",
      "따라서 한쪽 점수가 낮으면 다른 한쪽이 높아도 결합 점수는 제한됩니다.",
    ],
    formula: [
      "최종점수 = clamp((B-v1 점수 × C-v1 점수) ÷ 100, 0, 100)",
      "소수점 둘째 자리까지 반올림합니다.",
    ],
    meaning: "높은 점수는 중기 추세가 좋고 현재 진입 조건도 함께 우호적이라는 뜻입니다.",
    cautions: [
      "B와 C 중 하나만 강한 종목은 곱셈 구조상 높은 D 점수를 얻기 어렵습니다.",
      "D는 B/C 입력과 위험 한계를 그대로 공유하므로, 새 독립 지표가 추가되는 모델은 아닙니다.",
      "결합 점수도 기술적 비교 지표이며 성과를 보장하지 않습니다.",
    ],
  },
];

export default function ModelExplanationPanel() {
  const [activeId, setActiveId] = useState("A-v1");
  const model = MODELS.find((item) => item.id === activeId) ?? MODELS[0];

  return (
    <section className="tb-card mt-6 p-4 sm:p-6" aria-labelledby="model-explanation-heading">
      <p className="text-xs font-bold uppercase tracking-[0.15em] text-[var(--tb-orange)]">Model guide</p>
      <h2 id="model-explanation-heading" className="mt-1 text-xl font-bold tracking-tight text-slate-950 sm:text-2xl">모델 설명</h2>
      <p className="mt-1 text-sm text-slate-600">현재 저장·순위 계산에 사용하는 코드 기준의 설명입니다. 점수 자체나 계산 규칙은 이 화면에서 바꾸지 않습니다.</p>

      <div className="mt-5 flex flex-wrap gap-1 border-b border-slate-200/80" role="tablist" aria-label="설명할 모델 선택">
        {MODELS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={activeId === item.id} onClick={() => setActiveId(item.id)} className={`tb-focus -mb-px border-b-2 px-3 py-2 text-sm font-semibold ${activeId === item.id ? "border-[var(--tb-orange)] text-[var(--tb-orange)]" : "border-transparent text-slate-500 hover:text-slate-900"}`}>{item.label}</button>)}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <article className="rounded-xl border border-[var(--tb-border)] bg-[rgba(255,252,247,0.82)] p-4">
          <h3 className="text-lg font-semibold text-slate-950">{model.label} · {model.title}</h3>
          <dl className="mt-4 space-y-4 text-sm leading-6">
            <div><dt className="font-semibold text-slate-800">목적</dt><dd className="mt-1 text-slate-600">{model.purpose}</dd></div>
            <div><dt className="font-semibold text-slate-800">중점 지표</dt><dd className="mt-1 text-slate-600">{model.indicators}</dd></div>
            <div><dt className="font-semibold text-slate-800">높은 점수의 의미</dt><dd className="mt-1 text-slate-600">{model.meaning}</dd></div>
          </dl>
        </article>
        <article className="rounded-xl border border-[var(--tb-border)] bg-[rgba(255,252,247,0.82)] p-4">
          <h3 className="font-semibold text-slate-900">구성요소와 가중치</h3>
          <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600">{model.weights.map((item) => <li key={item} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--tb-orange)]" />{item}</li>)}</ul>
          <h3 className="mt-5 font-semibold text-slate-900">실제 계산식</h3>
          <ol className="mt-3 space-y-2 text-sm leading-6 text-slate-600">{model.formula.map((item, index) => <li key={item} className="flex gap-2"><span className="font-semibold text-[var(--tb-orange)]">{index + 1}.</span>{item}</li>)}</ol>
        </article>
      </div>
      <aside className="mt-4 rounded-xl border border-amber-200/80 bg-amber-50/80 p-4" aria-label={`${model.label} 해석 시 주의점`}>
        <h3 className="font-semibold text-amber-950">해석 시 주의점</h3>
        <ul className="mt-2 space-y-1.5 text-sm leading-6 text-amber-900">{model.cautions.map((item) => <li key={item}>• {item}</li>)}</ul>
      </aside>
    </section>
  );
}
