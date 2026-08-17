# 장중 시장분석 display-only 계층 구현 보고서

## 결론

공식 `market-analysis-v1`과 완전히 분리된 `intraday-market-analysis-v1` 계층을 구현했다. 신규 일별 파이프라인은 기존 품질 검증을 통과한 동일 OHLCV 메모리 입력으로 별도 260-tuple seed를 준비한다. `/api/realtime`과 `/api/intraday-market-analysis`는 동일한 5초 KIS quote provider를 공유한다.

현재 거래일 원장은 거래일 여부만 제공하고 개장 중 세션을 인증하지 못하므로 API는 `marketSessionUnverified`로 계산을 차단한다. 실제 seed가 없다는 사유도 함께 반환된다. 공식 분석 카드는 독립 유지되며 장중 결과로 대체되지 않는다.

## 생성·수정 파일

- `lib/kis-quote-provider-core.mjs`, `lib/kis-quote-provider.ts`
- `lib/intraday-market-seed.mjs`
- `lib/intraday-market-analysis-v1.mjs`
- `app/api/realtime/route.ts`
- `app/api/intraday-market-analysis/route.ts`
- `scripts/create-daily-model-snapshot.mjs`, `scripts/run-daily-history.mjs`
- `components/market-analysis/MarketAnalysisPanel.tsx`, `app/page.tsx`
- `data/analysis/market-seeds/README.md`
- 신규 quote/seed/calculator/API·UI 테스트와 `package.json`

## KIS quote 파싱

직접 사용하는 KIS 원문 값은 `stck_shrn_iscd`, `stck_prpr`, `stck_oprc`, `stck_hgpr`, `stck_lwpr`, `acml_vol`, `prdy_vrss`, `prdy_ctrt`, `stck_bsop_date`, `stck_cntg_hour`다. 날짜와 시각은 각각 8자리/6자리 형식일 때만 정규화한다. 가격 OHLC는 양수 finite, 거래량은 0 이상 finite, OHLC 관계도 검증한다.

`receivedAt`은 서버 수신시각일 뿐 체결시각이 아니다. `marketStatus`는 현재 `unknown`, `isRealtime`은 `false`로 유지한다. KIS 날짜·시각이 없거나 시가 등 필수 값이 없으면 이전 값이나 서버 날짜로 대체하지 않는다.

## Quote cache

프로세스 singleton provider는 종목별 cache, in-flight Promise, generation을 Map으로 관리한다. TTL은 5초다. 동시 요청은 동일 Promise를 공유하며 실패·invalid quote는 cache하지 않는다. invalidate 이후 늦게 도착한 이전 generation은 새 cache를 덮지 못한다. 실제 HTTP는 기존 `kisRequest`를 사용하므로 token cache, 401 한 번 재발급, 403/429/5xx 미갱신 정책이 유지된다.

상태 unknown에서도 5초 cache는 중복 호출 억제에만 사용되며 점수 허용 근거가 아니다.

## Seed schema와 크기

경로는 `data/analysis/market-seeds/YYYY-MM-DD.json`이다. records와 종목코드는 오름차순, rows는 최신순이다. tuple은 `[date, open, high, low, close, volume]`이며 최대 260행이다. sourceManifest, 공식 formulaHash, sourceHash, quality와 contentHash를 저장한다.

553 × 260 = 143,780 tuple이다. 숫자 자릿수와 pretty-print 여부에 따라 대략 7~14MB/거래일로 예상된다. 실제 크기는 최초 dry-run의 메모리 직렬화 길이로 확인해야 한다.

seed는 기존 일별 수집 결과를 재사용하므로 추가 공공 API 호출이 없다. history·공식 market snapshot schema/contentHash는 바꾸지 않는다. lock/tmp/원자적 rename/rollback의 동일 성공 단위에 포함된다. 기존 날짜에는 사후 생성하지 않는다.

## Intraday 계산

입력은 공식 snapshot record, 일치하는 seed, KIS quote, 거래일 상태와 세션 인증이다. quote 날짜가 seed 최신 날짜와 같으면 최신 행을 교체하고, 더 최신이면 앞에 추가한 뒤 260행으로 자른다. 오래된 quote는 차단한다. 합성된 rows는 기존 `calculateMarketAnalysis`에 전달하므로 공식 파일은 수정하지 않았다.

출력은 항상 다음 불변값을 가진다.

- `calculatorVersion: intraday-market-analysis-v1`
- `displayOnly: true`
- `eligibleForRanking: false`
- `eligibleForBacktest: false`
- `eligibleForOptimization: false`
- 별도 `finalTechnicalScore`, 공식 점수, 차이
- quote 기준일/시각과 서버 수신시각 분리

TOP API와 resolver는 intraday 모듈을 import하거나 읽지 않는다는 구조 테스트가 있다.

## 차단 규칙

`tradingDay`, quote 날짜·시각, 필수 OHLCV, 공식 snapshot, seed, seed version, 공식 기준일, source/formula hash, 요청일 일치가 모두 필요하다. `marketClosed`, `unchecked`, `collectionFailed`, 누락·invalid quote, stale quote, KIS 실패를 차단한다.

현재 원장에는 세션 open/closed 근거가 없으므로 API는 `marketSessionVerified:false`를 전달하고 항상 `marketSessionUnverified`를 포함한다. 평일 또는 서버 시각만으로 장중을 추정하지 않는다.

## API와 UI

`GET /api/intraday-market-analysis?code=005930`은 저장된 공식 snapshot과 seed, 거래일 원장, 공용 quote만 사용한다. 공공 일봉·예시·저장된 장중 점수 fallback이 없다. quote와 계산 결과를 한 응답으로 반환한다.

검색 시 공식/장중 분석을 한 번 요청해 state에 저장한다. 탭 클릭은 API를 호출하지 않는다. 기존 5초 polling은 KIS 응답이 공식적으로 `marketStatus=open`이고 `isRealtime=true`일 때만 시작되므로 현재 unknown 상태에서는 자동 polling하지 않는다. AbortController와 requestId/code guard가 종목 변경의 늦은 응답을 막는다.

공식 카드와 장중 참고 카드는 분리되어 있다. 차단 시 장중 카드는 사유만 표시하며 KIS 실패가 공식 카드를 숨기지 않는다.

## 테스트 결과

- quote parser/cache/TTL/single-flight/failure/generation: 통과
- seed tuple/order/hash/validation: 통과
- 행 추가·동일 날짜 교체·260행 제한·차단/display-only: 통과
- API/UI/TOP/history 격리: 통과
- 기존 market/company analysis: 통과
- KIS token/client/route: 통과
- data/snapshot quality, dry-run, normalization, TOP UI: 통과
- A-v2, history/calendar: 통과
- TypeScript, 변경 코드 ESLint, build, `git diff --check`: 통과

실제 외부 API, 실제 dry-run, snapshot/seed 생성, resolver는 실행하지 않았다.

## 최초 실제 검증 절차

1. 승인된 KIS raw fixture로 날짜·시각·시가 필드 존재를 재확인한다.
2. 다음 신규 거래일 공식 pipeline dry-run에서 seed 예상 크기/hash/553 record를 확인한다.
3. production 실행 전 거래소 세션 상태 근거를 설계·승인한다.
4. 제한된 종목의 seed+고정 quote fixture 결과를 261-row 독립 계산과 대조한다.
5. 장중 quote 기준일/시각과 공식 거래일 원장 일치를 수동 확인한다.
6. 공식 snapshot/TOP/history hash 불변을 다시 확인한다.

현재 실제 seed와 신규 공식 snapshot이 없고 세션 인증도 없으므로 UI의 장중 계산은 정상적으로 차단된다.

## Vercel 제한

로컬 단일 Node에서는 Map cache와 single-flight가 유효하다. Vercel 다중 인스턴스에서는 quote cache, 종목별 in-flight/distributed lock, generation/CAS, 5초 TTL을 공유 Redis/KV로 이전해야 한다. token cache의 다중 인스턴스 공유 문제도 함께 해결해야 한다. 이번 단계에서는 외부 저장소를 추가하지 않았다.
