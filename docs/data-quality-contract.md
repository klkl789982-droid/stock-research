# Research contract and acceptance rules

Version: `market-source-research-v1`. This contract does not modify Daily/LIVE/KIS production schemas or quality thresholds.

Observation includes ticker, nullable market, exact ISO reference date, descending normalized history, OHLCV/value, adjustment, session scope, provider, actual request/receipt timestamps (nullable if unavailable), source finality, security/corporate-action status, original source hash, adapter version, normalized input hash and full observation hash. Never infer a price/value/timestamp from missing data. `ACTUAL_RESPONSE`, `SAVED_ARTIFACT` and `TEST_FIXTURE` are distinct; saved official seed replay has no invented API request time.

Both existing parsers are reused. Public payload business code must be 00; KIS response ticker must match. Duplicate/future dates and other ticker rows are rejected. Invalid numbers, OHLC relationships, fractional/negative volume and missing/negative trading value prevent acceptance. Actual no-trade/halts remain explicit and cannot create an executable price. Existing classification and model history requirements remain authoritative.

UNKNOWN is retained for undocumented adjustment/session/finality fields. Comparison can expose numeric differences as diagnostics but cannot certify equivalence when identity, quality, price basis, session or corporate-action review is unresolved. No tolerance silently repairs or averages disagreements. Possible causes (timing/session/adjustment/revision) are hypotheses, not findings.

## Model batch gate

- Complete, unique supplied universe, one provider/date/adjustment/session/observation kind; no per-symbol fallback.
- All observation hashes verified; receipt not after as-of and as-of after 15:30 KST. This is a research date boundary, not evidence of finality or a replacement trading calendar.
- Confirmed adjustment/session basis; unknown basis blocks new research ranking.
- Existing official snapshot supplies quarantine, with snapshot hash preserved and no future reference date.
- Expected formula hashes match the immutable versions A-v1/A-v2/B-v1/C-v1/D-v1.
- Existing history validator, non-trading normalization, change-rate resolver, engine and rank tie rules reused. 260 valid histories for A/B/D and 34 for C; short histories excluded, never scored as normal.
- Partial/malformed batches block TOP query; pre-existing quarantine/halt/delisting and short-history exclusions are explicit. Excluded rows have no manufactured scores/ranks.

Research result contains provider/date/as-of, universe/formula/quarantine/input hashes, scores/ranks/exclusions and separate stage verdicts. No future return computation and no production publication. Comparison of models requires same date, universe, formula and basis; reports score/rank delta, exclusions and TOP5/10/20 overlap.

## Rights, storage and query

Separate grants for API query, auto collection, local/cloud storage, private research, derived calculation, website display and third-party sharing. Every allowed grant needs an evidence identifier; defaults deny. Synthetic grant IDs exist only in tests. Grant configuration is an operator assertion backed by external evidence, not an automated legal decision or authentication replacement.

Existing private local store or caller-supplied private adapter is reused. Normalized shards: `multi-source-research/inputs/<inputHash>.json`; immutable manifest: `multi-source-research/results/<manifestHash>.json`. Same content is create-only/deduplicated; revised data creates another hash; conflict/readback corruption fails. Input/result ticker, provider, date and hashes must bind. Previous files remain untouched. Partial write produces no verified result receipt; retry verifies existing shards before finishing.

Native raw journals remain evidence; the new manifest references raw/observation hashes and timestamps. It does not claim to preserve new original API response bytes. Cloud writes are not enabled by this task. No latest mutable production pointer is introduced.

Private local query:

```text
node scripts/query-market-source-research.mjs --manifest=multi-source-research/results/<hash>.json --rights=<private-rights-file> --model=B-v1 --top=10
```

This reads the existing local private store, validates manifest and every input hash, checks local-storage/private-research grants and returns scores/ranks only. It is an operator CLI, not a public or session-authenticated API. Existing proxy/routes/Redis remain unchanged. Do not commit the rights file or pipe private output into public artifacts.

Read-only diagnosis:

```text
node --env-file=.env.local scripts/diagnose-market-source-latest.mjs --date=<target> --control=<prior-known-date>
node scripts/verify-market-source-existing-evidence.mjs
node --test scripts/test-market-source-research.mjs
```

Diagnosis caps ten sequential requests with 15s deadlines, redacts credentials/errors and prints only hashes/dates/counts/status. It does not collect a production universe or promote results. Existing-evidence replay reads local private artifacts, verifies hashes, recalculates with the existing evaluator and compares old official seed OHLCV without new requests or writes. Trading value unavailable in that seed remains unverified.
