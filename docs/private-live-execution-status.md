# Cloud LIVE execution status (metadata only)

The last successful LIVE result and today's execution are independent. The
result outbox, first publication time and ranking pointers are not modified by
this connection. An absent/newer failed run never replaces the last good ranks.

## Data path and trust boundary

Existing Cloud writer → private repository's
`evidence/kis-eod-private-slot-observation/cloud-live-execution-status-v1/YYYY-MM-DD/`
→ existing Vercel read-only credential → `/api/private-live-execution`
→ existing administrator session → Home status / Operations details.

Records contain counts, stages, dates, original observation time bounds and
hashes, never prices, individual candidates, tokens or raw KIS responses. Exact
schema and canonical SHA256 are verified before returning data. The GET-only
reader uses the current KST day, a fixed prefix, at most ten stage files and
eight external requests; it does not fall back to yesterday's execution. Errors
are sanitized, responses private/no-store, and the existing server-side admin
guard remains mandatory. Automation read tokens cannot access this endpoint.

## Emission / failure isolation

Preparation, final readiness, collection start (one designated batch only),
validated/frozen outbox and verified delivery publish immutable snapshots.
The parent and three existing relay runs can publish bounded failure records.
No per-stock status writes or new Cron are added. Children are precreated before
the READY status write; collection starts before optional collection metadata.
Metadata delivery failure never becomes a collection failure or masks the first
error. The same event reuses frozen bytes across retries/restarts. Existing
relay schedules can confirm eventual delivery; no extra collection is invoked.

`publish-execution-status` is a management-only Workflow mode: it reads the
original parent Workflow status and the existing day state, freezes RECONCILE
metadata and delivers it. It must never prepare, collect, finish or relay the
actual result. This is the sole reconciliation used for the October20 incident.

These are last-confirmed snapshots, not a realtime liveness feed. After the
observation window, an early progress record without final confirmation becomes
STALE/unknown, not proof of success or inferred failure. Missing delivery after
14:11 is also unknown. A confirmed terminal/partial run is failure; no final EOD
means collection is blocked. Preparation errors remain errors, not inferred
supplier delay. The UI shows source confirmation, site read and actual
observation times separately. No-record, read-failure and execution-failure are
different states.

## Bounded incremental Free usage

At most ten snapshots/day (normally five); each publisher invocation has a hard
twelve-external-request cap shared across adapter retries. Existing stage SQL
reads are bounded to553 observations/eight leases, and use the existing prepaid
critical-budget accounting (no per-symbol polling). Existing220 LIVE/320 whole-day
Workflow allocation includes fewer than ten added metadata steps. State size is
under30KB/day for ten ~3KB metadata records, inside the existing2MB/day DO cap.
Git metadata is immutable and retained in the already-private data repository;
Workflow Free retention remains three days. No plan, limit, price storage,
credential, Cron, formula or quality rule changes are required.

October20 local SQLite metadata smoke measured17 read rows/two writes including
additional test reads; this is not a Cloud billing claim. Cloud account readings
have unmeasured aggregation delay. Deployment admission reserves10000 extra
write rows for lag,15000 remaining EOD/other rows and2000 metadata/reopen rows;
the observed55923 writes yield82923 upper/17077 headroom below100000. No further
full collection trial is included or permitted by this budget calculation.

## Rollback

Restore the recorded prior Cloud version while retaining active Cloud ownership,
bindings and current Cron. Restore the recorded prior Production web deployment
if the new reader/UI regresses. Metadata files remain append-only and do not
require deleting any evidence. Never activate the PC as an automatic fallback.
The next scheduled14:00 outcome must be verified separately from this metadata
connection deployment.
