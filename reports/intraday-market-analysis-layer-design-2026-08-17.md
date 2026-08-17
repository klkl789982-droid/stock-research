# 장중 시장분석 레이어 정밀 설계 보고서

## 1. 결론

공식 `market-analysis-v1`은 그대로 장 마감 공식 OHLCV 계층으로 유지해야 한다. 현재 `/api/realtime` 응답은 마지막 조회가·당일 고가/저가·누적 거래량·전일 대비를 제공하지만 시가를 반환하지 않고, 체결 여부와 신뢰 가능한 시장 개장 상태도 제공하지 않는다. 따라서 현 상태만으로 장중 분석을 “실시간” 또는 “장중 확정”이라고 부를 수 없다.

권장 구조는 공식 snapshot과 분리된 compact seed 및 `intraday-market-analysis-v1` display-only API다. seed가 없거나 quote 기준일/시각과 공식 거래일 상태를 검증할 수 없으면 계산을 차단한다. 공식 점수로 조용히 대체하지 않는다.

## 2. 현재 KIS로 확보 가능한 데이터

| 항목 | 현재 route 출력 | KIS 원문 필드 | 직접 확인/추정 | 판정 |
|---|---:|---|---|---|
| 종목코드 | `code` | 요청 code, 선택적으로 `stck_shrn_iscd` 검증 | 요청값 + 원문 교차검증 | 응답 필드가 있을 때 신뢰 가능 |
| 마지막 조회가 | `price` | `stck_prpr` | 직접 확인 | 유효 양수 검증 |
| 시가 | 없음 | 현재 route가 읽지 않음 | 확인 불가 | 장중 OHLC 구성 불완전 |
| 고가 | `high` | `stck_hgpr` | 직접 확인 | finite만 검증 |
| 저가 | `low` | `stck_lwpr` | 직접 확인 | finite만 검증 |
| 누적 거래량 | `volume` | `acml_vol` | 직접 확인 | finite만 검증 |
| 전일 대비 | `change` | `prdy_vrss` | 직접 확인 | finite 검증 |
| 등락률 | `rate` | `prdy_ctrt` | 직접 확인 | finite 검증 |
| 시세 기준일 | `asOfDate` | `stck_bsop_date` | 원문이 8자리일 때 직접 확인 | 원문 누락/형식 불일치 시 null |
| 시세 기준시각 | `asOfTime` | `stck_cntg_hour` | 원문이 6자리일 때 직접 확인 | 원문 누락/형식 불일치 시 null |
| 서버 수신시각 | `responseAt` | 없음 | 서버 `Date.now()` | 거래소 체결시각이 아님 |
| 시장상태 | `closed/unknown` | 사용하지 않음 | 서울 기준 서버 요일로 주말만 추정 | 평일은 항상 unknown |
| 실시간 여부 | 항상 `false` | 검증 근거 없음 | 보수적 상수 | 실시간 단정 방지 |
| 체결 여부 | 없음 | 사용하지 않음 | 확인 불가 | 거래정지/무체결 판정 불가 |

현재 route는 KIS `inquire-price`, TR `FHKST01010100`을 호출한다. `asOfDate/asOfTime`이 null인 이유는 원문의 `stck_bsop_date/stck_cntg_hour`가 없거나 형식 검증을 통과하지 못했기 때문이다. `marketStatus`는 토·일만 서버의 서울 요일로 `closed`, 평일은 `unknown`이다. `isRealtime=false`는 시세 freshness·시장상태를 인증할 근거가 없어서 의도적으로 고정돼 있다.

주말은 달력상 식별 가능하지만, KIS 성공만으로 장중·장 마감·공휴일·거래정지·실제 체결을 구분할 수 없다. 공식 `data/trading-calendar/status.json`의 해당 날짜 `tradingDay/marketClosed` 상태, 산출물 상태, quote 기준일 일치가 최소 추가 근거다. 거래정지는 별도의 종목별 거래상태 또는 체결/누적거래량 변화 근거가 필요하며 현재 데이터만으로 확정하면 안 된다.

## 3. 현재 공식 snapshot만으로 incremental 계산 가능한가

현재 market snapshot은 최종 indicators, componentScores, chartData 60개를 저장한다. chartData에는 date/close/MA5/20/60/volume/up만 있고 원시 260일 고가·저가·시가와 전체 close/volume 배열이 없다. 따라서 당일 봉 하나를 정확히 교체/추가해 전체 공식을 재현할 수 없다.

| 지표 | 현재 snapshot만으로 정확 갱신 | 필요한 추가 상태 |
|---|---|---|
| MA5/20/60 | 제한적으로 불가 | 각 window의 직전 N개 close 또는 합계와 탈락 close |
| MA120/200 | 불가 | 120/200 close window 또는 합계+탈락값 |
| MA20/60 기울기 | 불가 | 현재/직전 window 합계와 경계 close |
| RSI14 | 불가 | 직전 14개 gain/loss 또는 Wilder state와 기존 공식 방식 명시 |
| EMA12/26 | 이론상 가능 | 직전 EMA12/26과 seed 기준일 |
| MACD Signal/Histogram | 불가 | 직전 EMA12/26, Signal9, 이전 Histogram |
| 5/20/60 모멘텀 | 불가 | 정확한 5/20/60 거래일 기준 close |
| 거래량 비율 | 불가 | 직전 20일 volume window/합계와 당일 누적 거래량 |
| ATR14 | 불가 | 직전 close, 최근 13~14 TR 또는 ATR state |
| 20일 변동성 | 불가 | 최근 20 수익률의 합·제곱합과 경계 close 또는 배열 |
| 52주 위치 | 불가 | 260일 high/low deque 또는 전체 high/low window와 만료 정보 |
| OBV | 불가 | 직전 OBV, 직전 close와 기준일 |
| reversal bonus/penalty | 불가 | RSI, Histogram, MA20, 3/5일 수익률, ATR%, 변동성, 이격도 모두 필요 |
| finalTechnicalScore | 불가 | 위 모든 지표와 동일 v1 점수 입력 |

## 4. OHLCV 260행과 compact seed 비교

### 최근 260일 정규화 OHLCV 별도 저장

장점은 공식 계산기를 그대로 재사용해 당일 관측 봉을 메모리에서 한 행 추가/교체할 수 있고, 공식 결과와 장중 결과의 차이를 설명·재현하기 쉽다는 것이다. 공식 변경 시 seed 재설계가 덜 필요하다. 단점은 종목당 저장량, 읽기 비용, 기업/사용자에게 불필요한 원시 이력 노출 위험이다.

### Compact seed

저장량과 계산량은 작지만 공식의 각 window와 EMA 초기화 방식을 정확히 고정해야 한다. 공식이 바뀌면 seedVersion도 바뀌고, 52주 rolling extreme 만료처럼 단일 min/max만으로 해결되지 않는 지표가 있다. seed 생성 오류를 원시 배열 없이 사후 감사하기도 어렵다.

현 단계 권장은 별도 seed 파일에 최소 재현 window를 저장하는 절충안이다. 즉 “몇 개의 합계만” 저장하지 말고 최근 260일의 필요한 필드(`date, open, high, low, close, volume`)를 compact tuple로 보관한다. 이는 계산용 seed이며 공식 snapshot/history가 아니다.

권장 경로: `data/analysis/market-seeds/YYYY-MM-DD.json`

```json
{
  "schemaVersion": 1,
  "seedType": "intradayMarketAnalysisSeed",
  "asOfDate": "YYYY-MM-DD",
  "officialCalculatorVersion": "market-analysis-v1",
  "sourceManifestHash": "...",
  "records": [{
    "code": "005930",
    "officialAsOfDate": "YYYY-MM-DD",
    "rows": [["YYYYMMDD", 0, 0, 0, 0, 0]],
    "rowOrder": "descending",
    "rowCount": 260,
    "contentHash": "..."
  }],
  "contentHash": "..."
}
```

별도 파일을 권장하는 이유는 공식 market snapshot schema와 contentHash를 바꾸지 않고 기존 공식 결과를 보존할 수 있기 때문이다. seed는 동일 공식 OHLCV 수집 과정에서 추가 API 없이 만들어야 하며 공식 snapshot 실패와 동일한 품질 검증을 거쳐야 한다. 기존 과거 snapshot에 사후 생성하지 않는다.

순수 compact sufficient state를 택한다면 최소한 다음이 필요하다.

- close windows: 최근 200개와 5/20/60 모멘텀 경계 close
- slope: 21/61개 close 또는 각 현재·직전 합계와 양쪽 경계값
- RSI: 최근 15 close 또는 14 gain/loss 배열
- MACD: EMA12, EMA26, Signal9, 이전 Histogram 및 초기화 기준일
- volume: 최근 20 volume 배열/합계
- ATR: 직전 close와 최근 14 TR 배열
- volatility: 최근 21 close 또는 20 return 배열, 합, 제곱합
- 52주: 260 high/low monotonic deque에 날짜·만료순서 포함
- OBV: 직전 OBV와 직전 close
- penalty: 최근 3일 return, 5일 기준 close, MA20 distance 입력

결국 현재 공식의 단순 재현성과 감사 가능성을 고려하면 260 tuple seed가 안전하다.

## 5. 검색 시 `/api/price` 260행 제거 조건

현재 검색은 `/api/price`를 호출해 최근 종가 카드, 전일 종가, 시가총액, 시가/고가/저가를 표시하고 `priceHistory`를 보유한다. 다음 조건이 모두 충족돼야 제거할 수 있다.

1. 공식 최근 가격 카드를 market-price ledger 또는 별도 official quote read API가 제공한다.
2. 전일 종가와 exact-date 시가총액이 저장 read model에 존재한다.
3. 기업분석과 시장분석은 이미 저장 결과만 사용한다.
4. 장중 분석은 seed+KIS quote만 사용한다.
5. `/api/price`가 담당하던 기준일·stale/누락 오류 상태가 새 API에 보존된다.

이전까지 `/api/price`를 제거하면 KIS 실패 시 공식 최근 종가 표시 근거도 함께 사라진다.

## 6. Quote cache와 single-flight

서버 전용 `KisQuoteProvider` 인터페이스를 두고 `/api/realtime`과 장중 분석 API가 동일 `getQuote(code)`를 호출하도록 한다.

```text
Map<code, { quote, receivedAt, expiresAt, generation }>
Map<code, Promise<Quote>> inFlight
```

- 캐시 유효 시 동일 quote 반환
- 만료 후 첫 요청만 KIS 호출, 동시 요청은 같은 Promise 공유
- 실패 Promise는 제거하고 실패를 quote 0/null로 캐시하지 않음
- quote의 KIS 기준일/시각과 서버 receivedAt을 분리
- 늦은 이전 generation 응답이 새 cache를 덮지 못하게 함
- token manager의 single-flight와 별도 계층으로 유지

TTL은 시장상태를 공식 확인할 때만 확정한다.

- 공식 장중 확인: 3~5초 제안
- 공식 장 마감 확인: 5~30분 제안 또는 해당 기준일 불변 cache
- 주말/공식 휴장 확인: 다음 상태 재검증 시점까지 30~60분 제안
- 상태 unknown/기준시각 없음: 장기 cache 금지, 5초 내외의 요청 중복 억제용 TTL만 사용하고 장중 분석은 차단

로컬 단일 Node에서는 모듈 Map으로 충분하다. Vercel에서는 인스턴스별 cache/token이 분리되므로 공유 Redis/KV 같은 quote cache, per-symbol distributed single-flight/lock, TTL, generation 또는 compare-and-set이 필요하다. 현재 단계에서는 도입하지 않는다.

## 7. 권장 API 구조

권장 API는 `GET /api/intraday-market-analysis?code=005930`이다. 이 API 내부에서 seed를 읽고 공용 quote provider를 한 번 호출해 quote와 장중 계산을 한 응답으로 반환한다. UI가 `/api/realtime`과 별도로 둘 다 호출하면 동일 순간의 quote 불일치와 중복 호출 가능성이 있으므로, 장중 분석 카드가 활성화된 경우 통합 응답이 더 안전하다. 기존 최근 시세 카드가 별도 route를 유지해도 provider cache/single-flight가 중복 호출을 막는다.

```json
{
  "status": "provisional",
  "quote": {
    "priceBasis": "kisLastQuotedPrice",
    "asOfDate": null,
    "asOfTime": null,
    "receivedAt": "ISO-8601",
    "marketStatus": "unknown"
  },
  "officialReference": {
    "calculatorVersion": "market-analysis-v1",
    "asOfDate": "YYYY-MM-DD",
    "finalTechnicalScore": 0
  },
  "intradayAnalysis": {
    "calculatorVersion": "intraday-market-analysis-v1",
    "displayOnly": true,
    "eligibleForRanking": false,
    "eligibleForBacktest": false,
    "eligibleForOptimization": false,
    "qualityStatus": "PROVISIONAL",
    "score": null,
    "blockingReasons": []
  }
}
```

빠른 검색과 polling은 클라이언트 requestId+selected code guard, AbortController, 종목 변경/unmount timer 정리, hidden 중단, 제한 backoff를 유지한다. 서버는 per-code generation으로 늦은 quote의 cache overwrite를 막는다.

## 8. 두 계층의 데이터 흐름

```text
공식 공공 일봉 → 품질 게이트 → market-analysis-v1 → 공식 snapshot
                                              ├→ TOP/모델/백테스트
                                              └→ 공식 UI 카드

동일 검증 OHLCV → 별도 seed ─┐
KIS quote provider/cache ─────┼→ intraday-market-analysis-v1 → display-only UI
공식 거래일 상태 원장 ────────┘
```

장중 결과는 공식 snapshot, history, TOP cache 어느 곳에도 쓰지 않는다.

## 9. 상태별 UI 라벨

| 상태 | 공식 카드 | 장중 참고 카드 |
|---|---|---|
| 공식 장중 확인 + 기준일/시각 일치 | `공식 분석 · 전 거래일 종가 기준` | `장중 참고 · KIS 마지막 조회 YYYY-MM-DD HH:mm:ss` |
| KIS 성공, 시장상태 unknown | 기존 공식 라벨 | `시장 상태 미확인 · 장중 점수 계산 중단` |
| 공식 장 마감 확인 | `공식 분석은 당일 snapshot 생성 후 갱신` | `장 마감 후 참고 시세 · 공식 확정 전` 또는 숨김 |
| 주말 | 공식 최신 거래일 표시 | `휴장 · 마지막 KIS 조회값(장중 분석 아님)` |
| 공식 공휴일 | 공식 최신 거래일 표시 | `공식 휴장일 · 장중 분석 없음` |
| 거래정지 확인 | 공식 최신 분석 표시 | `거래정지 · 장중 분석 불가` |
| quote 기준일/시각 미확인 | 공식 독립 표시 | `시세 기준시각 미확인 · 계산 불가` |
| KIS 실패 | 공식 독립 표시 | `KIS 조회 실패 · 이전 장중 값을 유지하지 않음` |
| 공식 snapshot 없음 | `공식 분석 결과 없음` | seed와 공식 기준선이 없으므로 `장중 분석 불가` |
| seed 없음 | 공식 결과 정상 표시 가능 | `장중 계산 seed 없음` |

“실시간”은 거래소 실시간성 계약과 기준시각이 확인되지 않는 한 사용하지 않는다.

## 10. 예상 수정 파일

- 신규 `lib/kis-quote-provider.ts` 및 core 합성 테스트
- 신규 `lib/intraday-market-analysis-v1.mjs`
- 신규 `lib/intraday-market-analysis-seed.mjs`
- 신규 `app/api/intraday-market-analysis/route.ts`
- `app/api/realtime/route.ts`: 공용 quote provider 사용
- `scripts/create-daily-model-snapshot.mjs`: 동일 검증 입력에서 별도 seed 생성
- `components/market-analysis/MarketAnalysisPanel.tsx` 또는 별도 Intraday panel
- `app/page.tsx`: polling 응답·stale guard 연결 및 `/api/price` 단계적 제거
- 관련 schema/API/UI/cache/결정론 테스트와 문서

공식 `market-analysis-v1`, 모델 공식, resolver는 수정 대상이 아니다.

## 11. 최소 구현 순서와 테스트

1. KIS raw fixture로 현재 필드 존재/누락 characterization
2. quote provider cache/single-flight/generation/실패 테스트
3. 별도 seed schema와 260 tuple 결정론/hash 테스트
4. 동일 공식 OHLCV에 가상 당일 봉을 결합한 intraday calculator 구현
5. full 261-row 재계산과 incremental 결과의 fixture 일치 검증
6. 거래일 status/quote date/time 차단 테스트
7. API에 display-only·비적격 메타데이터 강제
8. UI 독립 카드와 상태 라벨·stale response 테스트
9. `/api/realtime` 중복 KIS 호출 0회 검증
10. 공식 snapshot/TOP/history/model hash 불변 회귀

필수 사례는 동시 요청 1회, TTL hit/miss, 늦은 응답 보호, 기준일 불일치, 시각 누락, 주말/공휴일/unknown/거래정지, KIS 실패, seed/snapshot 누락, 장중 값이 TOP·백테스트에 유입되지 않음, hidden/unmount/빠른 검색이다.

## 12. 신뢰성 위험과 차단 조건

- 시가가 없으면 완전한 당일 OHLC 봉을 구성할 수 있으므로 현재 route 기준 계산 차단
- quote 기준일/시각 null 또는 seed 다음 거래일과 불일치하면 차단
- trading calendar가 unchecked/collectionFailed면 장중 판정 차단
- KIS 누적 거래량 0만으로 거래정지 판정 금지
- 서버 receivedAt을 체결시각으로 사용 금지
- 공식 seed hash와 공식 snapshot source hash 불일치 시 차단
- formula/seed version 불일치 시 차단
- stale quote를 새 분석처럼 표시 금지
- 시장상태 unknown에서 `실시간/장중` 라벨 금지

## 13. 실제 구현 전에 결정할 항목

1. KIS 원문 fixture에서 시가와 거래상태 필드를 공식 문서대로 추가 채택할지
2. 260 tuple seed와 순수 sufficient-state 중 선택(권장: tuple seed)
3. 장중 카드 활성화 조건: 공식 tradingDay+기준일/시각 필수 여부
4. 장 마감 후 장중 카드 유지/숨김 정책
5. 상태 확인 가능 시 TTL 정책
6. `/api/price` 제거 전 공식 최근 가격 read model 범위
7. Vercel 배포 전 공유 cache/분산 lock 도입 시점
8. 장중 점수를 숫자로 표시할지, 지표 변화만 표시할지

이 결정을 승인하기 전에는 장중 계산 코드를 구현하지 않는 것이 안전하다.
