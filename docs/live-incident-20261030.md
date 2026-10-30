# LIVE collection incident, 2026-10-29 / 2026-10-30

## Evidence and limits

Read existing Cloudflare parent/child workflow records and the private execution
status/delivery journal. No market recollection or historical publication was run.
Both parents and all 139 October 30 children used workflow version
`83faadb0-3817-4855-8de4-f5f0328433e9`, created October 28 14:23 UTC. The active
Worker version at inspection was `9d1bd82d-f46b-4ace-aeb8-f86c83779d83`.
Downloaded runtime code contains the durable batch journal, receipt clock and
watchdog implementation; it does not contain the new pinned exclusion path.
These are distinct Worker/Workflow IDs, not Git commit IDs.

- October 29: 509 available, 43 excluded, 1 failed, 0 required missing.
- October 30: 504 available, 43 excluded, 6 failed, 5 required missing.
- Both: outbox absent, private delivery absent; latest delivery head October 19.
- `032580` is already ineligible in both pinned EOD seeds. Its malformed quote
  reached `parseKisQuote` before the old eligibility check. It unnecessarily
  blocked October 29's otherwise complete required set.
- October 30 failed eligible tickers `001820`, `093370`, `097950`, `178320`,
  `199430` all report `DIAG_UNKNOWN_TRANSPORT_FAILURE` at `LEASE_ACQUIRE`.
  All children are COMPLETE, but their `output.failed` records are nonempty.
  This is not evidence of bad KIS prices for these five tickers.
- The first stored day error (`KIS_INVALID_QUOTE`) masked the separate lease
  failures in the compact execution summary. The underlying Cloudflare transport
  exception was not retained; its precise platform cause remains unconfirmed.

## Repair

Pinned `eligible=false` inputs become explicit EXCLUDED records before KIS calls,
with seed/input hashes and no invented observation timestamp. Every original
Universe ticker still has a durable result. Required-price and journal validation
remain strict; no arbitrary failure is converted into exclusion.

A collector creates one random acquisition ID per ticker invocation. At most
three serial acquisition attempts, all before any market call, may reconnect to
the same queued promise or exact persisted grant. A new invocation cannot reclaim
the lease. Expired, completed, expanded or used grants fail closed. Authentication
stays in memory; no token or raw price is added to durable storage.

Batch reconciliation also returns every failure's ticker, stage, reason and
required flag in Workflow step output. The first original error remains preserved.

## Ongoing verification and rollback

The existing synthetic failure-matrix CI automatically includes the new tests.
Run `npm run live:preflight-test` before release. The tests cover lost lease replies,
queue/restart recovery, persistent failure, exclusion storage failure, full553
accounting, immutable relay and unchanged eligible model scores/ranks.

After release, inspect the next scheduled run: all required tickers available,
all553 accounted for, outbox frozen, private hash readback, latest delivery head,
authenticated API and visible site date/hash. Never infer LIVE recovery from EOD
success or synthetic tests. Existing watchdog/relay schedules and limits stay fixed.

Do not publish October 29/30 using later quotes. Old failures, grants and results
remain immutable. Roll back only the Worker code version if needed; leave data and
namespaces intact. Code deployment alone does not certify end-to-end recovery.

## Local verification

- Cloud failure matrix: 144/144 passed, including the new lease/exclusion cases.
- Private delivery/execution status/read boundary/panel: 22/22 passed. The local
  immutable hard-link fixture needed execution outside Windows sandbox limits.
- Daily production and LIVE outcome resolver regressions passed; TypeScript,
  changed-file ESLint, diff whitespace checks and Worker build dry-run passed.
- Two unchanged legacy checks remain failing: the old 14:30 signal fixture lacks
  required seed availability evidence (`SEED_AVAILABILITY_UNVERIFIED`), and the
  old operational-recovery UI source assertion expects text since removed from
  the component. These checks import unchanged files, not this Worker repair.
  No provenance rule or UI was weakened to make them pass.
