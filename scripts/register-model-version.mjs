import fs from "node:fs/promises";
import path from "node:path";
import { registerModelVersion } from "../lib/model-registry.mjs";

const proposalArg = process.argv.find((arg) => arg.startsWith("--proposal="));
if (!proposalArg) throw new Error("사용법: npm run model:register -- --proposal=config/model-version-proposal.json");
const proposalPath = path.resolve(process.cwd(), proposalArg.split("=").slice(1).join("="));
const proposal = JSON.parse(await fs.readFile(proposalPath, "utf8"));
const entry = await registerModelVersion(proposal);
console.log(`모델 버전 등록 완료: ${entry.modelVersion}`);
