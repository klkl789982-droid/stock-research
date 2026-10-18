# PC-independent LIVE: staged Linux migration

## Verified scope (2026-10-18)

The required end state is EOD update and 14:00 LIVE calculation/delivery/site
readback with the personal PC off or logged out. A Windows task does not meet it.
No paid resource/account was created and no PC task was disabled by this work.

Current PC dependencies are the InteractiveToken Windows task/PowerShell wrapper,
the local Node executable and checkout, KIS `.env.local`, LOCALAPPDATA writer-file
default, private checkpoint/outbox disk, local clock, power/network, and host/child
liveness. The actual score engine, KST clock, filesystem store, loopback API and
GitHub score-only delivery adapter are already portable Node modules.

### Existing services, not assumed new resources

| Resource | Verified role / limitation |
| --- | --- |
| Vercel stock-research | Existing production project `prj_lng99h7A5p18pOg4HhqvBDpTvmNd`, team `team_gDJOxz3bTQPA2yASTeqtIq8O`, Node 24, production READY. Website/reader remain unchanged. Team billing endpoint returned 403 for `klkl789982-droids-projects`; CLI fallback was unavailable. Actual plan is **unverified**, not assumed Hobby. |
| Cloudflare Daily Worker | Existing cloud scheduler for official EOD → GitHub → Vercel. PC-independent already; left unchanged. Current dashboard session is expired, so current subscription/extra compute entitlement is **unverified**. |
| Private GitHub data repo | Existing score/rank-only delivery, reader/writer separation, immutable payloads and authenticated website reader. Not a compute VM or source-price backup. |
| Always-on VM | User confirms none owned. No configured SSH host or AWS/GCP/Azure CLI/profile found in the named standard locations; no unrelated credentials were searched. |

The official Daily production path remains cloud-based. Its supplier/validation/
publication failures can still delay LIVE input; no old EOD fallback is added.
GitHub Actions remains allowed for EOD and synthetic **tests**, never the LIVE
collector. The new Linux CI has no KIS/store secrets, quotes or publication.

## Workload and networking

Historical actual 508-symbol current-time collection: 2026-10-12
15:17:45.758–15:21:15.557 KST, 209.799 seconds, 1,020 requests including auth,
calendar, quote/minute requests and two retries. This was not a 14:00 observation.
The unchanged source spaces all requests by at least 200ms (5 starts/sec), shares
one limiter, runs two symbol workers and bounds retries. 508 eligible symbols
need at least 1,016 quote/minute requests; the no-retry rate floor is 203.2s.
The strict five-minute window remains a real throughput risk, not a guarantee.

This migration's **read-only replay** of the saved actual shadow evidence used
6,087,901 seed bytes, 208ms calculation, maximum RSS 254,060KiB (~248MiB), heap
48,300,800 bytes on Windows. All scores/ranks matched the saved records. No new
observation, remote price transmission or timestamp relabelling occurred. Linux
memory/latency must be measured on the actual VM; reserve OS/Git/retry headroom.

Recommended capacity: 2GB RAM, 60GB persistent SSD, Linux x86_64/ARM64 with Node
22+ (24 recommended), Git, systemd >=250 and NTP. No Next.js build is run on this
machine. The observer imports the existing Node engine; Vercel continues hosting
the website. Maintain at least 2GiB free storage and monitor growth; never delete
historical/immutable observations to make a test pass. Local disk is persistent
across process/reboot, **not** a backup against instance/disk destruction.

Required egress: DNS and TLS 443 to GitHub API/Git/supplier clock reference;
TLS **9443** to `openapi.koreainvestment.com`. NTP follows the server's configured
time service. No public application port, tunnel, domain or load balancer is
needed. SSH management must be restricted to the operator's source IP; port
4318 remains loopback-only. A static attached IPv4 makes egress and diagnostics
predictable; it is not asserted to be a universal personal-KIS requirement.

## KIS facts and unresolved account conditions

The actual code uses the production domain, `client_credentials` AppKey/Secret
at `/oauth2/tokenP`, Bearer requests, existing quote/minute/calendar endpoints
and unchanged response-date/window guards. The current PC's real auth+10/19
calendar check succeeded (2 requests, 0 quotes, 0 retries). This does **not** prove
new-server network/IP access. No account identifier, password/key/token is logged.

[KIS personal onboarding](https://apiportal.koreainvestment.com/about-howto) and
the [official token documentation](https://apiportal.koreainvestment.com/apiservice-apiservice%3F/uapi/domestic-stock/v1/trading/order-cash)
describe AppKey/Secret client credentials and 24-hour access tokens. The existing
token manager caches by actual expiry, uses single-flight and refreshes safely.
Frequent token minting during crash loops is not a new retry strategy.
The [official error list](https://apiportal.koreainvestment.com/faq-error-code)
distinguishes invalid IP / corporate unauthorized-IP errors. It does not prove
every individual account requires fixed-IP registration. The account's portal
IP policy, corporate/personal classification and quota cannot be inferred solely
from a successful PC call. A 2026 new-customer quota notice also exists: do not
assume the official sample's example sleeps establish this account's entitlement.

Before raw KIS checkpoints move to a third-party cloud disk, confirm KIS/KRX
private cloud storage/processing permission. The prior unanswered usage-rights
question is not resolved by private GitHub storage or encryption. Do not copy
existing raw observations to the VM or activate cloud collection until confirmed.
Only the already approved score/rank projection may reach the private relay;
Production reader policy and access control are not expanded.

## Free feasibility and one recommendation

- Current Cloudflare Free limits are 10ms CPU, 128MB and 50 subrequests/invocation
  ([official limits](https://developers.cloudflare.com/workers/platform/limits/)).
  The existing 1,016-request/fs/Git Node daemon cannot be directly deployed there.
  A sharded durable-state rewrite might be possible, but is not implemented or
  established as free/reliable and would add raw-storage/rights dependencies.
- Vercel Functions/containers scale to zero and are stateless. On Hobby, duration
  max is 300s and cron may start anywhere in the scheduled hour; Pro's higher
  limits do not make a local filesystem daemon an always-on VM. See
  [Functions limits](https://vercel.com/docs/functions/limitations) and
  [cron precision](https://vercel.com/docs/cron-jobs/usage-and-pricing). No upgrade
  or entitlement is assumed. Rewriting storage/scheduling to Workflow is separate
  work, not an already working migration of this engine.
- [OCI Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
  is technically capable of hosting Node on an eligible VM with persistent volume.
  It needs new account verification, suitable home-region capacity and KIS access;
  idle instances may be reclaimed. Capacity and durable 14:00 operation are not
  proven. Do not burn CPU or change security to evade reclamation.

**Recommended: AWS Lightsail Linux/Unix, Seoul, public IPv4, 2GB / 2vCPU / 60GB**.
[Current official price](https://aws.amazon.com/lightsail/pricing/): **US$12/month**
including an attached static IP and listed transfer allowance; no new Vercel,
Cloudflare, DB, domain, load balancer or tunnel is needed. Estimated *additional*
baseline total is US$12 before tax (US$13.20 if 10% VAT applies), plus card/FX
fees. Existing service bills do not change. Region checkout must confirm exact
bundle price/transfer. Avoid the IPv6-only bundle: existing KIS IPv6 reachability
is not proven. Do not count promotional credits as permanent free operation.

Snapshot backups are optional **unapproved** cost: US$0.05/stored-GB/month; e.g.
20GB adds US$1 before tax. They also duplicate raw data and need rights review.
No snapshot, extra disk, support plan, NAT gateway or automatic paid expansion is
enabled here. The default design has one VM/disk failure domain; report that risk.

User actions if accepting this recommendation: create/sign in to AWS, enable MFA
and billing alerts, open Lightsail → Seoul → Linux/Unix → Ubuntu 24.04 LTS →
public-IPv4 **2GB US$12** bundle, and confirm the recurring price. Create/attach
its static IP. Do not open 80/443/4318 inbound; restrict SSH to the operator.
Supply only the host address/SSH alias for handoff, never a key/password in chat.
Store the existing approved KIS keys and repository-scoped Contents:write PAT
directly in root-only files below, using secure transfer/editor, not CLI values
or shell history. Confirm KIS account/network and cloud-processing rights before
activation. No purchase/account creation has been performed by the agent.

## Staged deployment (no collection)

Run as an approved server administrator after the server exists. Keep the PC
task active while staging; **do not create the cutover marker yet**. Install Node
24 from the vendor/OS's trusted source, Git and NTP. Verify `/usr/bin/node --version` and
`timedatectl show -p NTPSynchronized` (true). No Windows logon is needed for a
system service enabled under multi-user.target.

```sh
sudo useradd --system --user-group --home-dir /var/lib/tight-budget-live --no-create-home --shell /usr/sbin/nologin tightbudget
sudo install -d -m 0700 /etc/tight-budget
sudo install -d -o tightbudget -g tightbudget -m 0700 /var/lib/tight-budget-live
# Fresh destination only; do not reset an existing checkout.
sudo git clone --filter=blob:none --sparse --depth=1 --branch main https://github.com/klkl789982-droid/stock-research.git /opt/tight-budget
sudo git -C /opt/tight-budget sparse-checkout set infra/live-executor lib scripts/fixtures
sudo chown -R tightbudget:tightbudget /opt/tight-budget/.git
```

Inspect and pin the reviewed release commit, record `git rev-parse HEAD`, and
verify a clean tracked tree. Source files remain root-owned/read-only to the
service; `.git` is writable for `fetch`/lazy `show`. Use a regular clone, not a
worktree whose `.git` points outside the allowed path. Full history/raw market
files are not checked out; exact official inputs are fetched from a pinned commit
by the existing remote input adapter. Do not auto-update executable code at 13:59.

Create these files with a secure editor, `root:root` mode0600 (directory0700),
without echoing values, exporting Production website auth, or changing keys:

- `/etc/tight-budget/live.env`: **only** `KIS_APP_KEY` and `KIS_APP_SECRET`.
- `/etc/tight-budget/site-relay-writer.env`: **only**
  `PRIVATE_LIVE_DELIVERY_WRITE_TOKEN`, existing approved private-repo writer.

The service uses `LoadCredential` and `%d` paths; neither unit nor command line
contains values. See [systemd credential isolation](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).
Do **not** weaken `/etc` permissions to run validation. The supplied preflight
oneshot unit uses `LoadCredential` as the unprivileged account. Its commands are:

```sh
node infra/live-executor/server-preflight.mjs --state-dir=/var/lib/tight-budget-live --storage-check --network-check --kis-calendar=today
node infra/live-executor/verify-writer.mjs
```

`today` resolves the actual KST validation day, not a forced production signal date.
The first command requires `LIVE_EXECUTOR_ENV_FILE` and
`PRIVATE_LIVE_DELIVERY_WRITER_ENV_FILE` absolute private paths. It never collects
quotes; optional auth/calendar and TLS checks are explicit. The storage fixture
is create-only under `shadow/server-preflight`, with SHA256 reopen, duplicate and
conflict/single-owner checks. The second command only writes non-market fixtures
under `tests/site-delivery-writer`; it must leave operational pointers unchanged.
`CONFIGURATION_READY` **does not** mean PC-off or real-window operation is proven.

Install the four templates as `.service` / `.timer` names (omit `.example`):

```sh
sudo install -m 0644 infra/live-executor/tight-budget-live.service.example /etc/systemd/system/tight-budget-live.service
sudo install -m 0644 infra/live-executor/tight-budget-live-recovery.service.example /etc/systemd/system/tight-budget-live-recovery.service
sudo install -m 0644 infra/live-executor/tight-budget-live-recovery.timer.example /etc/systemd/system/tight-budget-live-recovery.timer
sudo install -m 0644 infra/live-executor/tight-budget-live-preflight.service.example /etc/systemd/system/tight-budget-live-preflight.service
sudo systemd-analyze verify /etc/systemd/system/tight-budget-live.service /etc/systemd/system/tight-budget-live-recovery.service /etc/systemd/system/tight-budget-live-recovery.timer /etc/systemd/system/tight-budget-live-preflight.service
sudo systemctl daemon-reload
sudo systemctl start tight-budget-live-preflight.service
sudo journalctl -u tight-budget-live-preflight.service --no-pager -n 20
```

The preflight only requests auth/calendar and non-market storage fixtures, and
does not enable the collector. Do not enable/start collectors yet. The absent root marker blocks both collector/recovery units even
if accidentally started. ProtectSystem=strict permits writes only to private state
and Git metadata; KillMode=control-group drains parent/child together. The existing
host allows three child restarts; systemd bounds host restarts to five/15min. The
13:35/13:58 KST timer starts only a stopped service; daemon still prepares 13:40,
fetches final input at 13:59 and collects only 14:00–14:05 on verified trading days.
Missed windows are never replayed. Outbox retry state persists and retains its
existing three-attempt cap; an exhausted queue needs reviewed operator recovery,
not an invented new observation or silent retry-budget reset.

## Required proof and single-producer cutover

While the collector stays blocked, run synthetic engine/store/supervisor/relay
tests on the VM. Verify restart from its persistent volume, one owner, duplicate
blocking, pending-outbox resume, secret permissions, outbound KIS auth/calendar,
read-only website authorization and no price fields in the relay. Schedule a
non-market probe **on the server** and verify its hash/receipt from another client
after SSH disconnect, without any PC relay, tunnel or local API. A GitHub Linux
test job proves portability only, not this server or PC-off operating evidence.
If an actual PC-powered-off test has not happened, explicitly leave that unverified.

Only after that proof, KIS rights and input readiness, choose a cutover **before
13:40 or outside the day's window**. Never run old/new collectors in parallel:

1. Preserve PC XML, version, state hashes and outbox. Export its status receipt.
2. Stop **and disable** only `TightBudget-Live-Executor-1002`; confirm no host/run
   process owned by that root/state remains (including the parent-lease drain).
   Retired GitHub/Cloudflare LIVE producers remain disabled. EOD remains active.
3. Copy only approved pending score-only outbox/receipts if needed, not raw
   checkpoints, locks or host identity. Preserve source dates/hashes. Re-verify
   before resending; do not change the website's latest with a synthetic fixture.
4. On the server record that PC fencing receipt, then create root-owned mode0600
   `/etc/tight-budget/server-cutover-approved` and enable/start the service and
   recovery timer. Confirm one supervisor+child, fresh heartbeat, writer CONFIGURED,
   and exact reviewed code/input receipt. The marker is an operator gate, **not**
   a distributed lease; no automatic active-active failover is claimed.
5. Confirm real server source/egress, server reboot recovery, private delivery and
   authenticated Production readback; test actual PC-off operation independently.
   Keep real 14:00 observation separately unverified until it occurs.

Rollback order is the reverse fence: stop/disable the server and recovery timer,
remove the activation marker recoverably, verify the cgroup has no collector,
preserve all new immutable records/outbox, then re-enable the prior PC task if
needed. Never reactivate the PC first or backfill a missed 14:00 signal. Before
14:00 the exact prior EOD/model inputs must be ready; all old block criteria remain.

## Evidence status

Local Windows executor suite: **94 passed, zero failed/skipped** after isolation;
the revised atomic-clock test was also rerun separately. TypeScript, touched-file
ESLint and `git diff --check` passed. Portable local tests cover real process restart/kill, filesystem integrity and
reopen, duplicate locks, bounded failed sends and exact unchanged model outputs.
Linux CI additionally checks all executor tests and systemd template syntax/
KST timer parsing without starting a service or using KIS secrets.
Its first run passed all 94 Node tests but systemd correctly rejected the missing
`/usr/bin/node` on the hosted runner (setup-node installs in a toolcache). The CI
now substitutes that verified executable **only in temporary validation copies**;
release units still require the actual server's `/usr/bin/node`. No executable
check is disabled. This is not evidence that the server has been deployed.
The first parallel local suite had one heartbeat-fixture timeout. Test files now
run serially so deliberate process stalls cannot interfere with unrelated timing
fixtures. The synthetic clock file also uses atomic replacement: its reader must
never see a truncated empty value as epoch zero. Neither change alters production
watchdog deadlines, collection windows, retry budgets or validation assertions;
this test timeout is not evidence for the original three supervisor exits.
Actual paid/free VM, Linux boot/systemd operation, server KIS connection, cloud
raw-processing permission, PC-off probe and real 14:00 execution remain **not
verified** until performed on an approved provisioned server. The current PC
task deliberately remains enabled; this work is migration preparation, not a
claim that the user's final autonomous-operation objective has been met.
