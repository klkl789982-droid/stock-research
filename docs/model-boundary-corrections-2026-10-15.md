# ABCD boundary corrections: evaluation only

## Version contract

The production model remains A-v1; existing A-v2 remains a challenger. Existing A-v1/A-v2/B-v1/C-v1/D-v1 functions, registry entries, historical scores, score-engine routing, and publication workflows are unchanged. The new adapter has no production caller. No version is promoted automatically.

New immutable evaluation candidates:

| Version | Calculation | Minimum usable observations |
|---|---|---:|
| A-v3 | A-v2 behavior, with fully flat simple-average RSI corrected from100 to50 |260|
| C-v2 | C-v1 weights/thresholds, flat RSI corrected to50, complete required features |35|
| D-v2 | Unchanged B-v1 × eligible C-v2 /100 |260|

A-v3 retains A-v2's clamp to0–100 and descending raw-score tie-break before code. C-v2 requires35 observations: the current MACD histogram first exists at34, but its previous histogram requires35. At34, C-v1 silently substitutes50 for histogram direction; C-v2 returns ineligible with null score. D-v2 is ineligible if either component is unavailable. B-v1 is not numerically changed and uses its original feature function.

The adapter also requires an explicit existing qualityEligibility.eligible=true, valid descending unique OHLCV rows, current daily change, and finite required indicators. ATR must be positive because normalized MACD direction is otherwise undefined. Missing input is not replaced by a zero or neutral score. The adapter does not certify corporate-action policy, point-in-time universe, publication timing, or future returns; those are still the original quality gate's responsibility.

## What is deliberately unchanged

- “N” momentum retains its legacy meaning: N close observations, N−1 close-to-close intervals. The3/5/20/60 labels therefore cover2/4/19/59 intervals. Full-N interval migration is a separate hypothesis, not included here.
- RSI uses arithmetic averages of14 gains/losses, not Wilder smoothing. New candidates use flat=50, gain-only=100, loss-only=0. A flat previous window followed by a gain now produces a meaningful RSI change.
- A's bonus is a qualifying bullish state, not a newly detected reversal. Volume direction still depends on medium-term momentum. Neither weight is tuned in this patch.
- C's risk penalties and35-point aggregate cap are unchanged.
- D is a multiplicative intersection score. Its lower numeric scale is expected, not a reason to rescale it to match A/B/C.

## Descriptive comparison

Comparison date:2026-10-13. All four models are reranked on the same508 quality-eligible stocks. C's original independent universe contains523 stocks, so its published full-universe rank is not used for pairwise comparisons here.

| Model | Mean | Median | Range |
|---|---:|---:|---:|
| A-v1 |34.16|24.56|0.10–101.83|
| B-v1 |43.20|39.34|1.91–96.04|
| C-v1 |37.77|41.33|0–88.84|
| D-v1 |18.05|13.54|0–72.53|

Top10 overlap counts: A/B5, A/C3, A/D6, B/C1, B/D5, C/D5. A/B rank correlation is0.923. These are score characteristics, not return comparisons or win probabilities.

Across10 existing dates from2026-09-22 through2026-10-13,5,080 common stock-date observations were replayed. All20,320 existing A/B/C/D scores matched exactly. New A-v3 vs existing A-v2, C-v2 vs C-v1, and D-v2 vs D-v1 have zero score differences and zero new ineligibilities in that common260-observation sample. Checking all archived C-eligible counts also found no record with exactly34 observations. Neither statement guarantees future boundary cases will be absent.

A-v3 vs A-v1 is a different comparison: the pre-existing A-v2 clamp changes8 observations,3 below0 and5 above100. On2026-10-13, A-v1 has2 scores above100 (101.83 and100.04), which clamp to100 while raw-score ordering is retained.

Synthetic flat-close tests with nonzero trading ranges verify RSI100→50, A23.90→34.40, and C40.00→56.40. A35-observation C test now has both histogram values;34 is ineligible. Tests include gain-only, loss-only, mixed movements, previous-flat RSI change, invalid inputs, missing features, quality exclusion, upper clamping, and tie-breaks.

## Latest closed-date extension

After the initial report, the2026-10-14 archive from commit38c12f01d534f5cf53feea9033fc6169ff7907a6 was included. Final coverage is11 dates,5,588 common stock-date observations, and22,352 exactly reproduced legacy scores. A-v3 vs A-v2, C-v2 vs C-v1, and D-v2 vs D-v1 still have zero score differences and zero new exclusions in this sample.

On2026-10-14, the same508-stock mean scores are A31.43/B41.91/C36.59/D15.61; medians21.52/37.73/36.805/11.18. Top10 overlaps are A/B3, A/C1, A/D3, B/C0, B/D2, C/D6. A/B rank correlation is0.9031. These daily differences illustrate why a single-date overlap is not a model-performance conclusion.

Relative to A-v1, the existing clamp adds three changes on this latest date: 팬오션100.80→100, 펌텍코리아100.01→100, 세아메카닉스101.55→100. Final11-date total is11 clamped observations (3 below0 and8 above100). This is the inherited A-v2 range correction, not an effect of the flat-RSI correction. Production A-v1 scores are not rewritten.

## Reproduce without market requests

From the repository root:

```sh
node scripts/test-model-boundary-challengers.mjs
node scripts/compare-model-boundary-challengers.mjs
```

For an existing archive in another checkout:

```sh
node scripts/compare-model-boundary-challengers.mjs --archive-root=/absolute/path/to/archive
```

The comparison script reads existing seeds and snapshots, emits a JSON report to stdout, and never writes into the archive. Both input hashes are checked before and after each date. The caller may redirect stdout to a new report file. It reconstructs daily change from adjacent closes, rounded to2 decimals, then proves exact legacy-score replay before considering the descriptive comparison reproducible.

Registry formula hashes cover explicit version definitions and canonical-LF source hashes for the adapter, corrected A source, corrected feature source, original B feature/formula source, C weights, and D product. This prevents a feature correction from silently changing an existing version's identity. The copied corrected sources are frozen lineage, not intended as a generic replacement for legacy consumers.

## Interpretation limits

The available snapshots remain rejected for certified rank backtesting/optimization. There is no validated regime winner, portfolio return claim, probability calibration, or evidence of improved profitability from these changes. Model suitability by market regime is design intent only. Prospective validation on certified data and a separate approval are required before any operating-model change.
