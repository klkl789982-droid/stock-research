import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

assert.match(page, /function handleHome\(\)/u);
assert.match(page, /searchControllerRef\.current\?\.abort\(\)/u);
assert.match(page, /searchRequestIdRef\.current \+= 1/u);
assert.match(page, /setSearchedStock\(null\)/u);
assert.match(page, /setStockInfo\(null\)/u);
assert.match(page, /setShowFullTop\(false\)/u);
assert.match(page, /aria-label="주식 리서치 홈으로"/u);
assert.match(page, /onClick=\{handleHome\}/u);
assert.match(page, /\{searchedStock && <button[^>]*onClick=\{handleHome\}/u);
assert.match(page, /requestId !== searchRequestIdRef\.current \|\| \(error instanceof DOMException/u);
assert.match(page, /<TopStocksPanel compact onSelectStock=\{handleSearch\}/u);
assert.match(page, /<TopStocksPanel onSelectStock=\{handleSearch\}/u);
assert.doesNotMatch(page, /alert\(/u);
assert.match(page, /searchError/u);
assert.match(page, /해당 종목을 찾을 수 없습니다/u);
assert.match(page, /검색 중 문제가 발생했습니다/u);
assert.match(page, /role="alert"/u);

console.log("검색 화면 전환·홈 복귀·stale request guard UI 테스트 통과");
