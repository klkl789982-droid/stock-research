import { collectValidationReadiness, loadValidationConfig, validatePeriodOrder } from "../lib/validation-protocol.mjs";

const { periods } = await loadValidationConfig();
const periodErrors = validatePeriodOrder(periods);
if (periodErrors.length > 0) throw new Error(periodErrors.join("\n"));
const readiness = await collectValidationReadiness();
console.log(JSON.stringify(readiness, null, 2));
if (readiness.warnings.length > 0) console.warn("검증 최소 조건이 아직 충족되지 않았습니다. 현재 규칙은 경고 전용입니다.");
