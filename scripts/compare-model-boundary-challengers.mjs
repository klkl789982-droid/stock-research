import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { calculateSnapshotModels } from "../lib/model-score-engine.mjs";
import { calculateBoundaryCorrectionChallengers, BOUNDARY_CORRECTION_HASHES } from "../lib/model-boundary-challengers.mjs";

// Offline only: reads existing seeds/snapshots. An output path is opt-in; archives are never written.
const rootArg = process.argv.find((a) => a.startsWith("--archive-root="));
const root = rootArg ? rootArg.slice("--archive-root=".length) : process.cwd();
const dates = fs.readdirSync(path.join(root, "data/analysis/market-seeds")).filter((f) => f.endsWith(".json")).sort();
const report = { kind: "descriptive-boundary-correction-replay", certifiedPerformance: false, formulaHashes: BOUNDARY_CORRECTION_HASHES, dates: [] };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of dates) {
  const seedPath = path.join(root, "data/analysis/market-seeds", file), snapshotPath = path.join(root, "data/history", file);
  const seedBytes = fs.readFileSync(seedPath), snapshotBytes = fs.readFileSync(snapshotPath);
  const seed = JSON.parse(seedBytes), snapshot = JSON.parse(snapshotBytes);
  const old = new Map(snapshot.records.map((record) => [record.code, record]));
  const summary = { date: file.slice(0,-5), commonEligibleCount: 0, legacyScoresChecked: 0, legacyMismatches: [], changesVsExistingVersion: { "A-v3_vs_A-v2": 0, "C-v2_vs_C-v1": 0, "D-v2_vs_D-v1": 0 }, changedAFromV1: 0, candidateIneligible: [], sourceHashes: { seed: sha(seedBytes), snapshot: sha(snapshotBytes) } };
  for (const record of seed.records) {
    const previous = old.get(record.code);
    if (!record.rows?.length || previous?.qualityEligibility?.eligible === false || !["modelA","modelB","modelC","modelD"].every((m)=>Number.isFinite(previous?.scores[m]))) continue;
    summary.commonEligibleCount += 1;
    const rows = record.rows.map(([basDt,mkp,hipr,lopr,clpr,trqu],i)=>({ basDt,mkp,hipr,lopr,clpr,trqu,fltRt:i+1<record.rows.length?Number((((clpr-record.rows[i+1][4])/record.rows[i+1][4])*100).toFixed(2)):0 }));
    const replay = calculateSnapshotModels(rows);
    const values = { modelA: replay.modelA.finalTechnicalScore, modelB: replay.modelB.trendStrength, modelC: replay.modelC.entryStrength, modelD: replay.modelD };
    for (const [model, score] of Object.entries(values)) { summary.legacyScoresChecked += 1; if (score !== previous.scores[model]) summary.legacyMismatches.push({code:record.code,model,old:previous.scores[model],replay:score}); }
    const corrected = calculateBoundaryCorrectionChallengers({ priceHistory: rows, qualityEligibility: previous.qualityEligibility });
    for (const candidate of Object.values(corrected)) if (candidate.eligible && (!Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 100)) throw new Error("Candidate outside 0–100");
    for (const [version, reference, label] of [["A-v3",replay.modelAV2.finalScore,"A-v3_vs_A-v2"],["C-v2",values.modelC,"C-v2_vs_C-v1"],["D-v2",values.modelD,"D-v2_vs_D-v1"]]) {
      if (!corrected[version].eligible) summary.candidateIneligible.push({code:record.code,version,reasons:corrected[version].exclusionReasons});
      else if (corrected[version].score !== reference) summary.changesVsExistingVersion[label] += 1;
    }
    if (corrected["A-v3"].eligible && corrected["A-v3"].score !== values.modelA) summary.changedAFromV1 += 1;
  }
  if (sha(fs.readFileSync(seedPath)) !== summary.sourceHashes.seed || sha(fs.readFileSync(snapshotPath)) !== summary.sourceHashes.snapshot) throw new Error("Input archive changed during replay");
  report.dates.push(summary);
}
report.totalLegacyScoresChecked = report.dates.reduce((sum,d)=>sum+d.legacyScoresChecked,0);
report.exactLegacyReplay = report.dates.every((d)=>d.legacyMismatches.length===0);
console.log(JSON.stringify(report,null,2));
if (!report.exactLegacyReplay || report.dates.some((d)=>d.candidateIneligible.length)) process.exitCode = 1;
