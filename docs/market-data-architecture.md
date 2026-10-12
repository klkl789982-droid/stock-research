# Market data architecture — research decision record

Reviewed 2026-10-12 KST. New functionality is **RESEARCH_ONLY**, unarmed, with no workflow, public API, production pointer or promotion path.

## Existing operation and bottleneck

| Layer | Existing implementation | Responsibility |
| --- | --- | --- |
| Official Daily | `scripts/run-daily-production.mjs`, `run-daily-history.mjs`, `lib/public-eod-request.mjs`, `.github/workflows/daily-production.yml` | Latest official probe → missing-date recovery → candidate → quality/preflight → unchanged models → allowlisted promotion/commit → deployment verifier |
| Official storage/query | `data/history`, `data/model-history`, `data/analysis/market-seeds`, `/api/top-stocks` | Immutable historical inputs/results; selected official snapshot |
| LIVE | `run-intraday-model-top-official-signal.mjs`, its workflow, `infra/cloudflare-live-prewarm` | Actual 14:30–14:35 observation, independent immutable signal |
| KIS provisional/private | `kis-eod-provider.mjs`, `kis-eod-pipeline.mjs`, `kis-eod-private-*`, `audit-kis-eod-private.mjs` | Separate provisional collection, existing quarantine, unchanged engines, private storage/query |
| Research/outcomes | Existing transition/rank-backtest/performance/outcome modules | Saved input/rank and execution contracts; Daily/LIVE separation |
| Access | `proxy.ts`, admin auth/Redis, route guards, automation read token | Browser administrator access and separate restricted automation reads |
| Schedulers | Existing Daily Worker; LIVE Worker `tight-budget-live-prewarm` | Independent GitHub dispatch; LIVE remains enabled, 14:12/14:22 KST, GitHub 14:15 |

Official publishing still depends on one source. Additional triggers improve runner availability, not source delivery. An HTTP/business success with zero rows cannot prove an up-to-date publication.

### Actual public-source diagnosis

At **2026-10-12 04:08:23–04:08:29 KST**, the read-only probe made ten requests: Samsung/SK Hynix unbounded latest, date range, exact `basDt`, October 7 controls; October 8 whole-market exact query and XML exact query. All returned HTTP 200/business 00. Both controls contained October 7; both latest queries returned 260 of 1,659 rows with latest October 7. All October 8 variants returned zero. Request/response hashes were emitted, never credentials, URL query strings or prices. `no-store`/`no-cache` were requested; absent Age is not proof that upstream caching is absent.

The [official source description](https://www.data.go.kr/data/15094808/openapi.do) specifies the next business day after 13:00 KST. October 9 holiday/weekend makes October 12 afternoon consistent with that policy. This is a policy-based explanation, not a proven backend incident diagnosis or a promised exact delivery time. Current tests do not establish the afternoon response. Page metadata saying realtime conflicts with the explicit description; do not treat this endpoint as realtime.

At **13:21:57–13:22:03 KST**, a second ten-request probe found October 8 in latest/exact/XML queries for both symbols and 2,872 whole-market rows. Range begin=end still returned zero. This newly observed discrepancy means range-only absence is not reliable; the source-side parameter/boundary/cache cause remains unconfirmed. The production latest probe uses unbounded history, not this equal-bound range. Latest history is sorted by date by the existing normalizer; exact queries do not depend on history pagination. No local artifact is consulted by the probe.

During this task, origin/main received `9e57d27` (October 8 production publication) and `509e783` (freshness update). They were fast-forwarded without touching unrelated work. Saved run manifest reports PROMOTED, 11:28:31–11:36:09 KST. Status records October 8 collected/validated/published, fresh, lag0. Thus availability was observed by existing automation earlier than the guide's stated afternoon update; the guide is not an earliest-time guarantee. This task did not cause that collection/promotion. GitHub event logs and authenticated deployed API/UI were not independently verified in this step; local automation-read credential was absent. Do not equate repository status with verified Vercel publication.

## Chosen architecture

Keep official and fast data independent. Use two existing adapters for research; add a third only when rights, data scope and reliability justify it. Research comparison cannot silently fail over production.

`caller-approved provider request → independent paced collector → normalized observation → exact-date/quality/basis checks → existing engine/ranking → immutable private research manifest → local private query`

Implemented files: `lib/market-source-contract.mjs`, `market-source-collector.mjs`, `market-source-research.mjs`; diagnosis/replay/query/test scripts. The collector accepts existing provider request functions and does not create credentials or grant permissions. KIS/public adapters reuse the existing parsers. Native provider journals remain the original evidence; new storage contains normalized input shards and provenance/hash references, not another raw-response archive.

Rights start denied. Calculation requires verified price basis and session scope. Both real adapters currently preserve UNKNOWN session scope; the public adapter also preserves UNKNOWN adjustment. Real normalized data therefore supports diagnostics but cannot pass the new ranking gate until evidence establishes those fields. Synthetic fixtures establish code compatibility only.

Every provider has a separate serialized queue, interval, deadline, capped retry/backoff and circuit. Same concurrent request is shared; later observations may be collected again because sources can revise. Timeout aborts the request, makes no retry, and blocks overlapping requests until the outstanding promise settles. State is process-local, not distributed, not durable and not a new scheduler. Circuit cooldown allows a later explicit call; it does not create background retry timers.

Collection, validation, calculation, storage and publication are distinct. Unknown provided/validated/published dates stay null. `nextCheckAt` after failure is a retry-eligibility estimate, not a registered schedule. Store receipts record readback verification; research result body remains immutable. Publication is permanently disabled in this layer.

Alternatives rejected: three always-on full collectors (unproven value/cost); source averaging (changes input meaning); per-symbol fallback blending (mixed input basis); incremental adjusted-price histories (corporate-action invalidation not established); replacing official provider now (rights/session/finality unverified).

## Measured performance and limits

Existing October 8 historical KIS audit, collected October 9, records 1,610 successful client attempts, 653,754 ms first pass (~10m54s), 523 accepted, 30 existing quarantine and 15 short histories. A-v1/A-v2/B/D cover 508, C covers 523. Cached revalidation took 24,573 ms and 54 attempts; it is not a repeat first-pass measurement. Hidden auth refresh roundtrips are outside that telemetry. New read-only replay performs no requests and recalculates those same coverages. October 7 baseline had 508/508 equal OHLCV; after origin's new October 8 seed became available, same-date comparison has only 40/508 all-field matches. Model score differences are present (A-v1/A-v2 444 of508, B462/508, C457/523, D438/508). This is a diagnostic with unknown price/session equivalence; causes are not inferred or formulas changed. A-v2 official challenger ranks absent remain uncomparable, not zero overlap.

New synthetic 553-symbol calculation/reproducibility test covers normalization, calculation twice and queries; it is not a live throughput benchmark. Default research pacing is one request/second/provider, max concurrent one/provider, <=3 attempts, timeout <=30s, <=1,200 queued logical requests. Native KIS history calls may contain multiple pages: provider-level request pacing does not replace the existing provider's HTTP-level limiter. With 1,610 HTTP calls, native 150ms spacing alone contributes at least ~241.5s; real observed duration is longer. Sequential 553 logical requests at 1s spacing adds a theoretical >=552s if every logical call is faster than spacing. These are estimates, not guaranteed wall times.

Storage reuses the existing private adapter's 900KB/object ceiling. One input per ticker, content-addressed and deduplicated; manifests include per-input timestamps/hashes. Actual new full-universe storage volume/monthly cost is unmeasured. No new cloud deployment, secret, subscription or paid service is introduced. Local process state loses queued work on termination; immutable shards survive, missing manifest is safely retriable. Cross-run distributed scheduling remains existing infrastructure responsibility.

## Operational boundary

No imports from production/API paths, no auth exceptions, no KIS remote uploads, no new public source data commits. Official data, engines, outcomes, both Workers and workflows are untouched. Existing unrelated dirty Daily Worker files and a Daily run log are excluded from this commit. Source substitution/publication needs explicit rights and operational approval after actual same-date comparison and scheduled-run verification.

The portal explicitly restricts unauthorized redistribution. Existing public Git history/seed exposure requires a separate rights/remediation decision; this task preserves existing data and does not delete or rewrite history. Administrator login does not by itself resolve data licensing.
