# 2026-10-08 source discrepancy investigation

## Scope and evidence limitations

Read-only evidence replay and bounded live sample queries on 2026-10-12. No raw prices, credentials, private response files, formula changes, production promotion, or scheduler changes are included in this commit. Existing Cloudflare working-tree edits belong to another task and are excluded.

The old KIS journal preserves normalized history and a verified artifact hash, but not the successful original API JSON. Therefore it proves what our prior collector recorded, not whether a supplier revision or an old ingestion defect caused that value. Supplier internal cause, market-session equivalence and end-of-day finality remain unconfirmed. Current sample equality does not certify provider equivalence or authorize publication.

## Prior evidence replay

523 private artifacts verified without writes or requests. 508 eligible official seed comparisons: OHLCV equal 40/508 (7.87%); close equal 55/508 (10.83%). Open and volume equal 508/508, high 478/508, low 406/508. 453 close discrepancies, 15 close-equal/other-field discrepancies, 40 entirely equal. No volume-only discrepancy. Official normalized seed lacks trading value; missing value is not zero.

For the preceding ten dates, all 5,080 compared OHLCV rows agreed. Divergence was concentrated in the latest October 8 row. Prior KIS evidence was collected on October 9 around 14:43–14:54 KST, not observed at October 8 close.

## Current response tracing

October 12 queries: Samsung Electronics (005930), SK Hynix (000660), Inteckplus (064290), plus six selected cases: 000020/000100 close discrepancies, 000250/001200 close-equal other-field discrepancies, 002020/003690 entirely equal. Current KIS and exact-date public responses agree on OHLCV and trading value for all nine samples. This is 9/9 sampled agreement, NOT a fresh 508-stock verification.

The forensic six-stock query ran 2026-10-12T04:50:16.765Z–04:50:21.970Z, using 19 HTTP attempts including authentication. Independently mapped current raw KIS response fields agree with the existing parser, public raw-response normalization and saved official seed. The four previously discrepant samples differ between cached and current KIS normalized rows; open/volume/trading value remain equal. Adjusted and unadjusted latest sample rows agree and have no reported adjustment event. Raw payloads exist only in memory; output contains hashes, field-equality flags and timestamps, not prices.

Conclusion: the large old comparison is a temporal observation-version discrepancy, not proof of a persistent provider-quality difference. No present mapping, code, date, adjusted-flag or volume-unit defect was reproduced. The old successful raw JSON is absent, so the historical mechanism cannot be conclusively assigned to the supplier. Session coverage must not be inferred from coincident values.

## Model-input sensitivity (diagnostic only)

Existing engines replayed old KIS inputs against saved official results. Unknown session/price equivalence prohibits model-quality conclusions and production use of this comparison.

| Version | Compared | Different scores | Maximum absolute score difference | Different ranks | TOP5/10/20 overlap |
| --- | ---: | ---: | ---: | ---: | --- |
| A-v1 | 508 | 444 | 19.01 | 461 | 4/8/19 |
| A-v2 | 508 | 444 | 19.01 | 461 | 4/8/19 |
| B-v1 | 508 | 462 | 7.77 | 436 | 5/10/17 |
| C-v1 | 523 | 457 | 24.47 | 509 | 2/7/17 |
| D-v1 | 508 | 438 | 18.41 | 487 | 4/9/16 |

Fixed research replay's A-v2 raw-score field reference from nonexistent `rawAV2Score` to the existing calculator's `rawScores['A-v2']`. This repairs diagnostic ranking only; the engine, stored results and official ranking remain untouched.

## Official EOD recovery actually observed

GitHub scheduled run #49 / 38195891982 used commit 975ff5f. Cron `23 23 * * 0-4` intended 08:23 KST, actually began 11:28 KST (roughly three-hour delay). It collected October 8, passed the existing candidate gate and published commit 9e57d27757bc2d519bd2876e5c19e7d0b49d4a09. Manifest `data/daily-runs/2026-10-08/daily-20261012022831.json` is PROMOTED, completed at 11:36 KST. This was a real schedule event, not a manual recovery attributed to automation.

Repository freshness at 13:40 KST: observed, collected, validated and published dates all October 8, `fresh`, lag zero, recent failure null. Historical failure retained: `LATEST_PROBE_NETWORK_TIMEOUT` on October 10. Follow-up runs #50/#51 are workflow_dispatch, not scheduled successes. Vercel data-publication deployment Ready at 11:37:59 KST; main 79f7bce deployment Ready at 13:41:41 KST. Administrator browser/API display still requires a valid session; deployment readiness alone does not prove rendered reference date.

Supplier next-business-day publication, October 9 holiday and October 10–11 weekend explain why October 8 did not necessarily arrive on close day. Exact first availability was not continuously observed. Earlier empty API observations and subsequent successful batch can reflect different request/timing visibility; do not assert a global first availability time. `basDt` exact queries and latest queries must be distinguished from a begin=end range query that returned empty during separate probes.

Existing morning/recovery cron, sequential missing-date recovery, quality gate, allowlist publication, idempotency and deployment verifier are retained. No additional scheduler role is silently enabled. Scheduled execution timing remains best effort. Public API terms and KIS storage/display rights remain independent approval constraints.

## Follow-up priorities

1. Observe paired successful raw responses privately with timestamps/hashes under approved storage rights, to distinguish historical ingestion from supplier revisions.
2. Verify exact session/finality/adjustment and legal rights before admitting KIS provisional inputs to any public rank.
3. Monitor real scheduled source-arrival-to-publication latency, including independent trigger evidence and authenticated API verification; do not replace it with manual-success claims.

Sources: https://www.data.go.kr/data/15094808/openapi.do ; https://www.fsc.go.kr/in060501 ; official KIS example https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_daily_itemchartprice/inquire_daily_itemchartprice.py .
