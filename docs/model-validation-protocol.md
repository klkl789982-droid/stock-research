# Model validation protocol

## Immutable versions

Every formula is identified by `<modelId>-<version>`, for example `B-v1`.
`data/model-registry.json` is append-only. Registration rejects duplicate IDs;
never edit an old entry to describe a new formula. Existing A/B/C/D formulas
are v1. E-v1 is a reserved, `notConfigured` entry and cannot be experimented
on until a formula is pre-registered as a new version.

Before registering a version, copy the proposal example and record hypothesis,
expected benefit, known risk, evaluation metrics, change reason, and parent
version before looking at validation results.

## Time partitions

`config/model-validation-periods.json` separates train, validation, and sealed
finalHoldout periods. Walk-forward windows contain only train followed by
validation. The validator rejects overlaps, reversed time, and any window that
reaches the final holdout.

The final holdout is evaluation-only. Every future holdout evaluation must be
appended to the experiment's `holdoutAccess.accesses`; it must never be used for
formula design or weight selection.

## Pre-registration

Create an immutable experiment file before reading results:

```bash
npm run experiment:create -- --spec=config/my-experiment.json
```

The experiment freezes model version, hypothesis, metrics, period snapshots,
walk-forward windows, readiness warnings, and an empty result matrix covering:

- TOP10, TOP20, TOP50
- 1d, 5d, 20d
- ALL, KOSPI, KOSDAQ
- ALL, bull, sideways, correction, bear regimes
- average/median/excess return, win rate, MDD, observations

Experiment files are created with exclusive-write semantics and cannot replace
an existing experiment ID.

## Readiness rules

Run:

```bash
npm run validation:readiness
```

Initial rules warn when there are fewer than 60 trading days, 1,000
stock-observations, or two labeled regimes. Warnings are recorded at experiment
creation and do not block work yet. Passing these thresholds is not proof of
statistical sufficiency.

## Walk-forward order

For each registered window:

1. Use only its train dates for research or fitting.
2. Freeze the exact model version and experiment metadata.
3. Evaluate once on the following validation dates.
4. Move the window forward without importing later data into earlier scores.
5. Aggregate window results and make a keep/reject/needsMoreData decision.
6. Use finalHoldout only for a pre-registered final evaluation of a frozen
   candidate; record access and decide promote/reject.

Do not change weights under the same version. Any formula, weight, threshold,
or penalty change requires a new append-only model version and experiment.

## Cross-sectional validation metrics

`model-validation-v1` treats each signal date as one cross-sectional observation.
It does not treat every stock on the same date as an independent time-series sample.
Spearman Rank IC uses average ranks for score and return ties. Deciles are assigned
after deterministic frozen-rank-then-code ordering and are balanced by row count;
decile 1 is the top bucket. The reported top-decile-minus-bottom-decile value is an
eligible-universe-relative spread, not a market benchmark excess return. Until an
approved KOSPI/KOSDAQ benchmark source exists, `benchmark` and `excessReturn` remain
`null`. Metrics may be displayed before 60 resolved signal dates, but no validation,
promotion, or model-superiority conclusion is allowed before that threshold.
