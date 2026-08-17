# public-eod-t2-open-v1 실행수익률 정책

## 목적과 격리

이 정책은 공공 공식 일봉으로 계산한 신호의 실제 이용 가능 시각을 반영한다.
`futureReturns`는 예측력 연구용, 기존 `backtestReturns`는 `legacy-t1-open-v1`
timing-unverified 자료로 보존한다. 신규 결과는 `executionReturnsByPolicy` 아래에만
저장하며 장중 display-only 자료는 사용하지 않는다.

## 시각 정의

- `sourceMarketDate`: 공식 일봉 `basDt`
- `sourcePublishedAt`: 원천이 개별 게시시각을 제공하지 않으므로 `null`
- `sourceCollectedAt`: 전 종목 exact-date 수집이 성공한 서버 관측시각
- `signalComputedAt`: 품질검사 후 모델 계산 완료시각
- `sourceStoredAt`, `signalAvailableAt`: atomic commit 직전에 고정한 commit-intent 시각
- 실제 rename 완료시각: 향후 immutable daily-run manifest가 기록할 책임
- `generatedAt`: 기존 호환 필드일 뿐 가용시각 대체 금지

공식 게시 정책은 “기준일 다음 영업일 오후 1시 이후”이며 근거 URL과 결정론적
hash를 저장한다. 정책 시각을 개별 레코드의 실제 `sourcePublishedAt`으로 위장하지
않는다.

## 거래일과 수익률

`trading-calendar/status.json`에서 `tradingDay`인 날짜만 센다. `marketClosed`는
건너뛰고, `unchecked`, `collectionFailed`, 미등록 평일에서는 중단한다.

- 진입: T 이후 두 번째 검증 거래일(T+2) 09:00 KST의 공식 시가
- H1: 진입일 종가
- H5: 진입일을 1일째로 센 5번째 검증 거래일 종가
- H20: 진입일을 1일째로 센 20번째 검증 거래일 종가
- 공식: `(exitClosePrice / entryOpenPrice - 1) * 100`, 소수점 6자리

`signalAvailableAt < entryTimestamp`일 때만 timing valid다. 같거나 늦으면 계산과
집계를 차단한다. 시가·종가 누락, 무거래/거래정지 표식, 가격 원장 누락은 0이나
다른 날짜 가격으로 대체하지 않는다.

## 집계

`npm run backtest:rank -- --execution-policy=public-eod-t2-open-v1`이 기본이다.
legacy는 명시 요청할 때만 읽고 `timingUnverified: true`,
`eligibleForExecutableConclusion: false`로 표시한다. VERIFIED와
POLICY_ESTIMATED timing 결과는 별도 배열이며 합산 대표 성과를 만들지 않는다.

현재 수익률은 거래비용과 슬리피지를 반영하지 않은 gross return이고 최적화·승격
근거로 사용할 수 없다. 실제 적용 전 schema-v6 production snapshot, 검증된 가격
원장 연속성, daily-run manifest, 충분한 point-in-time 표본과 사용자 승인이 필요하다.
