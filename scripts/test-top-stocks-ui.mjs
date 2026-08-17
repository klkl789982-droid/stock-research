import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const panel = await readFile(new URL("../components/TopStocksPanel.tsx", import.meta.url), "utf8");
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
assert.match(panel, /useState\("B"\)/u);
assert.match(panel, /모델 B · 추세 강도/u);
assert.match(panel, /모델 C · 진입 강도/u);
assert.match(panel, /연구 모델 보기/u);
assert.match(panel, /onSelectStock\(\{ code: stock\.code, name: stock\.name \}\)/u);
assert.match(panel, /overflow-x-auto/u);
assert.match(page, /<TopStocksPanel onSelectStock=\{handleSearch\}/u);
assert.match(page, /item\.srtnCd\.replace\(\/\^A\//u);
console.log("시장 TOP UI 구조 테스트 통과");
