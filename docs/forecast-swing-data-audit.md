# Five-trading-day swing data readiness audit

Audit baseline: `65ebc6ee291c522dd630e8d0de852efa23b3468f`, local files only, 2026-10-16 UTC. No source collection, credentials, production changes, historical-data rewrites, or external requests were performed.

## Scope after the local 14:00 cutover

The figures and source-code findings below describe the pinned baseline, not the revised collector. All original 14:30 artifacts remain byte-identical. The new current 14:00 cohort contains zero observations and is never combined with this archive. The accompanying cutover fixes current seed availability/implementation binding and makes new outcome calculation fail closed on missing source, security or execution evidence; it does not rewrite or certify old outcomes.

## Decision

Saved ModelTOP observations can be the feature-side foundation for a **future** next-trading-day-open to fifth-holding-trading-day-close research label. They cannot support execution at 14:30, and **no saved LIVE date currently has a mature five-day label**. Availability, trading-calendar, security-status and adjustment evidence must be made explicit before these observations qualify for an executable or point-in-time-certified evaluation.

Do not reuse the old resolver's `MATURE` flag as proof of point-in-time eligibility. A mathematically calculated return is not evidence of an attainable fill or of information available to a historical forecast.

## Actual coverage, without inflating sample size

- LIVE signal files: exactly 4 dates, 2026-10-13 through 2026-10-16, under `data/intraday-signals/model-top/YYYY-MM-DD/1430.json`.
- Each contains 553 ticker rows: 508 `AVAILABLE`, 45 `INELIGIBLE`, zero `MISSING`. Across dates: 2,212 total ticker-date rows; 2,032 available ticker-date rows; 508 distinct available tickers; 8,128 A/B/C/D score cells.
- Restricting to each model's Top20 yields 80 model-ticker rows per date, 320 total. Their unique ticker-date counts are 50, 49, 45, 48 respectively: 192 ticker-date observations and 96 distinct tickers. Models and overlapping Top5/Top10/Top20 groups do not multiply independent samples.
- Existing outcomes cover only Oct 13–15: 240 model-ticker rows, 144 distinct ticker-date observations. The Oct 13 and Oct 14 files each claim 80 mature `1DAY` rows. Across all three files, mature `5DAY`, `20DAY` and `60DAY` counts are zero. There is no Oct 16 outcome file.
- Twelve official market-price ledgers cover Sep 22, Sep 28, Sep 30, Oct 1, Oct 2, Oct 6, Oct 7, Oct 8, Oct 12, Oct 13, Oct 14 and Oct 15. Each contains 553 rows, totaling 6,636. All rows are marked executable; all tracking-unavailable arrays are empty. This is recorded classification, not independent proof that all securities were executable.
- Other series are distinct: 13 Daily history files / 7,189 rows; 11 compact model-history files / 6,083 rows; 12 market seeds / 6,636 ticker records; four historical **one-day** outcome ledgers / 2,212 rows. None creates additional historical LIVE observations. The 260 bars inside a seed are historical input bars, not 260 point-in-time forecast dates.
- Four signal dates are four cross-sectional dates, not four independent five-day outcomes. Their future holding intervals would overlap substantially. At baseline, mature five-day date count and usable five-day training-label count are both **zero**.

Counts were recomputed from the actual files. All four signal/seed structural validators and all twelve ledger structural validators pass; those validators do not establish the stronger timing and security evidence required here.

## Observation time and available-at

The nominal `14:30:00` is the beginning of a 14:30–14:35 KST collection window. Cross-sectional ranks depend on completion of all quotes, followed by calculation and storage. The signal stores individual quote event/receipt times and collection boundaries (`lib/intraday-model-top-official-signal.mjs:81-135`). It does **not** store final calculation/storage availability in its immutable payload.

Observed collection completion times (KST):

- Oct 13: 14:32:40.339
- Oct 14: 14:32:37.510
- Oct 15: 14:34:07.734
- Oct 16: 14:32:28.709

Calculation occurs afterward, then exclusive creation of the artifact, then a mutable latest pointer (`scripts/run-intraday-model-top-official-signal.mjs:193-209`). `collectionCompletedAt` is therefore a lower bound, not a final `available_at` value. The current `latest.json:27-28` has null calculation/storage times because a later idempotent run overwrote operational metadata (`run-intraday-model-top-official-signal.mjs:53-59`).

Local Git retains hash-matched producer storage receipts at `data/intraday-signals/model-top/latest.json`:

- `980d18b`: Oct 13, calculation 05:32:40.506Z, stored 05:32:40.566Z
- `be935cb`: Oct 14, calculation 05:32:37.670Z, stored 05:32:37.728Z
- `38c12f0`: Oct 15, calculation 05:34:07.881Z, stored 05:34:07.938Z
- `7629bc4`: Oct 16, calculation 05:32:28.838Z, stored 05:32:28.886Z

Each historical pointer's `contentHash` matches the corresponding current immutable signal. These are repository-recorded **producer-local storage receipts**, not verified deployed/public availability or broker-fill evidence. A new research import can preserve exact commit/path/hash evidence in its own immutable sidecar without rewriting source artifacts; it must name this evidence level accurately. If the modeled consumer requires publication, completed publication/receipt evidence is additionally required.

## Seed provenance and official publication timing

Each LIVE signal references the previous stored seed (Oct 12, 13, 14, 15 respectively). All four referenced seed content hashes and official normalized-input hashes match. Each seed was generated and its official-price batch observed before the LIVE collection began:

- Oct 12 seed: batch observed Oct 13 03:44:48.102Z; generated 03:44:50.115Z
- Oct 13 seed: batch observed Oct 14 02:05:36.519Z; generated 02:05:37.996Z
- Oct 14 seed: batch observed Oct 15 04:18:59.892Z; generated 04:19:01.606Z
- Oct 15 seed: batch observed Oct 16 04:56:13.297Z; generated 04:56:14.645Z

The repository's stored provider policy says next-business-day after 13:00 KST (`lib/source-availability.mjs:3-8`). It explicitly is not record-specific publication evidence. Actual stored batches sometimes precede that hour; do not treat this descriptive policy as a guaranteed earliest time or force receipt times to an estimated hour. `sourcePublishedAt` remains null; `observedAt` records when this system had the batch (`source-availability.mjs:24-27`). No external provider policy verification was attempted in this local-only audit.

Ledger JSON contains no `available_at`, collection receipt, content hash, volume, security identity or adjustment metadata (`lib/market-price-ledger.mjs:5-23`). Companion Daily run manifests do store a byte-level `priceLedgerHash` and source evidence (`scripts/run-daily-production.mjs:166`); any availability adapter must verify those bindings before using them. A market event at 09:00/15:30 is not the time its next-day official ledger became observable.

Seed creation and validation check requested-date order, 260 rows, OHLCV validity and hashes, but not final signal availability (`lib/intraday-market-seed.mjs:5-6`; `lib/intraday-model-top-official-signal.mjs:62-67,140-149`). The signal builder copies formula hashes from the seed while computing with current code; a new provenance contract should also bind the implementation/version actually used.

## Calendar and five-day target

Stored calendar: 16 entries, Aug 13–Oct 15; 12 `tradingDay`, three `marketClosed`, one `unchecked` (`data/trading-calendar/status.json`). Sep 22 has a ledger but no calendar entry; Sep 29 is missing. Earlier broad gaps prevent treating the stored dates as one complete trading calendar. Oct 5/9 closures are inferred from gaps between complete official-history observations, not separately saved exchange holiday notices (`lib/trading-calendar-status.mjs:27-60`).

For a signal on T, define entry as the next verified trading session's official open. Count entry session as holding day one; exit on the fifth verified holding session's official close. Thus exit is four verified trading sessions after entry, equivalently T+5 when the calendar is complete. Do not shift the entry or exit to the next available ticker bar after a suspension/missing quote.

At baseline, Oct 13 and Oct 14 have identifiable entry dates Oct 14/15. Later entries and every five-day exit lack sufficient stored calendar/price coverage. Do not invent future weekday-only targets. `locateExecutionTradingDay` stops at missing weekdays, but after the calendar maximum it reports `pendingFutureTradingDay` even if the calendar is merely stale relative to the evaluation cutoff (`lib/execution-return-resolver.mjs:35-48`). Distinguish unknown calendar from genuinely future sessions.

## Missing, halted, delisted and adjusted-price evidence

The policy explicitly records `priceAdjustmentPolicy: unknown`, `corporateActionPolicy: unknown`, `pointInTimeMasterCertified: false`, and `securityStatusVerified: false` (`config/snapshot-quality-policy.json:5-9`). These currently produce warnings (`lib/market-data-quality-validator.mjs:254-261`), not full execution-certification blocks.

All four seeds are `PASS_WITH_QUARANTINE`, with point-in-time verification `UNVERIFIED` and `CURRENT_UNIVERSE_LEGACY_FALLBACK`. Their coverage identifies 30 quarantined discontinuity names and 15 insufficient-history names. The seed's 45 excluded rows all carry `insufficientHistory`, so that field alone loses the richer exclusion cause; retain source-quality evidence. The recorded executable flag is inferred from OHLCV no-trade classification (`scripts/create-daily-model-snapshot.mjs:270-297`), not authoritative status/auction/fill evidence. There is no per-outcome corporate-action factor, delisting payoff, persistent-security-ID reconciliation or certified historical security master in the LIVE/ledger contract.

Retain missing/suspended/delisted/unknown observations and explicit reasons in denominators. Never silently forward-fill a zero/absent price, substitute a quote or later open, treat no-trade referenceClose as an execution price, or drop delistings as if they never existed. Comparable adjusted prices or an explicitly justified unadjusted/corporate-action policy are required before certified economic-return labels. Gross raw-price research labels, if separately allowed, must remain clearly uncertified and cannot substantiate model superiority.

## Old resolver fail-open findings

`lib/intraday-model-top-outcome-resolver.mjs:41-77` checks nominal market event times, not signal/ledger available-at. It accepts any executable value except literal false, permits numeric coercion, and retains cached mature results before revalidation. `validateIntradayModelTopOutcomes:102-109` checks shallow schema/hash fields, not price/timing consistency. The script checks signal-hash equality but does not validate imported prior outcome contents (`scripts/resolve-intraday-model-top-outcomes.mjs:32-38`). `prepareMarketPriceLedgers` performs no validation and builds a Map that silently collapses duplicate normalized ticker IDs (`lib/future-return-resolver.mjs:317-320`).

Read-only, in-memory probes using existing files confirmed:

1. As-of Oct 14 07:00Z, the Oct 13 signal produces 80 mature one-day rows using the Oct 14 ledger, although that batch was first recorded received Oct 15 04:18:59.892Z.
2. Changing the signal's collection completion to after its next-day entry still produces 80 mature one-day rows.
3. Supplying existing mature outcomes while moving as-of to before the signal existed preserves all 80 mature rows.

These probes did not write outputs. The same availability omission governs five-day maturity. Existing one-day maturity counts above are descriptive counts of saved flags, not audited executable samples.

## Proposed fail-closed research contract

1. Freeze policy/version, forecast cutoff, horizon, target definition, source layer and universe policy before evaluation. Keep Daily, LIVE and private KIS-EOD research separate. Use one ticker-date target shared by model comparison rows; do not duplicate labels as independent samples.
2. Bind immutable source signal, seed, formula implementation, universe, ledger and calendar versions by validated hashes. Reject invalid dates, duplicate ticker/date IDs, malformed timestamps, coercible nonnumeric prices, schema/record mismatches and unrecognized sources. A valid content hash is necessary but does not establish trustworthy timing.
3. Record event time separately from `observed_at`, `computed_at`, `stored_at` and consumer `available_at`, with evidence level and exact evidence path/hash. Forecast input availability is no earlier than every required dependency and completed computation/storage; require it strictly before the chosen entry open. Unknown availability stays blocked. Do not substitute 14:30, a source market date, file mtime, or estimated publication policy.
4. Resolve next-open/fifth-close only through verified, complete calendar evidence. Require matching official date/ticker rows, explicit executable/status evidence, compatible security identity and price-adjustment basis, and no unresolved corporate-action problem. Keep future, unknown calendar, unavailable receipt, missing price, suspension, delisting and invalid evidence as separate statuses.
5. Label `available_at` is at least the latest required price receipt/storage and resolution time. Require label availability <= evaluation/fit cutoff; market close alone cannot mature it. Ignore imported `MATURE` flags and recompute from validated evidence. Label gross return is `(exit_close / entry_open - 1)`, with unit declared; separately disclose costs, slippage and fill uncertainty.
6. Date-group splits, never random ticker-row splits. Train only on labels actually available before fit time. Purge every training observation whose information/holding interval overlaps a validation or sealed-holdout interval; apply any pre-registered embargo in verified trading sessions, not calendar weekdays. A nominal five-session gap alone can be insufficient when official publication is delayed. Current date-only split validation checks date-range overlap but not label intervals/availability (`lib/validation-protocol.mjs:13-30`).
7. Report eligible/missing/blocked row counts, distinct ticker-date counts, distinct mature signal dates and overlapping-window dependence separately. Use date/block-aware uncertainty. Existing legacy example split periods end in 2025 and do not define a valid 2026 LIVE experiment (`config/model-validation-periods.json`). No fit, calibration or performance claim is supported by the current four dates and zero mature five-day labels.

## Current blockers

- No mature five-day labels; calendar and official price coverage end Oct 15.
- Immutable per-signal final availability missing from the signal file. Hash-bound local Git producer receipts are recoverable but do not prove public/deployed availability.
- Ledger availability must be imported with verified companion manifest/byte-hash binding; ledger file alone is insufficient.
- Historical universe, security status, delisting and corporate-action/adjustment evidence are uncertified.
- Existing resolver and legacy splits are not adequate point-in-time label/evaluation validators.

Safe current outcome: a separately namespaced, read-only, provenance-rich readiness report and pending/blocked label skeleton. Continue collecting under independently authorized existing operations; do not manufacture earlier LIVE snapshots, mutate historical data, or claim empirical validation.
