# LIVE host restart diagnosis — 2026-10-18

## Evidence boundaries

- Original runtime code: `61dba2d`; latest main at investigation start:
  `0113c59` (Daily status data only). Existing Desktop/integration work is untouched.
- Original supervisor: PID 9768, restartCount 3, last child PID 22112.
  That child subsequently exited with code 1 at `2026-10-18T07:59:45.686Z`;
  the old host recorded `EXHAUSTED / HOST_CHILD_FAILED`. Its final heartbeat
  was `07:58:33.175Z`. This particular exit was **not** recorded as the
  seven-minute heartbeat watchdog firing.
- The original code discarded child output and overwrote RESTART_WAIT with
  RUNNING. Windows TaskScheduler/Operational logging was disabled. No matching
  application crash evidence was retrieved. The exact causes of the earlier
  three exits cannot be recovered from these records; do not relabel them as
  proven clock failures, CPU starvation, KIS failures or user termination.
- Before changes, 850 state files (20,281,299 bytes), code and task XML were
  copied to a current-user/SYSTEM-only external backup:
  `C:\Users\user\AppData\Local\TightBudget\host-diagnosis-20261018-1652`.
  The subsequently exhausted status was preserved separately. No source records
  were rewritten or sent remotely by this investigation.

## Reproduced defects / mitigations

1. The actual `run.mjs`, in an isolated process with a controlled clock and
   forbidden networking, stopped refreshing its heartbeat after three failed
   clock checks. The old retry/continue path skipped the heartbeat code. The
   same regression fails before the fix and passes after moving heartbeat
   maintenance into `finally`. Clock/EOD validation still blocks observation.
2. A real isolated supervisor event-loop stall causes its real child to expire
   the five-second parent lease. It now reports `PARENT_LEASE_EXPIRED`, rather
   than being indistinguishable from any exit 1. This demonstrates a failure
   mechanism, **not proof that the historical three exits had that cause**.
3. Actual managed host/child process priority was 6 (BelowNormal). Task XML
   priority 7 also imposes low I/O and memory priority. Use Task priority 4
   (normal CPU/I/O/memory), not High or Realtime. This removes a documented
   scheduling risk for the one-second lease producer, without increasing any
   observation or watchdog deadline. See
   [Microsoft Task Scheduler priority mapping](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-priority-settingstype-element).
4. Each host session now has create-only, hash-verified supervisor event records
   in `live/supervisor-events/<session UUID>/<sequence>.json`. RUNNING retains
   the last failure. Child diagnostics contain only allowlisted event names,
   fixed reason codes and process/restart metadata, never arbitrary IPC fields,
   stdout, credentials, response bodies or prices. Distinct diagnostics are
   capped at 32 per child. Restart budget remains three.
5. Add a 13:59 daily **start-if-stopped** trigger to the same managed task.
   IgnoreNew and existing process-owner locks prevent a second owner. A running
   daemon is not restarted. This does not add another observation: collection
   remains exactly the existing 14:00–14:05 policy and immutable per-date run.

## Official 2026-10-16 EOD cross-check

The read-only diagnostic now optionally preserves original response bytes via
an explicit evidence callback, without storing credentials or a credentialed URL.
It compares raw and normalized counts/dates, sanitized wire parameters, SHA256
and allowlisted HTTP cache headers. A positive totalCount with absent raw rows
is a schema failure, never market absence.

At `2026-10-18T07:58:00Z–07:58:09Z`, 13 real requests were made:

- latest 260 rows for Samsung and SK Hynix: raw and normalized latest 20261015,
  zero filtered rows; repeat latest was a new request with a newer server Date;
- range/exact 20261016, independently assembled exact query, all-market exact,
  XML exact: HTTP 200 / business 00, original totalCount 0 and no raw rows;
- exact 20261015 controls: one row per ticker; all-market control: total 2867;
- request cache:no-store / Cache-Control:no-cache / Pragma:no-cache; responses
  no-cache,no-store,max-age=0,must-revalidate, no Age/ETag/Via/X-Cache evidence.

The actual empty JSON body was:

```json
{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL SERVICE."},"body":{"numOfRows":5,"pageNo":1,"totalCount":0,"items":{"item":[]}}}}
```

Original bytes/metadata are only in the external private backup's
`eod-audit-1792310280302` directory. No raw prices are added to Git. This excludes
the investigated local date-builder/filter/cache error paths; it does not prove
anything about the supplier's internal cache or universal absence.

The [supplier's official description](https://www.data.go.kr/data/15094808/openapi.do)
says Friday data is provided the following business Monday after 13:00. Thus
Sunday's absence is **awaiting the advertised publication opportunity**, not a
demonstrated overdue supply incident. Monday's arrival/completion by 13:59 is
not guaranteed. No old seed substitution or forged 20261016 artifact is allowed.

## Verification and rollback

The full executor suite also exposed obsolete public-publisher synthetic fixtures
without availability receipts/hashes and with old 14:30 timestamps. Only those
fixtures and exact expected validation codes were updated to exercise the
existing strict validator. Public publisher code/activation is unchanged and is
still hard-disabled in the managed host; no production publication is tested.

Operational readback must confirm one task/host/child, normal priority, new session
journal, advancing heartbeat, writer CONFIGURED, 13:40/13:59 triggers and private
API authentication. Real 14:00 observation remains unverified until it occurs.
Final local suite: 102 tests passed, zero failed/skipped. TypeScript and ESLint
passed (the full-project lint has the same three pre-existing financial-route
unused-symbol warnings); Production Build and git diff --check passed. Baseline
fixture failures were corrected rather than deleting/skipping tests or relaxing
production validators. Formula/policy/workflow/Daily-data diffs remain empty.
Power/network, user logon, EOD availability, disk, API and OS failures remain
external risks; this change does not claim zero interruption probability.

For rollback, preserve new state/events, stop only this managed owner, revert
the reviewed code commit normally, run its task installer with `-Register` while
stopped, then start that same task. Do not restore old state over newer immutable
records and do not reactivate GitHub/Cloudflare LIVE collectors. Daily EOD, model
formulas, quality gates, outcome contracts and all original artifacts are unchanged.
