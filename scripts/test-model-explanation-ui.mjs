import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

const guide = await readFile(new URL("../components/ModelExplanationPanel.tsx", import.meta.url), "utf8");
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const topPanel = await readFile(new URL("../components/TopStocksPanel.tsx", import.meta.url), "utf8");

for (const model of ["A-v1", "A-v2", "B-v1", "C-v1", "D-v1"]) assert.match(guide, new RegExp(model, "u"));
for (const heading of ["목적", "중점 지표", "구성요소와 가중치", "실제 계산식", "높은 점수의 의미", "해석 시 주의점"]) assert.match(guide, new RegExp(heading, "u"));
assert.match(guide, /최종점수에는 최종 0~100 clamp가 없습니다/u);
assert.match(guide, /최종점수 = clamp\(원점수, 0, 100\)/u);
assert.match(guide, /\(B-v1 점수 × C-v1 점수\) ÷ 100/u);
assert.match(page, /모델 설명/u);
assert.match(page, /<ModelExplanationPanel \/>/u);
assert.match(topPanel, /이동평균선 구조·기울기·추세 지속성/u);
assert.match(topPanel, /가격·거래량·단기 모멘텀·보조지표 전환/u);
assert.match(topPanel, /모멘텀·추세·거래량·MACD·RSI·52주 가격 위치/u);
assert.match(topPanel, /B와 C를 결합해 중기 추세와 현재 진입 강도/u);

const definitions = {
  "A-v1": ["20개 종가 구간(19간격)", "60개 종가 구간(59간격)", "강세 상태 보너스", "새 반전이나 교차 발생을 확인하는 조건은 아닙니다", "단순평균", "RSI 100", "하나만 적용합니다", "전일 대비 변화율"],
  "A-v2": ["20·60개 종가 구간(19·59간격)", "단순평균 RSI(14)", "강세 상태 보너스", "검증 중(challenger/evaluation)"],
  "B-v1": ["20개 종가 구간(19간격)", "20일선 이상 비율", "전일 대비 변화율"],
  "C-v1": ["3·5개 종가 구간(2·4간격)", "단순평균", "RSI 100", "최소 34개 관측값", "중립값 50"],
  "D-v1": ["(B-v1 점수 × C-v1 점수) ÷ 100", "B와 C 중 하나만 강한 종목"],
};
for (const [modelId, expected] of Object.entries(definitions)) {
  const output = {};
  const require = (name) => {
    if (name === "react/jsx-runtime") return jsx;
    if (name === "react") return { ...React, useState: () => [modelId, () => {}] };
    throw new Error(`Unexpected model explanation dependency: ${name}`);
  };
  new Function("require", "exports", ts.transpileModule(guide, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText)(require, output);
  const rendered = renderToStaticMarkup(React.createElement(output.default));
  for (const text of [modelId, "점수는 수익 확률이 아닙니다", ...expected]) assert.ok(rendered.includes(text), `${modelId}: ${text}`);
  assert.doesNotMatch(rendered, /A-v3|C-v2|D-v2|반전 보너스/u, "do not present proposed corrections as current models");
}

console.log("model explanation UI/formula disclosure test passed");
