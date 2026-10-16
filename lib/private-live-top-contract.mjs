// Versioned wire contract only. Importing this module never changes a collector's
// active time policy. The website can receive 14:00 data before collector cutover.
export const PRIVATE_LIVE_PROFILE = Object.freeze({ schemaVersion: 2, policyId: "intraday-1400-v1", signalTime: "14:00:00", windowEnd: "14:05:00" });
const fail = () => { throw new Error("LOCAL_EXECUTOR_UNAVAILABLE"); };
const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const stamp = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value));
export function projectPrivateLiveTop(value, mode, model, profile = PRIVATE_LIVE_PROFILE) {
  if (mode === "live") {
    const start = Date.parse(`${value?.signalDate}T${profile.signalTime}+09:00`), end = Date.parse(`${value?.signalDate}T${profile.windowEnd}+09:00`);
    if (value?.schemaVersion !== profile.schemaVersion || value.observationPolicyId !== profile.policyId || value.officialSignalTime !== profile.signalTime || !Number.isFinite(start)
      || Date.parse(value.collectionStartedAt) < start || Date.parse(value.collectionCompletedAt) > end) fail();
  }
  if (value?.mode !== mode || value.observationType !== (mode === "live" ? "LIVE_OBSERVATION" : "CURRENT_TIME_SHADOW") || value.modelVersion !== `${model}-v1`
    || !date(value.signalDate) || !date(value.seedReferenceDate) || value.seedReferenceDate >= value.signalDate || !/^[a-f0-9]{64}$/u.test(value.contentHash ?? "")
    || !stamp(value.collectionStartedAt) || !stamp(value.collectionCompletedAt) || Date.parse(value.collectionStartedAt) > Date.parse(value.collectionCompletedAt)
    || !Array.isArray(value.records) || value.records.length > 5) fail();
  const records = value.records.map((row, index) => {
    if (!/^\d{6}$/u.test(row?.ticker ?? "") || typeof row.companyName !== "string" || !row.companyName.trim() || row.companyName.length > 100
      || !Number.isFinite(row.score) || row.score < 0 || row.score > 100 || row.rank !== index + 1) fail();
    return { ticker: row.ticker, companyName: row.companyName, score: row.score, rank: row.rank };
  });
  if (new Set(records.map(row => row.ticker)).size !== records.length) fail();
  return { model, modelVersion: value.modelVersion, signalDate: value.signalDate, seedReferenceDate: value.seedReferenceDate,
    officialSignalTime: mode === "live" ? profile.signalTime : null, freshnessStatus: "NOT_EVALUATED", contentHash: value.contentHash,
    collectionStartedAt: value.collectionStartedAt, collectionCompletedAt: value.collectionCompletedAt, records };
}
