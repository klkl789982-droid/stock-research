# 검색·기업분석·시장분석 조회 전용 전환 분석

- 작성일: 2026-08-17
- 분석 대상: 현재 `stock-research` 로컬 프로젝트
- 수행 범위: 정적 코드 및 기존 JSON 구조 분석
- 미수행: 코드 변경, 외부 API 호출, production 데이터 생성, snapshot 생성, `history:resolve`, 모델 공식 변경

## 핵심 결론

현재 기업분석과 시장분석은 **탭 클릭 시 API를 호출하는 구조가 아니다**. 종목 검색 시 종목목록·공식 일봉·KIS 시세·DART 재무·KIS 투자자 수급을 요청하고, 이 결과를 React state에 담는다. 이후 탭은 이미 받은 state를 조건부 렌더링한다.

다만 `app/page.tsx`가 하나의 큰 컴포넌트이고 재무·기술 지표 계산이 컴포넌트 본문에 있기 때문에, activeTab과 관계없이 매 렌더마다 계산된다. 특히 KIS 시세를 5초마다 가져와 `realtimePrice`를 갱신하므로 매번 전체 재무·기술 계산이 반복된다. 사용자가 탭 클릭을 느리게 느끼는 현상은 다음 세 요인이 결합한 결과다.

1. 검색 직후 다수 외부 API 동시 호출
2. 종목 선택 동안 5초마다 KIS 토큰 발급 + 시세 호출
3. 모든 state/탭 변경에서 거대한 프론트 계산 블록 재실행

장기 목표에는 `검색 = 저장된 종목 기본정보 및 최신 snapshot 조회`, `탭 = 이미 조회한 저장 결과 표시`가 적합하다. 실시간 시세만 명시적 별도 요청으로 남기고 공식 종가 기반 분석과 분리해야 한다.

---

## 1. 종목 검색 시 API 목록과 호출 순서

진입점은 `app/page.tsx`의 `handleSearch()`다.

| 단계 | 호출 | 외부 원천 | 실행 방식 | 비고 |
|---:|---|---|---|---|
| 1 | `GET /api/stock?query=` | 공공데이터 KRX 상장종목정보 | 먼저 await | 검색어로 최대 20건 조회, `no-store` |
| 2 | 결과 종목 선택·state 갱신 | 없음 | 동기 | code/name 설정, 기존 가격·재무·수급 state 초기화 |
| 3a | `GET /api/price?code=` | 공공데이터 공식 일봉 | 3b와 `Promise.all` | 260행 요청, `no-store` |
| 3b | `GET /api/realtime?code=` | KIS 현재가 | 3a와 `Promise.all` | 호출마다 OAuth 토큰을 새로 발급 |
| 4 | `GET /api/financial?code=` | DART 단일회사 전체계정 | fire-and-forget | 공식 일봉 응답 처리 후 시작, route 내부 1시간 revalidate |
| 병렬 effect | `GET /api/investor?code=` | KIS 투자자 추정 수급 | `stockInfo` 변경 effect | 호출마다 별도 OAuth 토큰 발급 |
| 이후 반복 | `GET /api/realtime?code=` | KIS 현재가 | 5초 interval | effect 최초 즉시 호출은 없고, 검색의 3b 후 5초마다 반복 |

상세 순서는 네트워크 완료 시점에 따라 일부 겹친다. `/api/price`와 `/api/realtime`의 HTTP 응답을 모두 기다린 후 가격 JSON을 처리하고 DART 요청을 시작한다. `stockInfo` state 변경에 따른 투자자 effect는 브라우저 렌더 이후 별도로 시작될 수 있다.

검색 시작 시 request ID를 증가시키고 가격·재무·수급 state를 초기화한다. 가격과 현재시세 결과는 request ID 및 선택 code를 확인한다. 그러나 모든 비동기 경로가 같은 수준으로 보호되는 것은 아니다(8절 참조).

## 2. 기업분석 탭 클릭 시 API와 계산 함수

기업분석 탭의 내부 값은 `activeTab === "investor"` 조건으로 렌더링된다. **탭 클릭 이벤트 자체는 `setActiveTab("investor")`만 호출하며 외부 API를 호출하지 않는다.** 필요한 데이터는 검색 때 이미 요청된다.

### 사용하는 API 결과

- `/api/stock`: 종목명, 코드, 시장, 상장정보, `mrktTotAmt` 등
- `/api/financial`: DART 재무 항목과 CAGR/이자보상배율/FCF
- `/api/realtime`: valuation 계산에 사용될 수 있는 KIS 마지막 조회가
- `/api/price`: KIS 값이 없을 때 valuation에 사용되는 최근 공식 종가

### 프론트에서 계산하는 기업분석 값

`app/page.tsx` 컴포넌트 본문에서 다음이 매 렌더마다 계산된다.

- ROE = 순이익 / 자본
- 부채비율 = 부채 / 자본
- PER = 시가총액 / 순이익
- PBR = 시가총액 / 자본
- 영업이익률 = 영업이익 / 매출
- 수익성 점수: ROE + 영업이익률 구간 점수
- 성장성 점수: 매출 CAGR + 영업이익 CAGR
- 안정성 점수: 부채비율 + 이자보상배율
- 가치평가 점수: PER + PBR
- `totalScore`: 네 영역 합산 후 반올림
- 등급/문구: totalScore 구간 판정

여기에는 별도 서버 라이브러리가 사용되지 않는다. DART route에서 원천 재무 숫자를 가공하고, 최종 기업분석 점수는 브라우저에서 계산한다.

### API route에서 계산하는 재무 값

`app/api/financial/route.ts`가 DART XML/JSON 계정명을 찾아 다음을 계산한다.

- 2년 간격 기반 매출·영업이익·EPS CAGR
- 이자보상배율
- FCF = 영업활동현금흐름 - 유형자산 취득 - 무형자산 취득
- 매출, 영업이익, 순이익, 자산, 부채, 자본 등 계정 추출

사업연도는 현재 코드에 `2025`, 보고서 코드는 사업보고서 `11011`, 연결재무제표 `CFS`로 고정돼 있다.

## 3. 시장분석 탭 클릭 시 API와 계산 함수

시장분석 탭은 코드상 `activeTab === "trader"`다. **탭 클릭은 `setActiveTab("trader")`만 실행하며 별도 API 호출이 없다.** 검색 시 수집한 공식 일봉, KIS 현재시세, KIS 투자자 수급을 사용한다.

### 사용하는 API 결과

- `/api/price`: 공식 OHLCV 260행
- `/api/realtime`: KIS 마지막 조회가, 등락, 거래량, 고가, 저가
- `/api/investor`: 외국인·기관·합계 추정 순매수

### 프론트에서 계산하는 기술 값

`app/page.tsx`에서 직접 계산한다.

- MA5/20/60/120/200, MA20·MA60 기울기
- 최근 고점·저점 방향
- RSI14
- EMA12/26, MACD, Signal, Histogram
- 5/20/60일 모멘텀과 단기 일별 모멘텀
- 20일 평균 거래량 및 거래량 비율
- 캔들 방향, 가격·거래량 방향 보정
- ATR14, 20일 변동성
- 52주 고가·저가 및 현재 위치
- 모멘텀·추세·거래량·MACD·RSI·52주 점수
- reversal bonus, 과열/위험 penalty
- 최종 `finalTechnicalScore`

이 로직은 `lib/technical-strength.mjs`의 Model A 공식과 유사하지만, 개별 화면은 해당 라이브러리를 import하지 않고 별도 구현을 유지한다. 따라서 공식 변경 시 화면 계산과 snapshot 계산이 어긋날 위험이 있다.

KIS 투자자 수급 route는 프론트 계산 대신 응답값을 Number로 바꾸며, 누락값을 0으로 반환한다.

## 4. 지표별 계산 위치

| 데이터/지표 | 현재 계산 위치 | 파일 |
|---|---|---|
| 종목 검색·기본정보 | 외부 API 결과 전달 | `app/api/stock/route.ts` |
| 공식 OHLCV 정렬·필터 | API route | `app/api/price/route.ts` |
| KIS 시세 파싱·시장상태 일부 | API route | `app/api/realtime/route.ts` |
| DART 계정 추출·CAGR·FCF·이자보상 | API route | `app/api/financial/route.ts` |
| KIS 투자자 수급 숫자 변환 | API route | `app/api/investor/route.ts` |
| MA/RSI/MACD/ATR/모멘텀/52주 위치 | 프론트 | `app/page.tsx` |
| 개별 화면 기술적 강도 | 프론트 | `app/page.tsx` |
| 기업분석 4영역 및 총점 | 프론트 | `app/page.tsx` |
| A/B/C/D snapshot 점수 | 서버/배치 라이브러리 | `lib/model-score-engine.mjs` 및 모델 파일 |
| A/B/C/D 순위·TOP 목록 | 서버/배치 | `lib/model-history-schema.mjs`, snapshot 생성 스크립트 |
| TOP API 필터·정렬 | 서버 route, 저장 rank 조회 | `app/api/top-stocks/route.ts` |
| TOP 화면 표시 | 프론트 별도 컴포넌트 | `components/TopStocksPanel.tsx` |

## 5. 동일 종목 재조회 시 재호출·재계산

동일 종목을 다시 검색해도 다음이 다시 실행된다.

- 공공 상장종목 검색 API
- 공식 일봉 260행 API
- KIS OAuth 발급 + 현재시세 API
- DART 재무 route 호출(외부 fetch는 Next cache에 의해 최대 1시간 재사용 가능)
- KIS OAuth 발급 + 투자자 수급 API
- realtime interval 재설정 및 이후 5초 반복
- 모든 프론트 기술지표·기업점수 재계산

브라우저 종목별 memo/cache, 서버 종목별 메모리 cache, 조회 결과 JSON cache는 없다. React state는 현재 선택 종목 한 건만 보유하고 검색 변경 때 대부분 초기화된다.

탭만 B/C/A/D TOP 모델 사이에서 전환하면 `/api/top-stocks`는 매번 history JSON을 다시 읽고 결과를 다시 구성한다. 응답과 클라이언트 fetch 모두 `no-store`다.

## 6. 현재 캐시·메모리·JSON·DB 사용 여부

### 존재

- React component state: 현재 종목의 검색·가격·재무·수급 결과, 페이지 수명 동안만 유지
- DART 외부 fetch: `next: { revalidate: 3600 }`
- `data/corp-map.json`: 종목코드→DART corp code 정적 매핑
- `data/history/*.json`: A/B/C/D 점수·순위 snapshot
- `data/universe.json`, `data/model-registry.json`, 거래일 상태 및 검증용 JSON
- snapshot 생성기의 `requestCache`: 배치 프로세스 한 번 안에서만 동일 일봉 요청 중복 방지

### 실질적으로 없음 또는 미사용

- `app/api/financial/route.ts`의 `corpCodeCache` 변수는 선언만 되고 사용되지 않음
- KIS access token cache 없음
- `/api/stock`, `/api/price`, `/api/realtime`, `/api/top-stocks`는 no-store
- `/api/investor`에 명시적 cache 정책 없음
- Redis/SQLite/PostgreSQL 등 DB 없음
- 종목별 사전 계산된 기업분석 snapshot 없음
- 종목별 사전 계산된 기술지표 snapshot 없음(TOP history의 factors/score는 존재하지만 개별 화면 조회 구조로 연결되지 않음)

## 7. 현재가·공식 종가·재무 기준일 혼용

가장 중요한 혼용 지점은 `liveCurrentPrice`다.

```text
liveCurrentPrice = KIS lastQuotedPrice ?? officialDailyClose
```

이 값이 여러 기술지표와 valuation 계산에 들어간다. 따라서 같은 필드/점수가 장중에는 KIS 조회가 기준이고, KIS 실패 시 최근 공식 종가 기준이 된다.

| 구간 | 혼용 내용 | 위험 |
|---|---|---|
| 기술지표 | 최신 OHLCV 배열 첫 가격 일부를 KIS 조회가로 치환 | 공식 일봉 기반 snapshot 점수와 개별 화면 점수가 다를 수 있음 |
| PER/PBR | `marketCap`은 상장정보 응답, 분모는 2025 DART 재무, 표시 가격은 별도 | 서로 다른 기준일 자료로 valuation 구성 |
| 현재가 카드 | KIS가 없으면 공식 종가 표시 | 라벨은 개선됐지만 downstream 계산에서는 동일 `liveCurrentPrice`로 합쳐짐 |
| 거래량/고가/저가 | KIS가 있으면 장중/마지막 조회 값, 없으면 공식 일봉 | ATR·거래량 점수의 기준이 요청 성공 여부에 따라 달라짐 |
| 재무 | DART `year: 2025`만 반환 | 공시 접수일·재무 기준일·generatedAt·qualityStatus가 없음 |
| TOP | history의 `closePrice`와 snapshot 날짜 | 공식 종가로 분리돼 있어 현재 개별 화면보다 안정적 |

권장 원칙은 `officialClosePrice`, `lastQuotedPrice`, `financialPeriodEnd`를 절대 같은 필드로 합치지 않는 것이다. 분석 snapshot은 명시된 공식 종가 기준으로 고정하고, 실시간/마지막 조회가는 표시 전용 overlay로 둬야 한다.

## 8. API 실패 시 이전 값 또는 fallback 위험

| 위치 | 현재 동작 | 위험도 |
|---|---|---|
| 검색 시작 | 가격·재무·수급은 null로 초기화하지만 `stockInfo`와 `searchedStock`은 즉시 null로 만들지 않음 | `/api/stock` 실패 시 이전 종목명/기본정보 UI 일부가 남을 수 있음 |
| 공식 가격 실패 | 가격/내역/meta null, 오류 표시 | 이전 가격을 조용히 유지하지 않음 |
| KIS 시세 실패 | realtime null, 오류 표시 | 이전 시세를 조용히 유지하지 않음 |
| KIS 실패 후 계산 | `liveCurrentPrice`가 공식 종가로 fallback | 표시 라벨은 구분되지만 계산 기준이 자동으로 바뀜 |
| financial fetch catch | financial null | catch에 requestId/code guard가 없어 오래된 요청 실패가 새 종목 재무 state를 null로 만들 가능성 |
| investor effect | 응답에 requestId/code guard 없음 | 빠른 연속 검색에서 이전 종목 수급이 새 종목 state를 덮을 가능성 |
| investor route | 누락 output을 0으로 변환, HTTP/업무코드 검증 부족 | 장애·데이터 없음이 실제 순매수 0처럼 보일 수 있음 |
| financial route | 오류 시 명시적 오류 JSON이나 프론트는 success가 아니면 null | 기업분석 화면에 데이터 없음과 API 실패 구분이 약함 |
| TOP | 최신 유효 history를 역순 탐색 | 최신 파일이 손상되면 더 오래된 유효 snapshot을 선택할 수 있으며, 날짜는 응답에 명시되지만 “최신” 의미 주의 필요 |

저장 조회 구조에서는 `status: available|stale|missing|failed`, `asOfDate`, `generatedAt`을 함께 반환하고 stale 자료를 최신처럼 조용히 대체하지 않아야 한다.

## 9. 553종목 사전 계산 가능성과 제약

### 사전 계산에 적합

- 종목 기본정보 및 시장/상품분류: 마스터 갱신 주기에 맞춘 snapshot
- 공식 OHLCV: 매 거래일 장 마감 후
- MA/RSI/MACD/ATR/변동성/모멘텀/52주 위치
- A-v1/A-v2/B-v1/C-v1/D-v1 점수·factors·risk flags·순위
- 모델별 TOP10/20/50
- DART 재무 원천값, CAGR, FCF, 이자보상배율
- 공식 종가 기준 기업분석 점수
- 공식 종가/재무 기준일을 고정한 PER/PBR 계열 분석

### 가능하지만 운영 조건 필요

- KIS 투자자 수급: 종목별 호출량·권한·rate limit·업무 응답 기준 검증 필요. 배치 수집은 가능하더라도 정확한 기준시각과 누락 상태를 저장해야 함
- 최신 재무: DART 공시 변경 탐지 또는 일일/주기적 증분 수집 필요. 현재 고정 2025 사업보고서만으로는 “최신”이라 할 수 없음
- 기업분석 점수: 가격 기준을 공식 종가로 고정하면 일별 계산 가능. 장중 현재가를 섞으면 매 시세마다 달라져 snapshot 의미가 불안정함

### 사전 계산 결과를 “현재”로 제공할 수 없음

- KIS 현재시세/마지막 조회가: 장중에는 짧은 TTL quote cache로만 관리 가능하며 분석 snapshot과 분리해야 함
- 장중 누적 거래량·고가·저가 기반 지표: 시점별 snapshot을 명시하지 않으면 재현 불가능
- 거래정지/체결 불가 상태의 실행 가능 가격: reference close를 현재가로 대체할 수 없음

## 10. 권장 갱신 주기

| 데이터 | 권장 주기 | 기준/주의 |
|---|---|---|
| 공식 OHLCV | 거래일 장 마감 후 공식 데이터 게시 확인 뒤 1회 | exact `basDt`, 품질 gate 통과 필수 |
| 기술지표 | 유효 OHLCV ledger 확정 직후 일 1회 | 공식 종가 기반 버전과 장중 지표를 분리 |
| 모델 점수 | 기술지표 snapshot 직후 일 1회 | 공식·가중치 버전 고정, 입력 hash 저장 |
| TOP50 | 모델 점수·순위 확정 직후 일 1회 | 별도 재계산보다 같은 snapshot의 rank 조회 권장 |
| 재무제표 | 일 1회 공시 변경 확인 또는 공시 발생 시 증분 갱신 | 보고서 종류·연결/별도·접수일 저장 |
| 기업분석 점수 | 재무 변경 시 + 공식 종가 확정 후 일 1회 | 재무 기준일과 가격 기준일 모두 기록 |
| 투자자 수급 | 목적에 따라 장 마감 후 일 1회 권장 | 추정/확정 구분, KIS 호출 제한 확인 |
| 현재 시세 | 사용자 명시 요청 시 또는 장중 5~30초 TTL shared cache | 토큰 공유, 시장 휴장 시 호출 중단, snapshot과 분리 |

현재처럼 모든 화면에서 5초 polling을 기본 수행하는 것보다, 장중이며 해당 종목 가격 카드가 보일 때만 polling하거나 사용자가 새로고침을 요청하는 정책이 안전하다.

## 11. 권장 데이터 스키마

모든 결과 envelope에 다음 공통 메타데이터를 둔다.

```json
{
  "schemaVersion": 1,
  "source": { "provider": "...", "dataset": "...", "priceBasis": "..." },
  "asOfDate": "YYYY-MM-DD",
  "generatedAt": "ISO-8601",
  "qualityStatus": "certified|provisional|stale|missing|failed",
  "qualityReasons": [],
  "records": []
}
```

### 11.1 종목 기본정보

```json
{
  "code": "005930",
  "name": "삼성전자",
  "market": "KOSPI",
  "securityType": "commonStock",
  "listingStatus": "listed",
  "listedAt": null,
  "marketCap": { "value": 0, "asOfDate": "YYYY-MM-DD", "source": "..." }
}
```

### 11.2 일별 공식 가격

```json
{
  "code": "005930",
  "tradingDate": "YYYY-MM-DD",
  "openPrice": 0,
  "highPrice": 0,
  "lowPrice": 0,
  "officialClosePrice": 0,
  "volume": 0,
  "tradingValue": 0,
  "marketCap": 0,
  "executable": true,
  "priceStatus": "validTradingRow"
}
```

### 11.3 기술지표 snapshot

```json
{
  "code": "005930",
  "indicatorAsOfDate": "YYYY-MM-DD",
  "inputPriceBasis": "officialDailyClose",
  "inputHistoryHash": "sha256",
  "indicators": {
    "ma5": null, "ma20": null, "ma60": null, "ma120": null,
    "rsi14": null, "macd": null, "signal": null, "histogram": null,
    "atr14": null, "volumeRatio20": null, "momentum20": null,
    "position52w": null
  }
}
```

### 11.4 기업분석 snapshot

```json
{
  "code": "005930",
  "financialPeriodEnd": "YYYY-MM-DD",
  "financialReportType": "annual|quarterly",
  "financialStatementScope": "CFS|OFS",
  "valuationPriceBasis": "officialDailyClose",
  "valuationPriceAsOfDate": "YYYY-MM-DD",
  "rawFinancials": {},
  "metrics": { "roe": null, "debtRatio": null, "per": null, "pbr": null },
  "scores": {
    "profitability": null, "growth": null, "stability": null,
    "valuation": null, "total": null
  },
  "formulaVersion": "company-analysis-v1"
}
```

### 11.5 모델 점수·순위

기존 history schema를 유지한다. `scores`, `ranks`, `factors`, `riskFlags`, `modelDefinitions`, `sourceManifest`, `dataQuality`, `rankingUniverseCount`를 그대로 조회 원천으로 사용한다. 새 개별 조회 index를 만들더라도 기존 snapshot을 수정하지 않고 code→record read index만 별도 생성한다.

### 11.6 실시간 또는 마지막 조회 시세

```json
{
  "code": "005930",
  "lastQuotedPrice": 0,
  "quoteAsOfDate": "YYYY-MM-DD",
  "quoteAsOfTime": "HH:mm:ss",
  "receivedAt": "ISO-8601",
  "marketStatus": "open|closed|unknown",
  "isRealtime": false,
  "expiresAt": "ISO-8601"
}
```

`lastQuotedPrice`를 `officialClosePrice`에 복사하지 않는다. TTL 만료 시 stale 상태를 명시한다.

## 12. JSON 유지와 DB 이전 비교

| 항목 | JSON 파일 | 정식 DB |
|---|---|---|
| 초기 구현 | 단순, 현재 구조 재사용 쉬움 | schema/migration/운영 준비 필요 |
| Git/백업 | 작은 설정·snapshot은 투명 | dump/backup 체계 별도 필요 |
| 553종목 일별 데이터 | 초기에는 가능 | 장기 시계열에 적합 |
| 종목별 최신 조회 | 파일 전체 parse 또는 별도 index 필요 | code/date index로 빠름 |
| 동시 쓰기 | lock·atomic rename 직접 구현 | transaction/constraint 지원 |
| 중복·무결성 | 응용 코드 검증 의존 | PK/FK/unique/check constraint 가능 |
| 증분 갱신 | 파일 전체 교체가 잦음 | row upsert/partition 가능 |
| 분석 쿼리 | Node 스크립트로 전체 로드 | SQL 집계/기간 비교 용이 |
| 서버리스 배포 | repository read는 쉬우나 runtime write 제약 | managed DB 연결 필요 |
| 규모 | 일별 snapshot 몇 개까지 적합 | 수년 OHLCV·수급·재무에는 유리 |

### 권장

최소 단계는 JSON으로 시작할 수 있다. 다만 파일을 목적별로 분리하고 immutable daily artifact + latest index 구조를 사용해야 한다. 예:

```text
data/security-master/YYYY-MM-DD.json
data/market-prices/YYYY-MM-DD.json
data/technical-indicators/YYYY-MM-DD.json
data/company-analysis/YYYY-MM-DD.json
data/history/YYYY-MM-DD.json
data/latest-index.json
```

장기적으로 수년치 OHLCV, 재무 공시 버전, 투자자 수급, 종목별 조회를 지원하려면 PostgreSQL 같은 DB가 적합하다. JSON schema를 먼저 안정화하고 동일 필드로 DB table을 설계하면 단계적 이전이 가능하다.

## 13. 조회 전용 전환 시 수정/추가 대상

### 기존 파일

- `app/page.tsx`: 프론트 계산 제거, 조회 응답 렌더링, quote를 별도 선택적 요청으로 분리
- `app/api/stock/route.ts`: 외부 검색 대신 저장된 security master 조회
- `app/api/price/route.ts`: 외부 호출 대신 저장된 공식 가격/지표 조회
- `app/api/financial/route.ts`: DART 호출 대신 저장된 재무/기업분석 snapshot 조회
- `app/api/investor/route.ts`: 저장된 수급 snapshot 조회 및 missing/failed 구분
- `app/api/realtime/route.ts`: shared token/TTL quote cache를 이용한 명시적 예외 경로
- `app/api/top-stocks/route.ts`: latest index 또는 지정 snapshot 한 번만 읽도록 개선 가능
- `components/TopStocksPanel.tsx`: 현재 조회 전용 구조 유지, freshness 메타데이터 강화
- `package.json`: 배치 및 검증 명령 추가

### 권장 신규 파일

- `lib/company-analysis.mjs`: 현재 프론트 기업점수 공식을 변경 없이 서버 재사용 가능하게 분리
- `lib/indicator-snapshot.mjs`: 공식 OHLCV→표시용 기술지표 산출
- `lib/snapshot-read-store.mjs`: JSON/DB 구현을 숨기는 read interface
- `lib/data-envelope.mjs`: source/asOfDate/generatedAt/qualityStatus 공통 검증
- `scripts/create-company-analysis-snapshot.mjs`
- `scripts/create-indicator-snapshot.mjs`
- `app/api/research/[code]/route.ts` 또는 기업/기술별 명시적 read routes
- JSON 사용 시 `data/company-analysis/`, `data/technical-indicators/`, `data/security-master/`

## 14. 보호 대상을 건드리지 않는 최소 구현 순서

1. **계약 정의**: source/asOfDate/generatedAt/qualityStatus와 가격 필드 분리 schema를 문서·validator로 확정한다.
2. **read store 추가**: 기존 history와 신규 JSON을 읽는 read-only interface를 만든다. A/B/C/D 공식 및 history 파일은 수정하지 않는다.
3. **기업분석 공식 추출**: `page.tsx`의 현 계산을 값 변경 없이 `lib/company-analysis.mjs`로 옮기고 parity 합성 테스트를 만든다. 이 단계에서 운영 화면은 아직 기존 경로를 유지할 수 있다.
4. **기술지표 표시 snapshot 분리**: 모델 공식과 별개로 개별 화면 표시용 indicator schema를 만든다. 필요하면 기존 Model A 결과를 참조하되 공식 파일은 변경하지 않는다.
5. **과거 입력 없는 신규 daily artifact 생성기**: 기존 공식 OHLCV 품질 gate의 메모리 결과에서 기업/지표 artifact를 생성하도록 설계한다. 기존 history 생성은 그대로 둔다.
6. **조회 API 추가**: 저장 파일이 없으면 명시적 `DATA_NOT_AVAILABLE`/`STALE_DATA`를 반환하며 외부 API fallback을 하지 않는다.
7. **프론트 전환**: 검색은 security master + 저장 분석 조회만 수행하고, 탭은 state 표시만 한다. source/date/quality를 영역별로 표시한다.
8. **실시간 시세 분리**: 사용자가 요청하거나 장중 가격 카드가 보일 때만 `/api/realtime`을 사용한다. 실패해도 공식 분석 snapshot은 변하지 않는다.
9. **병렬 검증**: 기존 화면 계산과 저장 계산의 parity를 일정 기간 비교한 뒤 기존 계산 블록을 제거한다.
10. **DB 이전 선택**: JSON 조회/용량/동시성 지표를 측정한 뒤 read store 구현만 DB adapter로 교체한다.

이 순서는 `lib/technical-strength.mjs`, A-v2/B/C/D 공식, `history:resolve`, futureReturns, backtestReturns, 기존 snapshot을 수정하지 않는다.

## 15. 외부 API 호출량과 KIS 토큰 감소 방안

### 현재 구조의 문제

한 종목 검색 직후 KIS token은 최소 2번 발급된다.

- 현재시세 route 1번
- 투자자 수급 route 1번

이후 선택 종목이 유지되면 realtime polling 때문에 약 12회/분 token 발급이 추가된다. 브라우저 탭 수와 사용자가 늘면 선형으로 증가한다.

### 권장

1. **서버 KIS token manager**: token과 만료시각을 메모리/공유 cache에 저장하고 만료 직전에만 재발급한다.
2. **single-flight 발급**: 동시에 여러 요청이 token을 요구해도 한 Promise만 발급하고 나머지는 기다린다.
3. **공유 quote TTL cache**: `(code, endpoint)`별 5~30초 cache로 같은 종목의 중복 조회를 합친다.
4. **visibility/active guard**: 브라우저가 숨겨졌거나 가격 영역이 보이지 않으면 polling을 멈춘다.
5. **시장상태 guard**: 주말뿐 아니라 거래일 상태 원장을 이용해 휴장/장마감 시 polling하지 않는다.
6. **명시적 quote 요청**: 기업/시장 분석 snapshot 조회와 현재시세 요청을 분리한다.
7. **배치 증분 수집**: 공식 OHLCV와 재무는 사용자 요청이 아니라 서버 배치가 한 번 수집한다.
8. **검색 master 로컬화**: `/api/stock`을 저장된 security master 검색으로 바꿔 공공 API 호출을 제거한다.
9. **DART 증분 갱신**: 공시 변경 종목만 다시 수집하고 동일 report hash는 재계산하지 않는다.
10. **실패 cache**: 인증 오류는 짧은 negative cache와 circuit breaker로 무한 재시도를 막되, 실패를 데이터 0으로 반환하지 않는다.

## 권장 최종 요청 흐름

```text
사용자 검색
  → 로컬 security master 조회
  → code별 latest analysis envelope 조회
  → 기업분석/시장분석/TOP 탭은 받은 snapshot 표시만 수행

사용자가 현재시세 요청
  → shared KIS token manager
  → short-TTL quote cache
  → lastQuotedPrice overlay 표시
  → 저장된 official-close 분석값은 변경하지 않음
```

## 최종 판단

현재 TOP 화면은 history 기반 조회 전용에 가깝지만, 개별 종목 기업분석·시장분석은 검색 시 외부 호출과 브라우저 계산에 의존한다. 가장 먼저 해야 할 일은 DB 도입이 아니라 **가격 기준을 분리한 공통 저장 계약과 read interface를 확정하는 것**이다. 이후 공식 OHLCV 기반 기술지표와 기업분석 결과를 immutable daily snapshot으로 쌓고, 검색/탭을 read-only로 전환하는 것이 기존 모델과 백테스트 보호 범위를 가장 작게 유지한다.
