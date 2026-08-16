import fs from "node:fs/promises";
import path from "node:path";
import { createExperiment } from "../lib/validation-protocol.mjs";

const specArg = process.argv.find((arg) => arg.startsWith("--spec="));
if (!specArg) throw new Error("사용법: npm run experiment:create -- --spec=config/model-experiment.json");
const specPath = path.resolve(process.cwd(), specArg.split("=").slice(1).join("="));
const specification = JSON.parse(await fs.readFile(specPath, "utf8"));
const experiment = await createExperiment(specification);
console.log(`실험 사전등록 완료: ${experiment.experimentId}`);
for (const warning of experiment.readinessAtCreation.warnings) console.warn(`경고: ${warning}`);
