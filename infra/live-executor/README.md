# Independent LIVE executor

## Current deployment target — 14:00 KST, always-on Linux

The completion target is **PC-independent** operation, not a Windows task.
See [the server migration runbook](../../docs/live-server-migration.md) for the
existing-resource audit, measured workload, staged systemd deployment, cost,
single-producer cutover, verification and rollback. No server has been purchased
or activated. Do not disable the current PC task before server proof is obtained.
The systemd template is deliberately blocked until a root-controlled cutover
marker exists. Its Node supervisor reuses the current 13:40 / 13:59 preparation
and 14:00–14:05 collection policy. The older 14:10/14:30 description and evidence
below are historical context, not additional active collection schedules.

This Node.js 22+ service collects KIS prices directly. GitHub Actions, dispatch,
and hosted runner startup are absent from its observation path. Existing
`calculateIntradayModelTopScores` and `buildIntradayModelTopSignal` are imported
unchanged (A-v1/B-v1/C-v1/D-v1). The existing prewarm Worker remains operational
during parallel validation.

## Runtime choice and limits

The 2026-10-08 seed has 553 records, of which 508 satisfy the existing LIVE
common-universe policy. Its formatted size is 18.34 MB. Observation needs two
KIS requests per eligible symbol: quote plus exchange-minute timestamp (1,016
business requests), not 553 historical downloads. The adapter starts at most
five requests/second across auth, calendar, quotes, timestamps, and retries.
The no-retry lower bound is therefore 203.2 seconds; actual elapsed time is
measured separately. Slow responses can still exhaust the five-minute window.
Two source requests may be in flight; transient requests retry once. Successful
per-symbol checkpoints are reused. Whole collection attempts are capped at three.
Preparation has a separate budget (25 attempts for LIVE, three for shadow) with
60-second failure backoff. Recovering from prewarm failures leaves all three
collection attempts available. An unprepared LIVE run that has missed its window
records `MISSED` without making calendar, seed, or observation requests.

Cloudflare's current Free Worker limits are 50 subrequests and 10 ms CPU per
invocation. A direct single-invocation port cannot carry this workload. A
Durable Object/sharded solution introduces a remote raw-data store and additional
rights/configuration dependencies. Node on an owned always-on host reuses the
engine and keeps source prices local. No paid plan or host has been purchased.

Sources checked 2026-10-12:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://apiportal.koreainvestment.com/provider

KIS account-wide quota also covers the old LIVE observer and other applications.
Five requests/second is this adapter's conservative local budget, not a claim
that the account's current contractual quota or third-party storage rights are
verified. Existing KIS cloud storage/display approval remains outstanding.

## Preparation, observation, recovery

The daemon prepares from 14:10 KST: checks the KIS trading calendar, fetches the
newest official seed strictly before the observation date, validates its hash,
and verifies formula files against Git HEAD and the seed manifest. Preparation
does not fetch observation prices. `git fetch` reads data; it does not change the
working tree or auto-update running code.

At 14:30 the local timer starts collection. Every actual KIS request and retry
checks the current KST date and the existing 14:30:00–14:35:00 policy. Source
timestamps are preserved. Delayed start cannot generate a backdated observation.
Quotes already collected are immutable; partial retries request only missing
symbols. A complete set can finish calculation/storage after a process restart
without collecting later prices. Partial failure never advances latest.

State is outside the source checkout/public directory. The local store uses
create-only installation, SHA256 readback, atomic pointers and process locks.
Dead process locks are recoverable; ambiguous/corrupt locks fail closed.
Separate `live/` and `shadow/` namespaces prevent test input from becoming LIVE.
The authenticated loopback `/top` readback returns scores/ranks, not raw prices.
The real-data shadow output is `CURRENT_TIME_SHADOW`, never Official Signal or
outcome input. It retains actual current quote timestamps.

## Local actual-data verification

Use an explicit private state directory outside this repository. Existing KIS
credentials are loaded by Node without being printed:

```powershell
node --env-file=.env.local infra/live-executor/run.mjs --mode=shadow --state-dir=C:/Users/user/AppData/Local/TightBudget/live-executor-validation --run-id=unique-run-id
node infra/live-executor/run.mjs --mode=verify --state-dir=C:/Users/user/AppData/Local/TightBudget/live-executor-validation
```

The second command requires no KIS credential and makes no KIS request. It
reopens persisted data and verifies SHA256 plus authenticated HTTP TOP5 for
A/B/C/D. Its ephemeral read token is held only in memory. `--mode=live` uses the
real current clock; it is not an override for time-based tests.

## Always-on operation and publication

```powershell
node --env-file=.env.local infra/live-executor/run.mjs --mode=daemon --state-dir=C:/Users/user/AppData/Local/TightBudget/live-executor
```

The host must remain powered, awake, network-connected and clock-synchronized.
An interactive terminal is not a restart supervisor. The supplied systemd unit
is a deployment template for an approved always-on Linux host. No Windows task,
system service, new credential or new host is silently installed by this code.
The daemon records heartbeat and failure status. A supervisor restarts process
failures; persisted quotes avoid full recollection. An offline host cannot
reconstruct a missed 14:30 observation.

Publication is off by default while the new observer runs in parallel. Enabling
it requires a dedicated clean clone, existing Git write credentials, verified
publication rights, and these explicit settings:

- `LIVE_EXECUTOR_PUBLISH_ENABLED=true`
- `LIVE_EXECUTOR_PUBLICATION_AUTHORIZED=true`
- `LIVE_EXECUTOR_PUBLISH_CHECKOUT=<absolute dedicated clone path>`
- `TB_AUTOMATION_READ_TOKEN` for the existing Vercel verification API
- in that clone: `git config tightbudget.livePublisher true`

The publisher only stages the existing canonical LIVE date artifact and latest
pointer, rejects competing immutable signals, performs bounded non-force push,
and separately verifies Vercel. It never calls GitHub Actions. Pending publication
is tracked in an outbox; later attempts reuse stored observations. A conflicting
old observer's same-day result is not overwritten. Retire the old scheduler only
after the new host/supervisor, rights, real-window throughput, single writer and
site/outcome publication have been verified. The same observation IDs and
canonical paths preserve existing outcome joins.

## Tests

`node --test infra/live-executor/*.test.mjs`

Synthetic tests use isolated temporary files and local bare Git repositories.
Actual-data evidence is reported separately. Neither is evidence of future
scheduled execution success.

## Actual isolated execution evidence — 2026-10-12 KST

- Native Node process on the user's Windows host, no Actions invocation.
- Official seed 2026-10-08, 553 records / 508 eligible; existing quarantine and
  all A-v1/B-v1/C-v1/D-v1 formula source hashes retained.
- Current-time shadow collection: 15:17:45.758–15:21:15.557 KST (209.799s).
  508 successful, 0 missing; 1,020 actual requests including token/calendar,
  508 quotes, 510 minute requests and 2 bounded retries.
- Four existing model calculations complete at 15:21:15.791, local immutable
  storage complete at 15:21:16.872. Formula source/seed hashes independently match.
- A/B/C/D authenticated TOP5 HTTP readback succeeds; unauthenticated request
  returns 401; raw prices are absent from that projection.
- New process, no credential loaded: same hash/readback succeeds. Same run resumed:
  zero KIS requests, identical result hash. No official LIVE pointer created.
- Result hash: `12dd9f001b48687e48118484afe0f0aedbfa5cf99217f1c8c8901b0f0bbf92ca`.
- Separate daemon process prepared from origin/main and correctly recorded
  `MISSED / OFFICIAL_SIGNAL_OUTSIDE_COLLECTION_WINDOW` at 15:22, no LIVE artifact.
  Validation process was stopped after checking this behavior.

These are current-time prices, not 14:30 observations. The measured ~90s margin
under five minutes is one observed run, not a guarantee of peak-hour latency.
No raw price, credential or private state from the run is committed here.
