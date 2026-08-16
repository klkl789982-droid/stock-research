import fs from "node:fs/promises";
import path from "node:path";

const REQUIRED_FIELDS = [
  "modelId",
  "version",
  "status",
  "formulaDescription",
  "hypothesis",
  "expectedBenefit",
  "knownRisk",
  "evaluationMetrics",
  "changeReason",
  "changedFrom",
  "validationStartDate",
  "validationEndDate",
  "notes",
];

export function modelVersionId(model) {
  return `${model.modelId}-${model.version}`;
}

export async function loadModelRegistry(root = process.cwd()) {
  const registryPath = path.join(root, "data", "model-registry.json");
  return JSON.parse(await fs.readFile(registryPath, "utf8"));
}

export function validateModelProposal(proposal, registry) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (!(field in proposal)) errors.push(`필수 필드 누락: ${field}`);
  }
  for (const field of ["formulaDescription", "hypothesis", "expectedBenefit", "knownRisk", "changeReason"]) {
    if (typeof proposal[field] !== "string" || proposal[field].trim() === "") {
      errors.push(`${field}는 비어 있지 않은 문자열이어야 합니다.`);
    }
  }
  if (!Array.isArray(proposal.evaluationMetrics) || proposal.evaluationMetrics.length === 0) {
    errors.push("evaluationMetrics는 한 개 이상 필요합니다.");
  }
  const id = modelVersionId(proposal);
  if (registry.models.some((model) => model.modelVersion === id)) {
    errors.push(`${id}는 이미 존재하며 덮어쓸 수 없습니다.`);
  }
  if (proposal.changedFrom && !registry.models.some((model) => model.modelVersion === proposal.changedFrom)) {
    errors.push(`changedFrom 버전을 찾을 수 없습니다: ${proposal.changedFrom}`);
  }
  return errors;
}

export async function registerModelVersion(proposal, root = process.cwd()) {
  const registry = await loadModelRegistry(root);
  const errors = validateModelProposal(proposal, registry);
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const entry = {
    ...proposal,
    modelVersion: modelVersionId(proposal),
    createdAt: new Date().toISOString(),
  };
  const nextRegistry = {
    ...registry,
    updatedAt: entry.createdAt,
    models: [...registry.models, entry],
  };
  const registryPath = path.join(root, "data", "model-registry.json");
  const temporaryPath = `${registryPath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextRegistry, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, registryPath);
  return entry;
}
