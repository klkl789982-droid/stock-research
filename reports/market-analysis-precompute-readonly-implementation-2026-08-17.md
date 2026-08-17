# 시장분석 사전 계산·조회 전용 구조 구현 보고서

## 결론

시장분석 계산을 `app/page.tsx`에서 제거하고 `market-analysis-v1` 순수 계산기로 분리했다. 신규 일별 생성기는 이미 수집·품질 검증한 공식 OHLCV를 재사용해 `data/analysis/market/YYYY-MM-DD.json`을 원자적으로 함께 생성한다. 검색 후 시장분석 탭은 `/api/market-analysis?code=...`에서 최신 저장 결과만 읽는다. 저장 결과가 없으면 명시적 오류를 표시하며 브라우저 계산, KIS 값, 공식 종가 fallback을 사용하지 않는다.

## 기존 구조와 고정한 계산 항목

기존 페이지는 `priceHistory`에 `realtimePrice.price`, `volume`, `high`, `low`를 섞어 MA, RSI, MACD, 모멘텀, 거래량 비율, ATR, 변동성, 52주 위치와 최종 기술점수를 매 렌더에서 계산했다. 분리된 계산기는 다음을 공식 일봉만으로 계산한다.

- MA5/20/60/120/200, MA20·MA60 기울기, 최근/이전 10일 고저 방향
- RSI14, EMA12/26, MACD/Signal/Histogram
- 5/20/60일 모멘텀, 20일 평균 거래량과 거래량 비율, OBV
- ATR14, ATR 비율, 20일 변동성, MA20 이격도
- 52주 고가·저가·위치·고점 대비 하락률
- 기존 구성요소 점수, reversal bonus, penalty/reasons, 최종 점수와 상태

기존 페이지에서 실시간 값 때문에 최신 공식 종가가 중복 삽입되던 RSI·당일 수익률 계산은 새 버전에 승계하지 않았다. `market-analysis-v1`은 당일 공식 종가와 직전 거래일 공식 종가를 사용한다. Model A-v1/A-v2와는 역할·파일·버전을 분리했고 해당 공식은 수정하지 않았다.

## 데이터 흐름

1. `create-daily-model-snapshot.mjs`가 Universe를 읽고 공식 일봉을 종목당 한 번 수집한다.
2. 기존 `market-data-quality-validator`로 검증하고 무거래 행을 정규화한다.
3. 적격 종목은 `market-analysis-v1`로 메모리 계산한다. 260 정규화 거래일 미만, 당일 무거래, 품질 누락은 명시적으로 제외한다.
4. sourceManifest, dataQuality, universeSummary, calculatorVersion, formulaHash, contentHash를 포함한 분석 스냅샷을 검증한다.
5. production 실행에서만 history·가격 원장·Universe archive와 함께 lock/tmp/원자적 rename/rollback 정책으로 저장한다. dry-run에서는 메모리 검증만 한다.
6. 브라우저는 최신 저장 파일의 종목 레코드만 조회한다.

## 스키마와 출처

최상위에는 `schemaVersion`, `analysisType`, `requestedDate`, `priceBasis`, `generatedAt`, `calculatorVersion`, `formulaHash`, `sourceManifest`, `dataQuality`, `universeSummary`, `records`, `contentHash`가 저장된다. 각 레코드는 `source`, `asOfDate`, `officialClosePrice`, `qualityStatus`, `eligible`, 제외 사유, indicators, componentScores, riskFlags, bonus/penalty, 최종 점수와 상태를 포함한다.

공식 종가는 `officialClosePrice`, KIS 마지막 조회가는 기존 quote overlay에서만 유지된다. 두 가격을 같은 필드나 점수 입력으로 사용하지 않는다.

## 변경 파일

- `lib/market-analysis-v1.mjs`: 독립·결정론적 공식 일봉 계산기
- `lib/market-analysis-snapshot.mjs`: 스키마 생성·hash·검증
- `scripts/create-daily-model-snapshot.mjs`: 동일 수집 결과로 분석 산출물 생성 및 원자적 저장
- `scripts/run-daily-history.mjs`: 네 번째 산출물 존재·날짜·종목 수 검증
- `app/api/market-analysis/route.ts`: 최신 저장 결과 조회 전용 API
- `components/market-analysis/MarketAnalysisPanel.tsx`: loading/error/ineligible/result UI
- `app/page.tsx`: 브라우저 계산 제거 및 조회 패널 연결
- `scripts/test-market-analysis-*.mjs`, `package.json`: 합성·characterization·스키마 테스트
- `data/analysis/market/README.md`: 운영 데이터 경로 문서

## 보호 및 제한

- 실제 공공 API 호출, production 스냅샷 생성, history resolver 실행은 하지 않았다.
- 기존 history, Universe, 가격 원장, TOP cache, registry는 수정하지 않았다.
- 저장 파일이 아직 없으므로 현재 UI는 의도적으로 “시장분석 결과 없음”을 표시한다. 첫 적격 거래일 production 파이프라인 실행 후 조회 가능하다.
- 파일 기반 조회는 단일 서버/로컬에 적합하다. 다중 Vercel 인스턴스에서는 공유 object storage 또는 DB가 필요하다.
- 실제 553종목 산출물 생성 가능 여부는 다음 공식 거래일의 품질 게이트 통과 후에만 판정할 수 있다.
