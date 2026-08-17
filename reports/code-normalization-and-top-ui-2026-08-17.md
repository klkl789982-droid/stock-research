# 종목코드 정규화·무거래 행·시장 TOP UI 작업 보고서

- 작업일: 2026-08-17
- 범위: 코드 변경 및 합성 테스트만 수행
- 실제 553종목 dry-run / 외부 API / 스냅샷 생성 / resolver 실행: 수행하지 않음

## 1. 수정 파일

이번 범위의 핵심 파일은 다음과 같다.

- 신규: `lib/stock-code.mjs`
- 수정: `lib/market-data-quality-validator.mjs`, `lib/snapshot-quality-pipeline.mjs`
- 수정: `lib/market-price-ledger.mjs`, `lib/model-history-schema.mjs`, `lib/future-return-resolver.mjs`
- 수정: `scripts/build-universe.mjs`, `scripts/create-daily-model-snapshot.mjs`, `scripts/run-daily-history.mjs`
- 수정: `app/api/top-stocks/route.ts`, `components/TopStocksPanel.tsx`, `app/page.tsx`
- 수정: `config/snapshot-quality-policy.json`, `package.json`
- 신규 테스트: `scripts/test-market-data-normalization.mjs`, `scripts/test-top-stocks-ui.mjs`
- 보강 테스트: 품질 검증기, 스냅샷 품질, resolver, 거래일 캘린더 테스트

## 2. 영문 혼합 코드 처리

공용 `normalizeStockCode()`는 정확히 6자리의 숫자·영문 대문자만 허용한다. 정확히 7자리이면서 첫 글자가 `A`인 API 코드만 선행 `A`를 제거한다. 입력을 trim하거나 대문자로 바꾸거나 0으로 채우지 않으므로 소문자, 공백, 길이 오류를 조용히 교정하지 않는다.

합성 테스트에서 `005930`, `0009K0`, `0015N0`, `0039P0`, `0126Z0`, `A005930`, `A0009K0`를 검증했다. Universe, historyByCode, 가격 원장, tracking Universe, 제외 목록 생성 경로, TOP API에 공통 정규화를 연결했다. 영문 포함 자체는 모델 제외 사유가 아니며 역사 길이 조건은 기존 모델별 기준을 그대로 적용한다.

## 3. 무거래 행 분류와 정책

- `validTradingRow`: 거래량 양수, OHLC 모두 양수·finite, OHLC 관계 정상
- `nonTradingObservation`: 거래량 0, 종가 양수·finite, O/H/L이 0·null·빈 값이며 이전 관측 종가와 모순 없음
- `invalidTradingRow`: 음수/비정상 거래량, 유효하지 않은 종가·OHLC, OHLC 관계 오류, 거래량 0인데 가격 변동 또는 체결 가능한 OHLC가 존재하는 모순

과거 무거래 행은 warning으로 남기고 모델 입력 및 고유 거래일 수에서 제외한다. 요청일 무거래 종목은 observed Universe에는 남지만 전 모델에서 `tradingHaltOrNoTrade`로 제외되어 점수·순위가 null이 된다. 전체 차단 임계치는 `config/snapshot-quality-policy.json`의 `maxRequestedNonTradingRatio`(현재 명시값 0.1)로 관리한다.

가격 원장은 요청일 무거래 종목을 `openPrice: null`, `closePrice: null`, `referenceClose`, `executable: false`, `priceStatus: tradingHaltOrNoTrade`로 표현한다. 참고 종가는 체결 가격으로 사용하지 않는다.

## 4. 정규화 버전

신규 source manifest schema는 2이며 `marketDataNormalizationVersion: v2`를 기록한다. v2 입력 hash는 정규화 코드와 원본 관측 배열에 대해 결정론적으로 생성된다. 기존 2026-08-13 스냅샷에는 소급 적용하지 않았다.

## 5. resolver 호환성

수익률 공식과 거래일 offset 계산은 변경하지 않았다. resolver가 가격 원장의 정규화 키를 사용하도록 하고, `executable: false`인 T+1 진입과 T+1/T+5/T+20 청산을 `notExecutable`로 중단한다. 이후 거래일 대체, referenceClose 사용, 수익률 0 대체는 모두 하지 않는다. 합성 테스트에서 진입 거래정지와 T+5 청산 거래정지를 각각 검증했다.

## 6. B/C 중심 UI

시장 TOP의 기본 선택을 B-v1로 변경하고, 메인 segmented control에는 `모델 B · 추세 강도`와 `모델 C · 진입 강도`만 같은 크기로 표시한다. 이는 표시 우선순위 변경이며 모델 공식·승격 상태를 변경하지 않는다.

## 7. 연구 모델 접기

`연구 모델 보기` disclosure 안에 A-v1, A-v2, D-v1을 유지했다. A-v2는 검증 중인 챌린저라는 기존 상태 안내와 데이터 없음/오류 처리를 유지한다. 향후 E/F 추가 시 primary/research 탭 정의를 확장할 수 있다.

## 8. 품질정보 표시

기본 영역에는 잠정 상태와 기준일만 표시한다. 구조 검증, 순위·가격 기준일, 가격 기준, 모델 버전, 데이터 모드, ranking Universe, 최적화 가능 여부, manifest 버전은 `데이터 기준 자세히 보기`로 이동했다. 품질 등급이 없거나 `UNKNOWN`인 기존 schema v2 데이터는 `기존 잠정 스냅샷 · 품질 게이트 도입 전`으로 표시한다.

## 9. 종목 클릭 검색

종목명/코드는 키보드 접근 가능한 button이다. 클릭 시 `{code, name}`을 부모로 전달하고 기존 `handleSearch()`를 정확히 한 번 재사용한다. 입력값 갱신, stale-state 초기화, requestId/선택 코드 검증, 기존 API 흐름을 그대로 거친다. 처리 중 추가 클릭을 막고 결과 페이지 상단으로 부드럽게 이동한다.

## 10. 모바일 반응형

모바일에서 순위·종목명·점수·기준일 종가를 유지하고 시장 열은 보조 정보로 숨긴다. 표 컨테이너는 가로 스크롤을 허용하며 숫자에는 줄바꿈 방지를 적용했다. 종목코드는 종목명 아래에 보조 표시된다.

## 11. 테스트·빌드 결과

모두 통과:

- `npm run data:quality-test` — 24개
- `npm run snapshot:quality-test` — 15개
- `npm run history:dry-run-test` — 5개
- `npm run data:normalization-test`
- `npm run ui:top-stocks-test`
- `npm run model:a-v2-test`
- `npm run history:test`
- `npm run history:calendar-test`
- `npx tsc --noEmit --incremental false`
- 신규·변경 모듈 ESLint
- `npm run build` — Next.js production build/TypeScript 통과
- `git diff --check` — 오류 없음(LF/CRLF 안내만 존재)

`app/page.tsx` 전체 ESLint에는 이번 변경 전부터 존재한 `no-explicit-any` 5건(상태 타입 선언부)이 남아 있다. 이번에 변경한 검색 callback의 신규 `any`는 제거했다.

## 12. 기존 파일 불변

작업 후 SHA-256은 작업 전 기준과 일치한다.

| 보호 대상 | SHA-256 |
|---|---|
| history/2026-08-13 | `5E4D913A832D241C90808583EAEE1EE7C1165535953C7AC1378C8275F8BECDAA` |
| universe.json | `5E750029D14F8B1263157AD5A0982712BC2A2F25DBB34B47F3604C8116A745F8` |
| top-stocks.json | `6C124B73FA8E07C91998E5296E81C6D3E8DEA29D195DD90F05DE4A298F339BB5` |
| model-registry.json | `4BCB29D977B7A1E4EA4643DAC6A66291C155C9C500D19C523B101548D5FA89B8` |
| A-v1 | `48CCDEC745C050683A4C994EC308CDDD5A6FA2FFC6640ADB2450A70426CA32A6` |
| A-v2 | `B3578FE7F9452D9CC169F705B0508DE3B6F0F0E1674C5D4E10B7BAC3D358BB2A` |
| B-v1 | `B9A45D38D0398617133CE8C9CE9DD05393BA787C3AD8E032EFC8CB5CEA6052D0` |
| C-v1 | `86F255711483AE949EC913750048461AC3A41B98DC28B2C0E21CA10522B16B8B` |
| D-v1 | `033A5F3E40ADBA3C74360E646B622B95683B1A83805BAEB079227226658E732F` |

production history에는 기존 `2026-08-13.json`만 있고, 가격 원장에는 기존 `README.md`만 있다. 신규 production 스냅샷·가격 원장·Universe archive는 생성되지 않았다. 외부 API 호출, history:resolve 실행, commit/push/deploy도 수행하지 않았다.

## 13. 남은 제한사항

- 무거래 행 판정은 현재 제공 필드와 직전 관측 종가의 일관성에 기반한다. 거래정지의 법적/시장 상태를 별도 마스터로 인증하지 않는다.
- 10% 전체 차단 임계치는 초기 정책값이며 실제 dry-run 결과를 보기 전 조정하지 않았다.
- primary/research 표시 목록은 현재 validation config와 일치하도록 UI 상수로 선언돼 있다. 향후 서버가 registry의 활성 상태를 응답하도록 하면 완전한 동적 구성이 가능하다.
- UI 합성 검증은 구조/연결 테스트다. 실제 브라우저 상호작용과 553개 응답은 이번 금지 범위 때문에 실행하지 않았다.

## 14. 실제 dry-run 재실행 권장 시점

공식 일봉의 요청일 데이터가 게시된 것이 확인되고 사용자가 외부 API 실행을 승인한 뒤 `history:dry-run -- --date=YYYY-MM-DD`를 한 번 실행하는 것을 권장한다. 그때 영문 혼합 코드 수용, 무거래 비율, 모델별 eligible/excluded, source manifest v2 hash를 실제 553종목에서 확인한다.
