# Autonomous research backlog

Updated 2026-10-12. Preserve model formulas, outcome definitions, immutable observations and operational approval boundaries. Research does not grant data-use rights.

## 1. Establish rights and close-time session/finality contract

Problem/evidence: KIS's historical 508-symbol OHLCV equality does not establish 15:40/16:10/16:40 finality; cloud/shared/display rights await an answer. Portal explicitly limits redistribution. Benefit: lawful fast-data operation and a sound basis for provider equivalence. Difficulty: medium technical, external contractual dependency. Cost: no new spend approved; licensing quote may be needed. Validation: written provider scope, actual scheduled private observations within approved rights, next-day same-date OHLCV/value/session/action comparison. Failure risk: after-hours/revisions or restricted use prevent deployment. Prerequisite: written rights and session semantics. Highest priority; do not enable new collection/publication yet.

## 2. Measure official delivery and publication end to end

Problem/evidence: October 8 empty at October 12 04:08 is compatible with next-business-day-after-13:00 policy. Existing schedules cannot accelerate that supply. Benefit: distinguish expected latency from missed runner, collection, gate, Git/Vercel/API failure. Difficulty: low/medium. Cost: bounded existing API budget, no new service. Validation: correlate provider probe, actual scheduled event/start, candidate, quality, promotion, push/deployment/API reference dates over multiple trading days. Stop interpreting runner Success as data freshness. Failure risk: upstream cache/late delivery and inaccessible deployment logs. Prerequisite: authenticated read-only operation evidence and normal trading days; any production changes require their own scoped approval. Second priority.

## 3. Study provider differences on held-out dates

Problem/evidence: saved official seed lacks trading value; new adapters retain unknown basis/session and deliberately block ranking. Benefit: quantify sensitivity of unchanged A/B/C/D/TOP selections to provider inputs without fitting formulas to one comparison date. Difficulty: medium. Cost: capped samples first, full 553 only within verified rights; actual monthly storage/traffic to measure. Validation: predefined dates/symbols including halts/new listings/corporate actions, canonical input comparison, unchanged engine/reproducible TOP overlap and score/rank deltas; reserve independent dates for confirmation. Failure risk: incompatible adjustments, correlated upstream data, short histories. Prerequisite: priority1 permissions and basis evidence. Third priority.

## Recorded decisions and failures

Updated same-date evidence: October8 official seed arrived via origin/main during the task. Only40/508 comparable symbols match all OHLCV fields; unchanged-engine score differences are present (A444/508, B462/508, C457/523, D438/508). No cause is assigned yet. Priority3 must explicitly isolate session, corporate-action, history window and rate-input differences before any substitution. A-v2 official challenger has no comparable rank; it must remain unavailable rather than showing zero overlap. Exact/latest/XML detect October8 while begin=end range returns0, so absence detection must not rely on range alone. Existing official automated manifest is PROMOTED and repository status fresh; deployed API/UI remain unverified here.

Per-field October8 agreement: open508/508, high478/508, low406/508, close55/508, volume508/508. This pattern makes session/price-definition verification a concrete first investigation, not proof of a particular cause. TOP5 overlap is A4/5, B5/5, C2/5, D4/5. A-v2 rank comparison is unavailable. No source was selected as correct and no old record was repaired.

Validation completed: new research suite12/12; combined related suite67/67; additional public-request/quality/snapshot/Production-auth/LIVE-outcome tests passed (legacy scripts contain their own assertions). TypeScript, ESLint and Production Build passed. Existing warnings: three unused declarations in financial API and top-stocks filesystem tracing. Existing Next configuration excludes `.runtime/kis-eod/**/*` from tracing. No new research runtime data is part of a public build or commit.

Use two role-separated existing sources, not three always-on collectors. Unknown grant/basis fails closed; no partial per-symbol production blend. Do not introduce adjusted-history incremental caching until corporate-action invalidation is verified. Keep research settings/version/hash and failed comparisons; never overwrite earlier input/rank to fit later outcomes.

Actual local audit report is `PARTIAL`: 553 requested, 523 accepted, 30 quarantine; successful HTTP requests do not make 553 valid inputs. 508 long-history model coverage and C523 reproduced. Saved-seed comparison: 508 equal OHLCV, value unavailable, equivalence unverified. Synthetic 553 integration demonstrates code behavior only. Future scheduled LIVE/close-time observations remain unverified until they occur.

Implementation self-review fixed input/result store binding, readback validation and collector response-contract identity checks. Timeout retains per-provider overlap protection while a non-cooperative request is outstanding. Saved-artifact replay does not fabricate source timestamps. Outstanding concerns: process-local coordination, rights verification outside code, original raw evidence retention in native journals, actual source semantics and distributed scheduling. Existing public raw-data history needs a separate authorized rights/remediation plan; no data deleted here.
