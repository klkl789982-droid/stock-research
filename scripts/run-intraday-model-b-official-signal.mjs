// Retired entrypoint: intentionally no filesystem, credentials or network access.
// Preserve 14:30 archives unchanged. New B results share the canonical 14:00 TOP
// observation, so even old --allow-any-time invocations cannot collect again.
console.log(`INTRADAY_MODEL_B_RESULT_JSON=${JSON.stringify({ status: "RETIRED", reason: "USE_CANONICAL_MODEL_TOP_1400", liveObservationCreated: false, signalPath: null, latestPath: null })}`);
process.exitCode = 1;
