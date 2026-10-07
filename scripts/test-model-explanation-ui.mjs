import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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

console.log("model explanation UI/formula disclosure test passed");
