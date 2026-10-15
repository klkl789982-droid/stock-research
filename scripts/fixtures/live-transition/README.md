# LIVE transition regression fixture

`2026-10-13.json` freezes the October 13 14:30 KST observation scenario used by
`scripts/test-live-transition-screener.mjs` and
`scripts/test-home-transition-live-ui.mjs`. Its clock, matching READY latest
pointer (including `lastGood`), and calendar are test-only inputs. The calendar
retains the verified prior sessions and holidays through October 12 and leaves
the observed day and next weekday unknown, as in the pre-EOD scenario.

The `archives` entries reuse the committed, dated October 13 signal and October
12 seed/history without copying roughly 22 MB of real market inputs. Their
SHA-256 checksums pin the exact archived bytes. The full 553-symbol universe,
including 508 eligible and 45 ineligible records, remains intact; four invalid
quotes leave 504 usable LIVE rows. Timestamps,
quotes, prices, source hashes, and scores are not synthesized or relabelled.

Do not refresh this fixture from production `latest.json` or the current
calendar during tests or daily data promotion. The production pointer/calendar
are read only to verify that the test did not modify them. Store tests materialize
the pinned inputs at production-shaped paths inside a temporary directory and
apply all failure mutations there.

If an archived input is intentionally repaired, review the scenario and all its
date, freshness, quote, and provenance assertions before updating the pinned
checksums. A daily promotion alone should never require a fixture update.

Run the complete regression command with `npm run transition:live-test`.
