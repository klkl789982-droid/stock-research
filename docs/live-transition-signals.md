# LIVE transition research view

The detail-card and transition screener default to LIVE, with an explicit EOD comparison switch. EOD calculations and filters are unchanged. The API retains EOD as its default for existing clients; the updated UI sends `mode=LIVE` or `mode=EOD` explicitly.

## Inputs and isolation

LIVE reuses the exact saved TOP LIVE 14:30 artifact under `data/intraday-signals/model-top/`. It performs no quote request, model recalculation, new signal persistence, or publication. Quotes retain their actual KIS date/time and receipt timestamps. This is a saved observation, not a streaming feed.

The artifact's exact `seedReferenceDate` selects both the seed and stored EOD model history. The signal hash, latest-pointer hash, seed content hash, and official-daily source hash must agree. READY must also have the exact seed ticker/eligibility set and matching universe/collection counts; contradictory partial collections fail closed. A later EOD file cannot change this input. Existing structural, per-stock quality, eligibility, missing-bar, no-trade, and quarantine exclusions remain in force. A LIVE quote must also have valid OHLCV, the signal date/window, and a receipt age below 60 seconds. Exclusion reasons/counts are returned separately.

The prior seed date must be a verified trading day. Every date between it and the observed signal must be a weekend or a stored verified closure. Unknown weekdays cannot be skipped. The READY TOP LIVE artifact is the evidence of the observed session; the producer already checks the KIS trading-day calendar, so LIVE does not require that same day's not-yet-published EOD ledger entry.

Missing, failed, waiting, stale, mismatched, or invalid inputs return a specific unavailable reason. `lastGood` is never used to disguise a failed attempt. A saved observation expires when another potentially open session reaches 14:30 KST. Weekends and stored verified closures are skipped; an unknown weekday is conservatively considered due. Before that time the prior saved observation remains explicitly labelled with its actual date. Validated computations are cached and concurrent pair requests share their work; file signatures invalidate repairs and latest status/calendar/freshness are checked on every request. LIVE views revalidate every 60 seconds while visible, on focus/tab return, and on return from hidden detail views. Revalidation clears old rows without resetting pagination.

## Golden-cross observations

Each pair (SMA5/SMA20 and SMA20/SMA60) is calculated independently from unrounded closed prices plus the saved provisional last price.

- `CROSS_OCCURRED`: previous closed short SMA ≤ long SMA, and provisional short SMA > long SMA. Label: 골든크로스 진입 · 잠정.
- `APPROACHING`: previous closed short SMA ≤ long SMA, provisional short SMA < long SMA, the percentage gap is narrowing, short SMA slope is positive, and the additional price rise to the equality boundary is within `nearPercent`.
- `ALREADY_ABOVE`: both previous closed and provisional short SMA are strictly above long SMA. This is not a new cross.
- `NONE`: none of those conditions, including exact equality.

For short window s, long window l, sum A of the latest s−1 closed prices and sum B of the latest l−1 closed prices, the equality boundary is `(s×B−l×A)/(l−s)`. Strict crossing requires a price above that boundary. This is an algebraic boundary, not a rounded exchange tick or a guaranteed executable target. Required additional rise is `max(0, (boundary / observedPrice − 1) × 100)`.

`nearPercent` defaults to 1%, is configurable from 0% to 5%, and is an unvalidated research heuristic, not a probability. The provisional signal may reverse before close. LIVE does not reuse EOD approach-strength or upward-evidence scores, nor compare partial intraday volume with daily volume as if it were a same-time measure. Stored A–D scores remain tied to the prior EOD model date.

## Verification

Run `npm run transition:live-test`, `node scripts/test-transition-evidence.mjs`, `npm run lint`, `npx tsc --noEmit` (after Next type generation), and `npm run build`, and `node scripts/test-admin-auth-http.mjs` for the actual authenticated Next HTTP boundary. The LIVE test uses saved fixtures and synthetic mutations, never external market-data requests.
