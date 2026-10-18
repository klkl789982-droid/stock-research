# Daily EOD publication → 14:00 PC input readiness

## Scope and verified path

This supplements `live-host-restart-diagnosis-20261018.md`. The cause of the
original three supervisor exits remains **unconfirmed**. Its heartbeat/journal/
task-priority fixes are preserved. No historical data, formula, observation
window, quality threshold or Cloudflare Worker is changed here.

The existing automatic Daily path is:

1. `daily-production.yml` runs `production:daily` without a forced date. Each
   new process queries the supplier and selects the oldest actually observed
   missing trading date; `NO_NEW_OFFICIAL_EOD` preserves the last good result.
2. `run-daily-history.mjs` invokes the unchanged snapshot engine, producing the
   history, price ledger, universe, market analysis and intraday market seed.
   Trading-calendar evidence and outcome results are updated for that same date.
3. `run-daily-production.mjs` validates the complete candidate. Only validated
   candidates may stage model/price inputs, including `market-seeds` and calendar
   evidence. They are committed/pushed together; bounded non-force rebase/push
   retries and Vercel date/hash/commit verification remain enabled.
4. The PC daemon uses `repositoryInputs(..., {remote:true})`. Preparation fetches
   `origin/main`, pins a commit and reads its seed/calendar using `git show`.
   It does **not** require the local data files to have been checked out. Code
   drift and formula mismatches fail closed.
5. At 13:59 it fetches again even after successful prewarm, storing a separate
   immutable `collection-prepared.json` receipt. The exact preceding verified
   session, availability evidence, quality and formula hashes remain mandatory.
   No final input first verified at/after 14:00 is accepted for this observation.

The PC task's 13:40 and 13:59 triggers start it only if stopped (`IgnoreNew` plus
owner locks); the persistent daemon performs the input checks. Those triggers
do not independently collect official EOD from the supplier. The Daily job does.
Vercel build completion is not a prerequisite to the PC reading a valid committed
seed; website publication is a separate verified stage.

## Gaps corrected

- GitHub's morning probes ended at 13:23. Added **13:33, 13:43, 13:53 KST**
  (`33,43,53 4 * * 1-5` UTC) to re-use the same Daily concurrency/idempotency/
  promotion path. Existing morning/evening slots and the separate Cloudflare
  Daily Worker are preserved. Next-schedule status reporting uses the same slots.
- A preparation failure used a 60-second backoff even during 13:59, potentially
  missing newly committed inputs before the cutoff. Prewarm backoff now lands no
  later than 13:59; final-minute preparation failures retry at most every 10s,
  within the existing 25-attempt preparation budget. No price-collection retry
  limit or deadline is extended. Late preparation cannot fall back to prewarm.
- An old recovery test required secret-bearing GitHub LIVE publication after that
  producer had already been retired. Assertions now enforce its retirement and
  the current/private versus archived 14:30 UI distinction. No test was skipped
  and no production validator was weakened.

## Verification boundaries

Synthetic clock tests reproduce the original backoff failure and verify recovery
inside 13:59, no pre-14:00 quote requests, immutable prewarm preservation, unchanged
model outputs, bounded retries, and no acceptance at/after the input cutoff.
A real **isolated local bare Git repository** verifies fetch/show of a new seed
and calendar while checkout data stays stale; network/code-drift failures do not
fall back. It does not simulate supplier availability or claim a future run.

Targeted executor tests: 34 passed; recovery/cutover tests: 7 passed, no skips.
Daily promotion/deployment, public-query/retry and calendar scripts passed.
TypeScript, touched-file ESLint and `git diff --check` are checked for this change.
No UI/build-wide rerun is required solely to repeat the preceding full validation;
the existing Git integration still builds the pushed release independently.

GitHub's real workflow state was `active` when inspected; recent actual scheduled
runs existed. Cron expressions are nominal opportunities, not runner-start SLAs.
The supplier documents Friday data as next-business-Monday after 13:00, not a
guarantee of readiness by 13:59. A late supplier response, runner delay, incomplete
553-security collection, failed validation/push or unready seed must still block
LIVE. No historical or synthetic data may stand in for the missing 10/16 session.

On 10/19 the remaining real checks are supplier 10/16 publication and full Daily
completion/push before cutoff; the PC's recorded final receipt; actual 14:00–14:05
quotes/calculation; private outbox delivery; and authenticated website readback.

## Deployment and recovery

Deploy only these reviewed automation/executor/status/test/docs changes, not the
integration branch. Preserve the current task XML and mutable supervisor/daemon
receipts externally before a managed restart. Stop/start only this managed owner;
do not delete locks or overwrite immutable state. Confirm one host/child, advancing
heartbeat, writer CONFIGURED and existing 13:40/13:59 task triggers afterward.

For rollback, preserve new evidence, normally revert only this change (not the
preceding restart fix), then restart the same managed task. Do not reactivate the
retired GitHub/Cloudflare LIVE producer. A missed/blocked run remains an honest
missed/blocked record, never a backfilled 14:00 observation.
