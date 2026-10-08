export const SCREENING_MODELS = Object.freeze({
  "A-v1": { scorePath: ["scoresByVersion", "A-v1"], rankPath: ["ranksByVersion", "A-v1"] },
  "B-v1": { scorePath: ["scores", "modelB"], rankPath: ["ranks", "modelB"] },
  "C-v1": { scorePath: ["scores", "modelC"], rankPath: ["ranks", "modelC"] },
  "D-v1": { scorePath: ["scores", "modelD"], rankPath: ["ranks", "modelD"] },
});

const readPath = (value, path) => path.reduce((current, key) => current?.[key], value);
const finiteOrNull = (value) => Number.isFinite(value) ? Number(value) : null;

export function createScreeningRows(snapshot, companySnapshot) {
  const companyByCode = new Map((companySnapshot?.records ?? []).map((record) => [record.code, record]));
  return (snapshot.records ?? []).map((record) => {
    const company = companyByCode.get(record.code);
    const models = Object.fromEntries(Object.entries(SCREENING_MODELS).map(([model, paths]) => [model, {
      score: finiteOrNull(readPath(record, paths.scorePath)),
      rank: Number.isInteger(readPath(record, paths.rankPath)) ? Number(readPath(record, paths.rankPath)) : null,
    }]));
    return {
      code: record.code,
      name: record.name,
      market: record.market,
      referenceDate: snapshot.asOfDate,
      qualityEligible: record.qualityEligibility?.eligible === true,
      models,
      company: company ? {
        available: company.eligible === true && Number.isFinite(company.totalScore),
        score: finiteOrNull(company.totalScore),
        grade: typeof company.grade === "string" ? company.grade : null,
        referenceDate: companySnapshot.requestedDate ?? null,
        reason: company.eligible === true ? null : "analysisUnavailable",
      } : { available: false, score: null, grade: null, referenceDate: companySnapshot?.requestedDate ?? null, reason: "recordMissing" },
    };
  });
}

export function screenStocks(rows, filters = {}) {
  const model = SCREENING_MODELS[filters.model] ? filters.model : "A-v1";
  const minScore = finiteOrNull(filters.minScore);
  const maxScore = finiteOrNull(filters.maxScore);
  const maxRank = finiteOrNull(filters.maxRank);
  const companyGrade = typeof filters.companyGrade === "string" && filters.companyGrade ? filters.companyGrade : null;
  const missingModel = rows.filter((row) => row.models[model].score === null || row.models[model].rank === null).length;
  const missingCompany = companyGrade ? rows.filter((row) => !row.company.available || !row.company.grade).length : 0;
  const results = rows.filter((row) => {
    const selected = row.models[model];
    if (selected.score === null || selected.rank === null) return false;
    if (minScore !== null && selected.score < minScore) return false;
    if (maxScore !== null && selected.score > maxScore) return false;
    if (maxRank !== null && selected.rank > maxRank) return false;
    if (companyGrade) {
      if (!row.company.available || !row.company.grade) return false;
      if (row.company.grade !== companyGrade) return false;
    }
    return true;
  }).map((row) => ({ ...row, selectedModel: model, score: row.models[model].score, rank: row.models[model].rank }));

  const sort = ["rank", "score", "name", "companyScore"].includes(filters.sort) ? filters.sort : "rank";
  const direction = filters.direction === "desc" ? "desc" : "asc";
  results.sort((left, right) => {
    let comparison;
    if (sort === "name") comparison = left.name.localeCompare(right.name, "ko");
    else if (sort === "companyScore") {
      if (left.company.score === null && right.company.score === null) comparison = 0;
      else if (left.company.score === null) comparison = 1;
      else if (right.company.score === null) comparison = -1;
      else comparison = left.company.score - right.company.score;
    } else comparison = Number(left[sort]) - Number(right[sort]);
    return (direction === "desc" ? -comparison : comparison) || left.code.localeCompare(right.code);
  });
  return { results, exclusions: { missingModel, missingCompany } };
}
