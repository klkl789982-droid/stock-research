# 기업분석 사전 계산·저장·조회 전용 구조 구현 보고서

## 1. 결론

검색 시 DART를 호출하고 브라우저가 재무비율과 점수를 계산하던 경로를 제거했다. 새 구조는 정규화 재무 원장과 분석일 exact-date 공식 시가총액을 입력으로 하는 `company-analysis-v1` 순수 계산기, 독립 snapshot builder, 저장 결과 전용 API와 UI로 구성된다. 실제 DART 호출·재무 원장·production snapshot은 생성하지 않았다. 따라서 현재 UI는 의도적으로 “기업분석 결과 없음”을 표시한다.

## 2. 기존 공식과 입력 감사

기존 `/api/financial`은 `data/corp-map.json`의 stock code → corp code 매핑을 사용한다. DART `fnlttSinglAcntAll.json`에 `bsns_year=2025`, `reprt_code=11011`(사업보고서), `fs_div=CFS`를 고정해 요청했다. 연결 자료가 없을 때 OFS로 전환하지 않으며, 보고서 접수일·접수번호·정정관계를 조회하거나 저장하지 않았다.

계정은 `account_nm` 최초 일치 방식이었다.

- 매출: 매출액, 수익(매출액), 영업수익
- 영업이익: 영업이익, 영업이익(손실)
- 순이익: 당기순이익, 당기순이익(손실), 연결당기순이익
- 자산/부채/자본: 각 총계
- EPS 후보는 기본주당이익/희석주당이익/주당순이익/EPS였지만 실제 EPS 값 대신 2년 CAGR만 반환했다.
- CAGR: `((당기/전전기)^(1/2)-1)*100`, 양쪽이 양수일 때만 계산
- 이자보상배율: 영업이익/이자비용, 이자비용 양수일 때만 계산
- FCF: 영업현금흐름 - 유형자산 취득 - 무형자산 취득. DART 취득액 부호가 음수인 경우를 정규화하지 않아 과대계산 가능성이 있다.

브라우저 공식은 ROE=순이익/자본, 부채비율=부채/자본, 영업이익률=영업이익/매출, PER=시가총액/순이익, PBR=시가총액/자본이었다. 점수는 수익성·성장성·안정성·가치평가 각 25점이며 총점은 반올림했다. 누락 구성요소는 모두 0점으로 합산되어 “실제 0”과 “계산 불가”가 구분되지 않았다. DART 2025 사업보고서와 `/api/price` 최신 시가총액의 기준일도 검증 없이 혼합됐다.

## 3. company-analysis-v1

공식 가중치와 임계값은 기존 화면을 그대로 버전화했다. 입력은 정규화 재무자료, 분석 기준일, exact-date 공식 시가총액과 가격 기준일, source/quality 메타데이터뿐이다. KIS last quote, 장중 OHLCV, React state, 브라우저 시각은 받지 않는다.

출력은 raw financial metrics, 세부/영역 점수, totalScore/grade, formula version/hash, 공시·재무·가치 기준일, source manifest, quality와 eligibility를 포함한다. 공시일이 분석일보다 미래이면 즉시 제외한다. 자본 0/누락, 적자 PER, 시가총액 누락·기준일 불일치는 `null`로 보존한다.

정상 fixture의 기존 공식 결과는 68점으로 고정됐다. 차이는 누락값이다. 기존 화면은 누락을 0점으로 합산했지만 v1은 영역을 `null`, 전체를 ineligible로 둔다. 이는 공식 최적화가 아니라 데이터 없음과 실제 0을 구분하기 위한 안전 변경이다.

## 4. Point-in-time 규칙

builder는 `filingDate <= analysisAsOfDate`인 검증된 원장 항목만 후보로 삼고, 공시일·접수번호 순으로 결정론적으로 최신 자료를 선택한다. CFS와 OFS는 필드로 명시하며 조용히 섞지 않는다. 정정공시는 `correctionOfReceiptNumber` 관계가 있을 때만 correction으로 분류하고 동일 식별자·다른 hash는 conflict로 중단한다. 현재 종목 마스터의 과거시점 인증과 정정공시 완전성은 확보되지 않았으므로 결과는 CERTIFIED가 아닌 PROVISIONAL이다.

## 5. 정규화 재무 원장

경로는 `data/financial-statements/{code}.json`이며 종목별 `statements` 배열을 전제로 한다. statement에는 schemaVersion, code/corpCode/companyName, provider, report code/name, business year, fiscalPeriodEnd, filingDate, receiptNumber, CFS/OFS, unit, normalizedAccounts, sourceHash, generatedAt, quality status/reasons를 둔다. hash에는 인증키나 URL을 넣지 않는다. 동일 식별자·동일 hash는 멱등, 다른 hash는 correction 또는 conflict다.

## 6. Company snapshot

경로는 `data/analysis/company/YYYY-MM-DD.json`이다. 최상위에는 schema/version/type/date/generatedAt/calculator/formulaHash/sourceManifest/dataQuality/universeSummary/records/contentHash가 있다. records는 종목코드 오름차순이며 canonical object key와 소수 8자리 숫자 정규화 후 SHA-256을 계산한다. 동일 입력은 동일 hash를 만들고 builder는 기존 동일 hash만 멱등 성공, 다른 hash는 덮어쓰지 않는다.

## 7. 수집과 분석 생성 분리

- `npm run company:financial-sync`: 외부 DART 수집 인터페이스. 현재는 `--fixture` 외 실행을 명시적으로 차단한다.
- `npm run company:analysis-build -- --date=YYYY-MM-DD`: 저장 원장과 해당 날짜 Universe archive의 exact-date 시가총액만 사용한다.
- `--dry-run`은 계산·검증만 하고 파일을 쓰지 않는다.

기업분석은 `create-daily-model-snapshot`과 resolver에서 import하지 않는다. 따라서 재무 실패가 시장분석 또는 A/B/C/D snapshot을 막지 않는다.

## 8. 조회 API와 UI

`GET /api/company-analysis?code=005930[&date=YYYY-MM-DD]`는 저장 파일만 읽는다. 코드·날짜를 정규식 검증해 path traversal을 차단하며 available/provisional/stale/missing/ineligible/failed를 구분한다. DART/KIS/financial API 호출과 계산 fallback이 없다.

검색은 stock/price/realtime과 병렬로 company snapshot을 한 번 조회한다. 종목 변경 시 이전 controller를 abort하고 state를 즉시 비우며 requestId와 code guard로 늦은 응답을 차단한다. 기업분석 탭 클릭은 API 호출이나 계산 없이 state만 렌더링한다. KIS 현재가 카드는 그대로 독립 유지된다.

## 9. 생성·수정 파일

- `lib/company-analysis-v1.mjs`
- `lib/financial-statement-ledger.mjs`
- `lib/company-analysis-snapshot.mjs`
- `scripts/build-company-analysis.mjs`, `scripts/sync-financial-statements.mjs`
- `app/api/company-analysis/route.ts`
- `components/company-analysis/CompanyAnalysisPanel.tsx`
- `app/page.tsx`, `package.json`
- `scripts/test-company-*.mjs`, `data/.../README.md`, 본 보고서

## 10. 남은 제한과 최초 동기화 승인

실제 원장과 company snapshot은 없다. 최초 동기화 전에는 DART 공시 목록을 이용한 접수일/접수번호/정정관계 수집 정책, CFS 우선·OFS fallback 정책, 계정과목 표준화 및 CAPEX 부호 정책, rate limit/재시도/비밀 마스킹, point-in-time corp master 근거, 표본 수동 대조를 별도 승인해야 한다. 이후 소규모 fixture dry-run → 제한된 종목 동기화 → 원장 감사 → 553종목 확대 순으로 진행해야 한다.

다중 인스턴스 배포에서는 로컬 JSON 조회 대신 object storage 또는 DB와 조건부 write/content-hash 충돌 제어가 필요하다. 계산기·snapshot/API 인터페이스는 저장소 adapter 교체가 가능하도록 분리했다.
