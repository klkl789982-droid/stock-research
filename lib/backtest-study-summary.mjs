import { hashObject } from "./rank-backtest-engine.mjs";

/** A fixed projection of the previously run study. No selections or returns are recalculated here. */
export function summarizeFrozenStudy(study, plan) {
  if (study.protocolHash !== hashObject(plan) || study.study !== plan.studyId || study.promotion !== "DISABLED") {
    throw new Error("Frozen study and protocol differ");
  }
  const candidates = [];
  for (const candidate of plan.candidates) {
    const holdingDays = plan.primaryHoldingDays[candidate.changedFrom];
    const cohorts = study.cohorts.filter(c => c.split === "chronologicalCheck" && c.model === candidate.changedFrom && c.days === holdingDays);
    for (const cohort of cohorts) {
      const version = candidate.modelId + "-" + candidate.version;
      const challenger = cohort.strategies[version], baseline = cohort.strategies[candidate.changedFrom];
      if (!challenger || !baseline) continue;
      const stats = group => ({ dates: group.completeDates, observations: group.matureLegs, mean: group.meanCohortNet,
        excess: group.meanNetMinusOfficialIndex, total: group.account.totalReturn, drawdown: group.account.maxDrawdown, trades: group.account.tradeCount });
      candidates.push({ version, baselineVersion: candidate.changedFrom, holdingDays, lineage: cohort.lineage,
        pairedDates: challenger.pairedDates, baseline: stats(baseline), candidate: stats(challenger) });
    }
  }
  return { studyId: plan.studyId, protocolHash: study.protocolHash, sourceStudyHash: hashObject(study),
    from: plan.chronologicalCheck[0], to: plan.chronologicalCheck[1], topN: plan.topN,
    unavailablePrimaryVersions: plan.candidates.map(c => c.modelId + "-" + c.version).filter(v => !candidates.some(c => c.version === v)),
    candidates };
}
