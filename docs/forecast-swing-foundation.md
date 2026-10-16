# Five-session swing preparation foundation

## What is implemented

- Protected `/forecasts` page and read-only `/api/forecasts/swing?code=005930`, linked from the existing navigation.
- Preparation status, observed quote date/time and reference price, missing original artifact-availability time, model version, readiness blockers and a read-only preparation ledger.
- Immutable, canonical-hashed preparation records with actual new issuance time, observation time, input receipt/availability evidence, source artifact/hash, observed A–D feature versions/formula hashes and seed hashes.
- Pure five-session benchmark resolver and evidence validator. It requires a complete confirmed calendar, official prices, actual receipt/publication proof, explicit security/executability/adjustment evidence, and strictly post-issuance entry. It never imports old `MATURE` flags.
- Whole-observation-date chronological splitting that purges overlapping label windows and labels unavailable at the training cutoff. It does not train a model.

All forecast probabilities, expected returns, ranges, real fills and net returns remain null. The version is `swing5-1400-preparing-v2`; training and external validation have not occurred. Existing A–D scores remain observed features, not forecast probabilities. Different observation dates are counted as date groups, not assumed statistically independent; overlapping five-session windows remain dependent.

Day trading is explicitly preparing because no sufficient minute-by-minute execution-path dataset is stored. No provider, credential, paid service, auth policy, scoring formula or historical artifact is changed. The accompanying local cutover changes future LIVE scheduler/collector source code, without executing or deploying it.

## Timing and interpretation

The observed source quote has its own event time. Nominal 14:00 is not a common tradable fill, and collection completes later. The immutable signal does not preserve final producer/publication availability; the dashboard reports that field as unknown. The audit describes hash-bound producer receipts recoverable from Git, but this version does not silently import or certify them.

A new preparation record is issued only after reading and validating the saved artifact. Its `SYSTEM_OBSERVED` receipt is that actual completed read time, never an invented historical availability. Per-input observed/available times refer to this read of the stored features; the quote event date/time remains in `observation`. Recording an old observation today does not create a past forecast.

Entry is the first confirmed trading-session open strictly after actual issuance. For an after-open or after-hours issue, this is a later trading session; for a pre-open issue, that day's upcoming open can qualify. Entry exactly at issuance is rejected. Exit is the close of the fifth session including entry. No missing ticker day is skipped or replaced by a later bar.

The resolver's `OBSERVED` means an official-price **gross benchmark**, not a real fill, tradable portfolio return, prediction accuracy or profit after costs. Unknown inputs produce `BLOCKED`; a future exit produces `PENDING` only when a complete confirmed calendar establishes that it is genuinely future. All outcomes retain `forTraining:false`, `actualFill:null`, `executableReturn:null` and `netReturn:null`.

`validateSwingOutcome` checks integrity and contract semantics. With the original evidence and forecast, it also regenerates the result. A content hash or caller-supplied evidence record alone does not establish independent provider authenticity. Verified source adapters remain necessary before real historical labels or training can be certified.

## Preparation ledger

The new namespace is `data/forecast-ledger/swing-5d/<forecastHash>.json`. It is distinct from all historical signals, prices, outcomes and model-validation data.

Preview, with no writes:

```sh
node scripts/record-swing-preparation.mjs --code=005930
```

Explicit local append:

```sh
node scripts/record-swing-preparation.mjs --code=005930 --record
```

The CLI does not accept historical timestamps or collection switches. Files use exclusive create; identical retries are idempotent and conflicts cannot overwrite data. The log says `predictionCreated:false` because this is a preparation record. The UI labels it “준비 기록 · 예측 미발행”. GET requests never append records.

No preparation entry was appended to the repository in this task. CLI write behavior was tested only in disposable synthetic directories. There is no scheduled production writer, server-side persistent-write endpoint, automated label publisher or training job. Serverless local disk must not be assumed durable; future production persistence requires a separately reviewed implementation and release authorization.

## Five-session result comparison

Call `resolveSwingOutcome({forecast, resolvedAt, calendar, prices, executionEvidence})` from `lib/forecast-swing-contract.mjs` only after obtaining the complete explicitly proven evidence. Keep the returned outcome separate from the frozen forecast; its hash links to `forecastHash`. `validateSwingOutcome(outcome,{forecast,evidence})` verifies the deterministic comparison. The synthetic examples in `scripts/test-forecast-swing-contract.mjs` document the evidence schema.

This version supplies and tests that comparison engine but does not automatically turn the existing price ledgers into verified evidence, persist outcome files, or display invented results. The dashboard's evaluation counts are zero for this preparation-only model; they are not imported totals from legacy outcome files. Automated evidence ingestion/result publication remains future work.

## Actual data and readiness

See [the data audit](forecast-swing-data-audit.md). The pinned baseline contains four archived 14:30 LIVE dates, 2,032 available ticker-date rows and zero mature five-session labels. The new 14:00 cohort has zero saved dates and is kept separate; archive observations cannot seed the new preparation ledger. Official prices/calendar end Oct 15. Point-in-time universe, security status, delisting and corporate-action/adjustment evidence remain incomplete. Existing archived short-horizon outcome flags have timing weaknesses and are deliberately not reused. The new current resolver requires explicit timing/security evidence and cannot manufacture mature returns from the old flags.

## Reproduce verification

```sh
node --test scripts/test-forecast-swing-contract.mjs
node scripts/test-forecast-swing-store.mjs
node scripts/test-forecast-swing-ui.mjs
node scripts/test-admin-auth.mjs
npm run build
npx tsc --noEmit --incremental false
npm run lint
node scripts/test-forecast-swing-packaging.mjs
node scripts/test-admin-auth-http.mjs
node scripts/test-admin-auth-production.mjs
```

The HTTP tests use ephemeral synthetic local authentication, not a real administrator account. The package test executes the real compiled handler using only NFT-listed files and permits only its local synthetic auth store; protected access, checkout parity, missing/hostile data and null-only outputs are checked.

The accompanying cutover updates obsolete intraday UI assumptions, uses real publication-identity helpers in the API fixture, and corrects the freshness harness: missing deployment proof remains UNVERIFIED; only an exact date/hash/commit/ready match permits SOURCE_WAITING. The [Daily Worker contract repair](daily-worker-contract-repair.md) also closes the previously recorded four infrastructure failures. See the combined verification report for final results.

Actual Chromium visual QA is unverified: the executor blocked its singleton socket with `Operation not permitted` before page capture. SSR/interaction-state tests and local HTTP responses are verified; a successful login response alone is not visual verification.

## Restore and release boundary

Baseline: `65ebc6ee291c522dd630e8d0de852efa23b3468f` in `klkl789982-droid/stock-research`. This is a separate local patch. Earlier evaluation/Home/forecast-contract patches and the later Model B repair were absent from the current environment and are not claimed to be restored. The accompanying 14:00 cutover newly retires the duplicate B collector, removes its TOP override, and preserves dated recovery diagnostics. See [the cutover contract](live-1400-cutover.md).

The recovery archive contains the patch, changed source files, original versions of modified files, dependency manifests, exact baseline metadata and verification report. It excludes credentials, environment files, raw financial datasets, installed dependencies and build output. The repository's retained history is still needed for its original data; the archive is a code recovery package, not a dataset backup.

No commit, push, workflow execution, deployment or privacy-setting change occurred. Existing repository-visibility and data-use release holds remain in force.
