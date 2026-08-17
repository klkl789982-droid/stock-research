# 신호 데이터 가용시각·실행 타이밍 감사

## 1. 감사 결론

현재 공공 일봉 기반 신호는 T 거래일 장 마감 직후 이용 가능하다고 볼 수 없다. 금융위원회 공식 설명에 따르면 기준일 데이터는 다음 영업일 오후 1시 이후 갱신된다. 따라서 공공 일봉만으로 계산한 T 신호의 안전한 이용 가능 시점은 최소 T+1 13:00 이후이며, T+1 시가보다 늦다. [금융위원회 주식시세정보 공식 페이지](https://www.data.go.kr/data/15094808/openapi.do)

- `futureReturns`: 순수 통계적 예측력 연구에는 사용 가능
- 현재 `backtestReturns`: 공식 공공 일봉만 사용했다면 실행 타이밍이 유효하지 않음
- 현재 T+1 시가 진입 가정: **`EXECUTABLE_TIMING_INVALID`**
- 최종 권장: predictive/executable을 계속 분리하고, 공공 일봉 기반 executable은 기본적으로 **T+2 시가 진입** 정책을 신규 버전으로 추가한다. T+1 시가를 유지하려면 T 장 마감 후 실제 이용 가능한 더 빠른 소스가 별도로 인증되어야 한다.

기존 필드·수익률·공식은 이번 감사에서 수정하지 않았다.

## 2. 체크포인트

- Point-in-time preflight 커밋: `2f3a345d8e955a00510e46874224edbb98eb0fd2`
- 메시지: `chore: add point in time universe preflight`
- push·배포 미실행
- 주식발행정보 V3 권한 승인 후에는 기존 403 manifest를 resume하지 않고 새로운 run-id를 사용해야 한다.

## 3. 데이터 흐름별 가용시각

`UNKNOWN`은 현재 시각이나 `generatedAt`으로 대체하지 않는다.

| source/산출물 | priceBasis·marketDate | published/collected/stored | earliestSafeUseAt | PIT 상태 | ranking | predictive | executable | 현재 가정·문제 |
|---|---|---|---|---|---|---|---|---|
| GetStockPriceInfo 공식 일봉 | 공식 OHLCV, `basDt=T` | 공식 정책: 다음 영업일 13:00 이후; 실제 publishedAt 필드 없음; 별도 collectedAt 없음 | T+1 13:00 이후 exact-date 확인 시 | PROVISIONAL | 가능 | 가능 | T+1 시가 진입 불가 | pipeline은 exact basDt만 확인하지만 게시시각을 저장하지 않음 |
| KIS `/api/realtime` | 마지막 조회가·당일 OHLCV, KIS 기준일/체결시각 | `receivedAt` 저장; sourcePublishedAt UNKNOWN | quote date/time/freshness와 세션 조건 확인 시 표시용 | PROVISIONAL display-only | 불가 | 불가 | 현재 불가 | `marketStatus=unknown`, `isRealtime=false`; 공식 종가 확정 소스가 아님 |
| model snapshot | `official-daily-close`, `asOfDate=T` | `computedAt=generatedAt`; 실제 sourcePublishedAt/collectedAt 분리 없음 | 원천 exact-date 수집 완료 뒤 | 고정 Universe PROVISIONAL | 가능 | 가능 | timing 검증 전 불가 | computedAt은 계산시각이지 T 장마감 신호 존재시각이 아님 |
| market-price ledger | 공식 일봉 open/close, `date=T` | generatedAt·collectedAt·storedAt 없음 | 해당 원천 수집 완료 뒤 | PROVISIONAL | 직접 미사용 | 미래 종가 | 가격은 가능, 신호 timing은 별도 | 가격 자체의 시점과 신호 이용 가능 시점을 검증하지 않음 |
| official market-analysis snapshot | 공식 일봉 종가, `requestedDate=T` | `generatedAt` 있음 | 공식 일봉 도착 후 | PROVISIONAL | 공식 분석 자체는 가능 | 연구 가능 | timing 별도 | 브라우저 계산은 제거됐지만 가용시각 필드 없음 |
| intraday market seed | T까지 공식 OHLCV 260행 | `generatedAt`; source hash 포함 | 공식 snapshot 생성 후 | PROVISIONAL | 불가 | 불가 | 불가 | 장중 display-only 계산의 seed이며 history/TOP과 격리됨 |
| company-analysis snapshot | 재무 point-in-time + 공식 가격 기준일 | filingDate/generatedAt 등 | 공시·가격 양쪽 가용 후 | PROVISIONAL | 현재 모델 ranking과 분리 | 기업 연구 | 직접 불가 | 공시가용시각과 가격가용시각을 단일 execution 신호로 인증하지 않음 |
| trading-calendar status | 요청일 상태·observedBasDt | `checkedAt` | 상태 확인 뒤 | 상태 원장 | 간접 | T+N 계산 | T+N 계산 | checkedAt은 데이터 publishedAt이 아님 |
| `history:resolve` | ledger의 미래 open/close | 실행시각 미저장 | 미래 원장 존재 후 | 사후 enrichment | 불가 | 가능 | timing guard 없음 | 가격 순서는 검증하지만 신호가 entry 전에 알려졌는지 확인하지 않음 |
| `futureReturns` | signal close→T+N close | 사후 resolve | T+N 이후 | 연구용 | 성과집계 | 가능 | 불가 | entry 가정이 없는 순수 상관관계 지표 |
| `backtestReturns` | T+1 open→T+N close | 사후 resolve | T+N 이후 | timing 미인증 | 성과집계 | 해당 없음 | 현재 불가 | T 신호가 T+1 open 전에 존재했다고 가정 |

## 4. 공식 일봉 게시 정책과 현재 pipeline

공식 문서는 T 데이터가 다음 영업일 오후 1시 이후 갱신된다고 설명하며, 다음 날이 휴장일이면 그 다음 영업일에 제공된다고 명시한다. 이는 보장된 개별 레코드 timestamp가 아니라 서비스 게시 정책이다. 실제 행에는 `basDt`가 있지만 `sourcePublishedAt`은 없다.

현재 `history:daily`는 요청일과 응답 최신 `basDt`가 같으면 `tradingDay`, 이전이면 평일 `unchecked`로 처리한다. snapshot 생성기도 모든 종목의 `rows[0].basDt`가 요청일과 정확히 같지 않으면 실패한다. 이전 거래일을 대체 사용하지 않는 freshness 보호는 정상이다.

그러나 다음 정보는 기록되지 않는다.

- 원천의 실제 게시시각
- 첫 성공 수집시각
- 저장 완료시각
- 신호가 사용자 또는 주문 시스템에 이용 가능해진 시각

`generatedAt`/`computedAt`은 계산 실행시각일 뿐 원천 게시시각이나 과거 신호 확정시각이 아니다. sourceManifest에도 `generatedAt`, requestedDate, min/max basDt는 있지만 `sourcePublishedAt`과 `sourceCollectedAt`이 분리돼 있지 않다.

오후 1시 이전 요청에서 최신 `basDt`가 T보다 이전일 가능성은 공식 게시 정책상 존재한다. 현재 pipeline은 이를 `unchecked`/exact mismatch로 차단하지만, 나중에 성공했다고 해서 신호가 T 장마감에 이미 존재했던 것으로 소급할 수는 없다.

## 5. Predictive와 executable 구분

### 순수 통계적 예측력

`futureReturns = signalClose(T) → futureClose(T+N)`은 T 종가 데이터로 계산한 점수와 이후 가격 방향의 통계적 관계를 측정한다. entry나 체결을 주장하지 않으므로 다음 조건으로 연구 사용이 가능하다.

- `eligibleForPredictiveResearch: true`
- `eligibleForExecutableBacktest: false`
- `signalDataAvailableAt`: 실제 확보 시각 또는 UNKNOWN
- `assumedSignalConfirmedAt`: T 종가 기준이라는 연구상 label
- `timingStatus: PREDICTIVE_RESEARCH_ONLY`

이는 “T 종가에 실제 매수 가능했다”는 뜻이 아니다.

### 실제 운용 가능 예측력

실행 평가에는 최소한 `signalDataAvailableAt < entryTimestamp`가 필요하다. 주문 제출 마감이 별도로 있다면 그 이전이어야 한다. 공공 일봉 T 데이터는 T+1 13:00 이후 가용하므로 T+1 09:00 시가 조건을 만족하지 않는다.

따라서 현재 공공 일봉 기반 `backtestReturns`의 타이밍 판정은 다음과 같다.

- `EXECUTABLE_TIMING_INVALID`
- 더 빠른 T일 장마감 데이터가 인증될 경우에만 `VALID_ONLY_WITH_FASTER_SOURCE`
- 공공 일봉만 유지하면 `ENTRY_MUST_BE_SHIFTED`

## 6. 네 가지 운영 정책 비교

| 정책 | 신호 입력 | 실제 확인시각 | 최초 진입 | look-ahead | 신뢰성 | 공식 영향 | 별도 버전 | 권장도 |
|---|---|---|---|---|---|---|---|---|
| A. 검증된 KIS/EOD 소스 | T일 확정 OHLCV | T 장마감 후 인증된 수집시각 | T+1 시가 가능 후보 | 소스 인증 전 존재 | 장마감 정정·API 한도 검증 필요 | 모델 산식 불변 가능 | source/timing policy 필요 | 조건부 |
| B. 공공 일봉 게시 후 진입 | T 공식 OHLCV | T+1 13:00 이후 | T+1 13시 가격, T+1 종가 또는 T+2 시가 | 낮음 | 공식 일봉 재현성 높음 | 산식 불변 | 새 execution policy 필수 | **가장 권장: T+2 시가** |
| C. T-1 확정 데이터 | T-1 공식 OHLCV | T 13:00 이후가 될 수 있어 T 시가에도 늦음 | 게시 정책상 단순 T 시가도 보장 안 됨 | 여전히 존재 | 소스 지연 영향 | 신호일 의미 변경 | 별도 timing/필요 시 모델 실험 버전 | 낮음 |
| D. predictive/executable 완전 분리 | 연구는 T 종가, 실행은 가용시각 정책 | 각각 기록 | 정책별 | 명시적으로 차단 | 가장 투명 | 기존 공식 불변 | execution policy 버전 | **필수 원칙** |

정책 B 세부 차이:

- T+1 13:00 진입: 실제 timestamp quote와 체결 가능 가격·슬리피지가 필요하다. 공식 일봉만으로는 13:00 가격을 얻을 수 없다.
- T+1 종가 진입: 13:00 이후 주문은 가능하지만 종가 체결을 보장하지 않으며 closing auction/slippage 모델이 필요하다.
- T+2 시가 진입: T+1 13:00 이후 신호 계산과 검증 시간이 확보돼 가장 단순하고 재현 가능하다. T+2 시가 원장이 필요하다.

정책 A로 T+1 시가를 유지하려면 553종목 모두에 대해 T 장 마감 후 quote/OHLCV가 공식 종가로 확정됐다는 근거, 수집 완료시각, 정정 정책, 누락·rate limit 처리와 source hash가 필요하다. 현재 KIS quote는 display-only이며 이 조건을 충족하지 않는다.

## 7. Source availability 권장 스키마

```json
{
  "sourceMarketDate": "YYYY-MM-DD",
  "sourcePublishedAt": null,
  "sourceCollectedAt": "ISO-8601",
  "sourceStoredAt": "ISO-8601",
  "signalComputedAt": "ISO-8601",
  "signalAvailableAt": "ISO-8601",
  "entryDecisionAt": null,
  "entryTimestamp": null,
  "sourceAvailabilityStatus": "UNKNOWN|POLICY_ESTIMATED|OBSERVED|VERIFIED",
  "timingValidationStatus": "UNKNOWN|VALID|INVALID",
  "timingPolicyVersion": "signal-timing-v1",
  "timingEvidence": [],
  "sourcePublicationPolicy": "nextBusinessDayAfter13KST",
  "sourcePublicationPolicyHash": "SHA-256"
}
```

`sourcePublishedAt`을 알 수 없다면 null을 유지한다. `sourceCollectedAt`은 성공 응답 수신시각, `sourceStoredAt`은 atomic commit 완료시각, `signalComputedAt`은 계산 종료, `signalAvailableAt`은 모든 필수 데이터와 품질검사가 끝난 시각이다. 이들을 하나의 `generatedAt`으로 합치지 않는다.

## 8. 백테스트 보호 규칙

향후 rank backtest에는 다음 규칙이 필요하다.

1. predictive/executable 배열과 통계를 계속 분리
2. executable은 `timingValidationStatus === VALID`만 집계
3. schema v2/3/4와 availability 없는 기존 파일은 `UNKNOWN`
4. UNKNOWN을 VALID로 간주하지 않음
5. `generatedAt`만으로 signal availability를 추정하지 않음
6. fixed-current-Universe 결과를 execution 승격 근거로 사용 금지
7. intraday display-only 결과 계속 제외
8. `entryTimestamp <= signalAvailableAt`이면 차단
9. entry shift는 기존 `backtestReturns`를 덮어쓰지 않고 새 policy/version 필드에 저장

기존 `2026-08-13.json`은 availability 메타데이터가 없으므로 predictive research만 허용하고 executable timing은 UNKNOWN으로 재분류해야 한다. 파일 자체를 수정하지 않는다.

## 9. 권장 자동 실행 시퀀스

```text
T 장 마감
  → waitingForOfficialEod
T+1 공식 게시 정책 시각 이후 제한적 probe
  → exact basDt 불일치: waitingForOfficialEod 유지
  → exact basDt 일치: officialEodAvailable
  → 전체 수집·품질검사
  → snapshotCreated
  → signalAvailableAt 기록
  → predictiveReturnsResolved (가능한 과거 horizon만)
  → executable timing 검사
      ├─ T+1 시가 정책: executableTimingUnavailable/INVALID
      └─ 승인된 T+2 시가 정책: 미래 원장 도착 후 resolve
  → backtestAggregated
```

probe는 무한 반복하지 않고 게시 정책 이후 제한된 횟수와 backoff를 사용해야 한다. 자동 실행 성공시각을 T 장마감 신호 존재시각으로 소급하지 않는다.

## 10. 최종 판정

| 항목 | 판정 |
|---|---|
| 현재 futureReturns 순수 예측력 | 적합: `PREDICTIVE_RESEARCH_ONLY` |
| 현재 backtestReturns 실행 가능성 | 부적합/미인증 |
| T+1 시가 진입 | `EXECUTABLE_TIMING_INVALID` |
| KIS 장마감 데이터 | T+1 시가 유지 시 필요하나 현재 quote 계약으로 불충분 |
| 진입시점 변경 | 공공 일봉만 사용하면 필요 |
| availability 메타데이터 | 필수 |
| 기존 데이터 | predictive 유지, executable UNKNOWN/INVALID로 별도 분류; 원본 수정 금지 |

### 단일 권장안

**정책 D를 원칙으로 채택하고, 공공 일봉 기반 executable 정책은 B의 T+2 시가 진입을 신규 버전으로 구현한다.** 기존 `futureReturns`와 `backtestReturns`는 변경하지 않는다. 기존 backtestReturns는 legacy timing-unverified 결과로 보존하고 신규 정책 결과를 별도 필드·정책 버전으로 저장한다. 검증된 T일 장마감 소스를 확보한 뒤에만 T+1 시가 정책을 별도 승인한다.

## 11. 예상 수정 파일과 최소 구현 순서

예상 파일:

- `lib/model-history-schema.mjs`: availability/timing metadata와 신규 execution policy 구조
- `lib/snapshot-quality-pipeline.mjs`: source publication/collection evidence
- `scripts/create-daily-model-snapshot.mjs`: collected/computed/available timestamp 분리
- `lib/market-price-ledger.mjs`: sourceCollectedAt/sourceStoredAt
- `scripts/run-daily-history.mjs`: waiting/available 상태 전이와 제한 probe
- `lib/future-return-resolver.mjs`: 기존 공식 보존, 신규 timing policy resolver 별도 추가
- `lib/rank-backtest-engine.mjs`: executable VALID-only 필터
- 관련 합성 테스트와 `docs/technical-model-backtest.md`

가장 작은 안전한 순서:

1. 메타데이터 schema와 상태만 추가하고 기존 데이터는 UNKNOWN으로 읽기
2. 신규 snapshot부터 실제 수집·저장·신호 가용시각 기록
3. 기존 resolver/returns는 그대로 두고 timing audit 결과만 병렬 생성
4. 사용자 승인 후 `T+2-open-v1` 신규 executable return 구조 추가
5. rank engine에서 신규 VALID 결과만 별도 집계

## 12. 사용자 승인이 필요한 결정

1. 공공 일봉 executable 기본 진입을 T+2 시가로 정할지
2. T+1 13:00 또는 T+1 종가 정책도 별도 실험할지
3. legacy backtestReturns를 UI/API에서 `timingUnverified`로 표시할지
4. T+1 시가 유지용 KIS 장마감 데이터 인증 프로젝트를 진행할지
5. publication policy를 공식 문서 정책시각으로만 기록할지, 실제 첫 성공 관측도 함께 축적할지

## 13. 불변성

이번 단계에서는 본 보고서만 추가했다. 외부 API, snapshot, seed, history:resolve, backtest 실행, production 데이터 생성, commit, push, 배포를 실행하지 않았다. 모델 공식과 기존 production 데이터는 변경하지 않았다.
