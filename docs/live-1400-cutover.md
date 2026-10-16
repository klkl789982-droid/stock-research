# One daily 14:00 LIVE observation plus official EOD

Status: local implementation only. No remote schedule, workflow run, repository commit, deployment, credential, permission, paid-service or historical data change was performed.

## Contract

- Current identity: schema 2, `intraday-model-top-official-signal-v2`, `intraday-1400-v1`, `14:00:00` Asia/Seoul, collection deadline `14:05:00`.
- New observations use `data/intraday-signals/model-top/YYYY-MM-DD/1400.json`. Cross-sectional quote event times and server receipt times must be inside the actual collection boundaries. Collection is one window, not a simultaneous fill at exactly 14:00.
- Collection target, source event/receipt, collection completion, calculation, storage and publication are separate timestamps. An idempotent already-stored run does not erase the successful attempt's metadata.
- A delayed start or expired collection stops before further provider calls. This includes response-body completion and token-refresh retries. Changing the target time does not remove GitHub queue delays or promise publication by 14:00.
- `1430.json` remains immutable and archive-only. Explicit `date=YYYY-MM-DD&time=1430` reads report an archive artifact. Default and date-only reads select 14:00. No 13:30 operating record was created by the intermediate local draft.
- A–D formulas and model versions are unchanged. Observation identities incorporate the policy and nominal time so a new cohort cannot collide with archived observations.

## Source timing

Official EOD availability is unchanged. A LIVE run needs the exact preceding verified trading session, with that session's latest bar for each eligible security and actual seed/official-batch receipt before 14:00. An older gap alone is not newly treated as a completeness failure. Unknown calendar, stale previous-session data or insufficient availability proof produces an explicit input-wait reason, never a relabelled current observation.

The GitHub producer's local source configuration prewarms at 13:45 (04:45 UTC). Its opted-in input refresh waits until 13:59, fetches the existing origin/main once with a deadline, pins one commit SHA and reads the seed/calendar from that immutable commit. It never checks out/reset files or writes the inputs. Dirty/different source/dependencies, formula mismatch, incomplete previous-session input or readiness at/after 14:00 stops the attempt. The stored signal binds the exact input SHA, seed/calendar hashes and actual refresh/readiness times. Normal CLI dry-run does not fetch.

Oct 16's stored Oct 15 EOD seed was generated at 13:56:14 KST. That observed receipt illustrates why a 13:45 checkout needs refresh; it is not a provider service-level guarantee. A late source remains late. EOD API fallback continues showing its actual reference date.

## Scheduler source and duplicate B retirement

- GitHub workflow source: prewarm 13:45 KST, then the strict shared collection window.
- Cloudflare source configuration: 13:42/13:52 prewarm attempts. The deployed Worker configuration was not changed or verified in this local task.
- Local executor source: prepare from 13:40, pin prepared inputs, one collection per date. A stored private-API readback is explicitly `NOT_EVALUATED` for freshness; it cannot claim current freshness or serve old 14:30 as current.
- The separate legacy Model B collector and cron are retired. Its manual compatibility entry reports retirement without credentials, provider calls, data writes or score changes. All four models share the single Model TOP observation.
- `/api/top-stocks` is canonical dated EOD and cannot override Model B from the retired latest file. Current LIVE UI goes through the strict shared Model TOP API. A 503 preserves the failed attempt's validated date/stage and the last valid observation date, alongside the separately dated EOD fallback.

The earlier unavailable Model B repair patch was not recovered. The retirement, fallback and diagnostic changes above are newly implemented in this cutover.

## Evaluation and preparation

Current performance uses schema 2, `INTRADAY_1400_LIVE`, execution policy `intraday-1400-t1-open-v1`, and only `data/intraday-outcomes/model-top/1400/YYYY-MM-DD.json`. Legacy date-only outcome files are explicit read-only archives. They are not promoted, recomputed, merged into current metrics or accepted merely because they say MATURE.

The current resolver requires hash-bound availability receipts, known security executability, finite prices and corporate-action/adjustment evidence throughout the interval. Missing evidence retains explicit PENDING/DATA_MISSING status with null returns. Production evidence adapters are not implemented in this patch, so synthetic verified outcomes do not imply real trading or deployable performance.

The swing foundation is `swing5-1400-preparing-v2`. It reads only verified 14:00 observations, issues preparation records at the actual new read time, uses a strictly later verified session open and the fifth holding-session close for the prospective benchmark, and purges overlapping label windows in chronological splits. Predictions remain null/PREPARING; A–D scores are not probabilities. Current saved 14:00 observations and eligible training labels are both zero. Minute-level day trading remains preparing.

## Verification and release checklist

The combined recovery report records exact test/build results. The subsequent [Daily Worker contract repair](daily-worker-contract-repair.md) closes the four pre-existing failures without weakening publication proof or changing scheduler configuration. Tests cover old archive immutability, current/legacy namespace isolation, invalid schemas/types/hash/provenance, actual quote/deadline bounds, stale input, delayed runners, strict API fallback, null-versus-zero values, authentication, outcome proof gaps, and isolated compiled-route packaging.

Before any separately authorized release:

1. Confirm repository visibility, data rights and existing release holds are resolved. The current patch does not resolve them.
2. Reconcile source base against current main without rewriting data or historical observations.
3. Coordinate the actual existing GitHub/Cloudflare/local-executor writers so only the selected current producer is active; source edits alone do not change an external scheduler. Stop old 14:30/new 13:30 attempts rather than run two daily collection windows.
4. Observe one real authorized 14:00 run and verify exact commit/content hash/policy/path through the existing protected production API proof. A successful deployment or login response is insufficient.
5. Preserve separate last-valid observation and failed-attempt state; verify freshness expires at the next eligible observation boundary and no EOD date is presented as current LIVE.
6. Complete protected browser/mobile visual QA. Current environment Chromium startup was blocked before page capture; local HTTP, compiled handlers and interaction fixtures do not establish visual correctness.
