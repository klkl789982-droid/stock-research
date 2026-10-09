# KIS private observation and model integration

## Approval boundaries

Actual Actions preflight [37903668011](https://github.com/klkl789982-droid/stock-research/actions/runs/37903668011)
verified private write/read/hash, KIS authentication, exact baseline calendar and
all three ticker reads on 2026-10-09. Three-symbol scheduling is now armed; an
explicit `KIS_EOD_OBSERVATION_ENABLED=false` repository variable disables it.
No actual designated-slot observation was created by that preflight.

- Only three-symbol observations (005930, 000660, 064290) can be armed after the
  actual Actions activation preflight succeeds. Weekday UTC 06:25 prewarm means
  15:25 KST; one real-clock runner waits for 15:40, 16:10, 16:40. Exclusive
  five-minute windows remain unchanged. Delayed/missing slots are not backfilled.
- 553 recurring collection remains statically UNARMED in both full workflows.
  No Cloudflare roles/settings, Daily/LIVE artifacts or public APIs change.
- Provisional bars are NOT confirmed final regular-session EOD. Equal slot values
  are not a finality contract. Private storage does not establish redistribution
  rights; third-party storage, sharing and derived-score publication terms remain
  review/approval items. Public publishing remains disabled.

## Reused production path

`run-kis-eod-private-models.mjs` wraps the existing collector. Actual KST clock,
15:30 close gate, exact KIS calendar and exact response date determine readiness.
Unknown calendars, prior-date responses and partial collections cannot
advance the current-day head. Previously verified results remain available, alongside a
separate last-operation status. Current-day provisional data is reobserved rather
than frozen at the first complete slot: identical market inputs deduplicate only
AFTER collection/validation and previous raw/model readback; changed inputs append
an immutable new version. An already-verified historical catch-up date is reused.
There is no user-supplied date, fake clock, force or publication CLI.

`run-kis-eod-private-latest.mjs` is the automation entrypoint. After the actual
15:30 KST close gate, it searches at most 15 calendar days for an EXACT KIS Y/Y
trading-day response. Invalid fields or Y/N stop the run. N/Y is skipped ONLY in
this private lookback because the [official KIS sample](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/chk_holiday/chk_holiday.py)
defines `opnd_yn` as the day when orders can be placed. It is never accepted as a
normal candidate; all selected dates still require exact Y/Y, and the original
provider, Daily and LIVE calendar policies are untouched. If today is open it uses
the unchanged current-day collector and never falls back when today's bars are
unavailable. If today is closed it uses the existing strict historical audit for
the latest confirmed trading day; this remains `HISTORICAL_RESEARCH_REQUEST` in
the separate research namespace with ACTUAL collection timestamps, not a
backdated LIVE observation. This does not weaken current-day quality gates.

`workflow_dispatch` mode `private-collect` authorizes a single private 553 run
without changing a repository activation variable. Schedule jobs remain
statically blocked. Cron preparation is 15:40, 16:10/16:40 through 20:10/20:40 KST.
An independent runner then rereads source/model hashes and tests all five model
versions TOP5/10/20 via authenticated loopback HTTP. No public upload or commit
of raw data occurs. GitHub scheduling is best effort; an independent observation
Worker would need separate approval/credentials and must not reuse/expand the
existing official Daily Cloudflare Worker.

The existing five model formulas and tie policy are unchanged. The unchanged
completeness check permits existing quarantine, insufficient history and halt
exclusions, not missing non-quarantined source or calculation failure.

## Private durable storage

The existing Contents adapter uses `KIS_OBSERVATION_STORE_TOKEN` with Contents
read/write only on `klkl789982-droid/tight-budget-private-data`. It rechecks
privacy before writes. No token values or raw data enter source Actions logs.

Within the adapter's existing evidence root:

- `model-top/live/objects/<whole-payload-hash>/<chunk>.json`: source/model JSON
  fragments, byte hashes, Unicode preserved and original credential scan.
- `model-top/live/heads/<date>/<promotion-hash>.json`: create-only promotion event
  written only after all chunks read back and the raw/model input hashes match.
- `model-top/live/operations/<date>/<hash>.json`: safe failures and successes.
- `model-top/research/...`: historical empirical replay, never the live head.
- `model-top/fixture/...`: price-free integration tests; cannot promote a head.

Latest pointer is the derived maximum `(referenceDate, collectionCompletedAt,
promotionHash)` of immutable events, NOT an overwritten latest.json. Concurrent
or late older runs cannot roll it back. A corrupt newest head fails closed.
Interrupted uploads cannot promote; identical chunks deduplicate on retry.
Directory listings cap at 1000 (fail closed at the cap); archive/partition policy
will be needed before that limit. This is application-level append-only with
hash checks, not WORM: administrators can alter visibility or delete objects.

## Verification and private query

`kis-eod-private-integration-preflight.yml` executes actual price-free storage
create/read/hash plus exact-calendar and three one-bar KIS reads against the
latest saved official baseline. The quotes stay in memory. It writes only safe
proof metadata, no fabricated designated-slot observation or model score.

Existing actual audit reuse, with zero new KIS collection:

```sh
node scripts/replay-kis-eod-private-models.mjs --verify-local
node scripts/serve-kis-eod-private-top.mjs --local
```

`--verify-local` persists to ignored `.runtime/kis-eod/private-model-store`,
checks original audit hashes and recalculated scores, then queries all versions
and TOP5/10/20. Historical request/receipt timestamps are retained. This proves
local empirical E2E, not GitHub remote retention or automatic scheduled execution.

GET `http://127.0.0.1:3101/api/kis-eod-private-top-stocks?model=B&limit=10&mode=research`
supports A (default A-v2), B, C, D, or explicit `version=A-v1`, limits 5/10/20.
No OHLCV, tokens, source payloads or private repository URLs are returned.
The server additionally requires `KIS_PRIVATE_TOP_ACCESS_TOKEN` (at least 32
non-whitespace characters) and `Authorization: Bearer <token>` on EVERY request;
missing/wrong credentials return 401. The access token is separate from the store
token, stays in the caller's environment, and is never logged. Default mode
`latest` chooses ONE newest frozen KIS dataset across current-day/research heads,
retaining explicit observationType/dataMode; scores are never blended. Explicit
`live`/`research` selection remains supported.
The server binds only loopback, rejects hostile Host/Origin/fetch-site, has no
CORS and no Vercel/Next route. Local OS account/filesystem is the trust boundary.

With a separately supplied local private-store credential, the same CLI without
`--local` queries GitHub. Do not extract Actions secrets into logs/source.
`--persist-private-research` explicitly stores existing research to that private
repository; it never promotes a LIVE head. Empty live history is accumulating,
not synthetic scores or a false fresh state.

## Still requires actual time or approval

Official KIS references: [service/partnership application](https://apiportal.koreainvestment.com/provider-apply)
and [official API samples](https://github.com/koreainvestment/open-trading-api).
API availability/sample code is not a license for private third-party cloud
storage, friend-sharing or external derived-score publication. Those contract
permissions have not been verified here; obtain provider confirmation before
extending access or enabling public publication.

Future scheduled trigger/runner arrival, each slot's real availability and later
official comparisons require future observations. GitHub cron is best-effort;
no independent observation scheduler is deployed. 553 recurring collection and
public publication require separate explicit activation approval and public
rights/finality evidence. Enabling only the repository variable cannot bypass
the full-collection static schedule guard.

Private full collection additionally retries ONLY token-issuance HTTP 403
`EGW00133` once after 65 seconds. This exact failure was reproduced after a
successful preflight issued the same app key's token less than a minute earlier.
Other 403/authentication failures remain failures; no token is cached on disk or
uploaded. Existing observation defaults and Daily/LIVE transports are unchanged.
