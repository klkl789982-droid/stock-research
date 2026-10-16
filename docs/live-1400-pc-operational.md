# Independent 14:00 PC operation — 2026-10-17

This selective release reuses the reviewed r2 executor and leaves unrelated
integration/forecast UI, Daily Worker repairs and Daily/outcome calculations out
of main. The original integration branch and Desktop changes are preserved.

## Owner and boundaries

- One Windows managed host: `TightBudget-Live-Executor-1002`, current Windows user,
  least privilege, hidden PowerShell launcher / absolute Node path / fixed cwd.
- Preparation 13:40 KST, final preceding-session EOD pin/recheck at 13:59, actual
  observation 14:00–14:05. Daily task and logon recovery start a persistent process.
  There is no second observation on process restart or re-transmission.
- GitHub LIVE TOP/B workflows are retired, without schedule or collection secrets.
  LIVE Cloudflare config has DISPATCH_ENABLED=false and no cron. Daily is unchanged.
- Public Git publication from this host is hard-disabled. Raw prices stay locally.
  Remote relay contains only the approved four model TOP5 score/rank projections.
  Existing 14:30 data, APIs and performance are archive-only, not rewritten.

## Collection, queue and transmission are separate

Local source and prepared receipts remain immutable outside Git. A successful
result is authenticated-read locally, then queued even when there is no writer.
Startup recovers an unqueued valid current-policy result. Original 14:30 evidence
fails the 14:00 relay contract and cannot be republished as a current observation.
The outbox preserves exact bytes across retries; three attempts, one minute apart,
are reserved durably before networking. A remote head is written only after object
read/hash validation. A prior good head survives errors, conflicts and older dates.

The dedicated writer file is
`C:\Users\user\AppData\Local\TightBudget\site-relay-writer.env`.
Only PRIVATE_LIVE_DELIVERY_WRITE_TOKEN is accepted. It must target only
`klkl789982-droid/tight-budget-private-data` with Contents read/write. Never use the
Vercel reader or extract a GitHub Actions Secret. The file is reloaded outside the
critical collection window. Missing/invalid writer configuration cannot stop local
collection. Remote failures never re-collect or relabel the source observation.

Operator input, if no credential is present:

```powershell
powershell -NoProfile -File infra/live-executor/configure-writer.ps1
```

This prompts without echo, writes the external file with current-user/SYSTEM ACL,
then tests a new synthetic-only `tests/site-delivery-writer/<uuid>/fixture.json`.
It verifies create/read/hash/duplicate/conflict preservation, never operational
heads or real market data. Existing files are preserved rather than overwritten.

## PC requirements and real-session gates

Keep the PC powered on, network connected and this Windows user logged in; screen
lock is supported, sign-out is not. InteractiveToken avoids storing a Windows
password, but cannot run while logged out. WakeToRun is requested; firmware/power
off cannot be overridden. The process does not depend on Codex remaining open.
Parent lease, health check, task IgnoreNew and local owner locks prevent duplicates.

Actual readiness check at 2026-10-17 03:49 KST: KIS calendar confirmed 2026-10-19
tradingDay (calendar only, no quote requests); uncached TLS clock check passed
(offset +539ms, uncertainty 1080ms, original 5000ms bound). Oct 19 still needs exact
Oct 16 official EOD available and pinned before 14:00. Never bridge it with Oct 15.

The Production header/card share one authenticated relay request. Missing delivery
means waiting, failed reads clear the payload, historical dates stay historical,
and the PC's not-yet-delivered attempt state is not claimed to be remotely known.
Old 14:30 transition/performance information is explicitly an archive. Temporary
Preview Redis is not used by Production. Synthetic fixtures remain Preview-only.

## Backup and recovery

`cutover-windows.ps1` checks the exact old owner, root and managed-task marker before
any mutation. It preserves task XML, Desktop code diff, executor, private settings
and quiesced state in an external user/SYSTEM-only backup. The Desktop checkout is
not updated or reset. Failed registration restores the old task automatically.

For an approved full PC rollback:

```powershell
powershell -NoProfile -File infra/live-executor/restore-windows.ps1 -BackupDir C:\Users\user\AppData\Local\TightBudget\cutover-1400-20261017
```

Do not restore old immutable state over newer records. Coordinate a single owner
before restoring the saved LIVE Worker version/cron or workflow. Website rollback
uses a normal revert of this selective release; preserve automated EOD data commits.
Pre-transition Production is deployment `2m9hjyEc2jqocZTALmR6Z21m9ewh` / `327884b`.
Pre-transition LIVE Worker is version `ce1c50e6-54f4-462d-b1d7-ce95ce19a2c2`, with
GITHUB_TOKEN binding preserved. The source cron was 14:12/14:22; Dashboard session
had expired, so its pre-change remote cron was not independently reverified.

No actual 14:00 future-session or PC-writer remote E2E is claimed by this document.
See the subsequent deployment/cutover receipt for the actual applied version,
task/process readback and remaining credential gate.
