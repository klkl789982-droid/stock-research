# Technical model backtest data

## Daily snapshot

`data/history/YYYY-MM-DD.json` is an immutable, close-based daily snapshot. A
snapshot is written only when every stock in `data/universe.json` has enough
history and all active model scores are valid.

Each record contains:

- identity: `date`, `code`, `name`, `market`
- official daily prices: `openPrice` and `closePrice` (schema v3 and later)
- scores and ranks: `modelA` through `modelE`
- Model B factors: `maStructureScore`, `trendPersistenceScore`,
  `momentumScore`, `macdScore`, `position52wScore`
- Model C factors: `priceActionScore`, `volumeScore`, `shortMomentumScore`,
  `rsiMacdScore`, `shortMAScore`, `riskPenalty`
- diagnostic `riskFlags`
- unresolved forward returns: `future1dReturn`, `future5dReturn`,
  `future20dReturn`

Model E is not implemented. Its score and rank remain `null`, and its model
definition is `notConfigured`. Do not backfill it into historical snapshots as
if it had existed on those dates.

## Predictive-power returns (`futureReturns`)

After future trading days become available, resolve each horizon with the
exchange trading calendar, not calendar-day offsets:

```text
futureNdReturn = (close at T+N trading day / closePrice at T - 1) * 100
```

Store the actual future trading date in `futureReturns.resolvedAt`. Updating
forward-return fields must not recalculate or overwrite the original scores,
factors, ranks, model versions, or T-day close.

These fields measure pure model predictive power from the signal-day close.
They are not executable trade returns and deliberately make no entry-price
assumption. Existing field names remain unchanged for compatibility.

## Executable backtest returns (`backtestReturns`)

The signal is frozen after the T-day close. The theoretical entry is the
official T+1 daily open (`mkp`), and exits are the official T+1, T+5, and T+20
closes:

```text
nextOpenToT1CloseReturn  = (T+1 close / T+1 open - 1) * 100
nextOpenToT5CloseReturn  = (T+5 close / T+1 open - 1) * 100
nextOpenToT20CloseReturn = (T+20 close / T+1 open - 1) * 100
```

The returns use the same six-decimal precision policy as `futureReturns`.
Snapshots created before schema v3, including `2026-08-13.json`, have no
`openPrice`. Do not synthesize it or substitute the close. A signal-day open is
not needed for entry; resolution needs the T+1 price ledger's open.

## Market-price ledger

`data/market-prices/YYYY-MM-DD.json` is separate from model scores, ranks, and
the Universe. A new snapshot run writes the same day's official open and close
for all stocks fetched by the current model Universe. The resolver uses this
ledger for executable entry and exit prices, so a later model snapshot does not
need to contain the stock if the ledger still does.

At this stage ledger coverage is `currentModelUniverse`. Continuing to track a
previous signal after the stock leaves that Universe requires extra price
requests or a broader market feed; those calls are not implemented here.

## Trading-day status ledger

`data/trading-calendar/status.json` records each explicitly checked date as
`tradingDay`, `marketClosed`, `collectionFailed`, or `unchecked`, together with
model-snapshot and market-price-ledger artifact states. T+N counts only
`tradingDay`. `marketClosed` is skipped, while `collectionFailed`, `unchecked`,
or an unregistered weekday stops resolution and never promotes a later file to
T+N. Unregistered Saturdays and Sundays are skipped.

A requested Saturday or Sunday is safely classified as `marketClosed` without
an API call. An exact requested-date `basDt` is `tradingDay`. A weekday request
whose latest `basDt` is older remains `unchecked`: the existing daily-price API
does not distinguish a normal exchange holiday from publication delay or data
failure. API, parsing, empty-response, reversed-date, and future-date failures
are `collectionFailed`. Confirming a weekday holiday requires an independent
official closure source, which is intentionally not added at this stage.

Resolution states include `pendingFutureTradingDay`,
`missingTradingDaySnapshot`, `symbolMissing`, `missingOpenPrice`,
`missingExitClosePrice`, `invalidPrice`, and `resolved`. A halted stock or
invalid/missing price is not forward-filled. New listings retain their recorded
history length. Delistings, mergers, symbol changes, final liquidation prices,
and settlement rules remain unresolved and require corporate-action data.

Only `futureReturns` and `backtestReturns` may change during enrichment. Locks,
temporary files, recoverable backups, immutable-field comparison, null-only
resolution, and finite-value idempotency protect all original prices, scores,
ranks, factors, risk flags, definitions, and TOP lists.

For predictive-power returns, the signal close remains in the model snapshot,
but every future close is read from the independent price ledger. A target
`tradingDay` must also have a created model snapshot for predictive evaluation.
Executable backtest entry and exit prices require only the price ledger, so
they remain independent of the future model Universe when that ledger still
contains the symbol.

## Daily operation

Run after the requested date's market close:

```bash
npm run history:daily -- --date=YYYY-MM-DD
```

The command checks the requested date, creates and validates the model snapshot
and same-response price ledger only for a confirmed `tradingDay`, updates the
status ledger, runs return resolution, and prints a summary. A closed date
creates no artifacts. An unchecked or failed date stops without claiming
success. Existing matching artifacts are validated and reused idempotently;
partial artifacts stop the workflow.

`npm run history:resolve` sorts the available history snapshots and treats the
next, fifth-next, and twentieth-next snapshot as T+1, T+5, and T+20 trading
days. It fills only null values. A missing future snapshot remains pending; a
missing stock or invalid close in an available target snapshot is reported as
failed. Each changed file is protected by a lock and a recoverable replacement.

## Model comparison

`npm run history:analyze` selects each model's TOP50 independently for every
snapshot and horizon. It reports:

- average holding return
- individual holding win rate
- maximum drawdown of the chronological equal-weight cohort-return series

Five- and twenty-day cohorts overlap when snapshots are daily. Treat them as
dependent observations. Before model selection, add non-overlapping cohorts,
rank correlation, benchmark-relative returns, turnover, transaction costs,
survivorship controls, and delisting returns.

## Commands

```bash
npm run history:snapshot
npm run history:resolve
npm run history:analyze
```

The snapshot command currently makes one 260-row public-data request per
Universe stock. It deliberately uses official daily closes rather than live
quotes so every stock shares a reproducible timestamp.
# Model A Champion–Challenger 정책

Model A-v1에서 최종 점수가 100을 초과하거나 0 미만이 될 수 있는 범위 오류가 발견되었다. A-v1은 이미 생성된 신호와 향후 성과의 재현성을 보존하기 위해 수정하지 않는다. `scores.modelA`, `ranks.modelA`, `modelDefinitions.A`, `topLists.modelA`는 계속 A-v1을 의미한다.

A-v2는 별도의 bounded technical-strength challenger다. A-v1과 동일한 factor 정규화, 가중치, reversal bonus, penalty를 사용하며 최종 처리만 다음과 같이 다르다.

```text
rawScore = technicalScore + reversalBonus - penalty
finalScore = clamp(rawScore, 0, 100)
```

`rawScore`는 clamp하지 않고 감사 및 동점 처리용으로 저장한다. A-v2 순위는 `finalScore` 내림차순, `rawScore` 내림차순, 정규화된 6자리 종목코드 오름차순으로 정한다. 입력 배열 순서나 stable sort에 의존하지 않는다.

신규 스냅샷은 A-v1 champion과 A-v2 challenger를 동일 날짜, 동일 Universe, 동일 공식 일봉으로 병렬 계산한다. A-v2의 최초 실제 저장일이 비교 시작일이며, 2026-08-13 스냅샷은 A-v2 비교 기간 이전이므로 소급 계산하거나 수정하지 않는다.

A-v1/A-v2 성과 비교는 두 버전이 모두 존재하는 동일 날짜만 사용하고 동일한 T+1/T+5/T+20 미래수익률, 거래비용 및 슬리피지 가정을 적용한다. A-v1 단독 과거 기간을 A-v2 병렬 기간과 섞지 않는다. A-v2는 성과와 관계없이 자동 승격하지 않으며 `promotionStatus: notApproved`는 사용자 승인 없이 변경할 수 없다.
