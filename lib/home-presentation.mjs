// Presentation only. Never changes a reference date, score or outcome contract.
export function homeDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return "확인 불가";
  const n = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value ? value.replaceAll("-", ".") : "확인 불가";
}
export function homeTime(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "확인 불가";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value)).map(x => [x.type, x.value]));
  return `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute}:${p.second} KST`;
}

// A site/repository identity mismatch is not proof that a deployment is running.
// Presentation only: keep the API state, strict identity guard and failure flags.
export function homeDeploymentLabel(deployment) {
  if (deployment?.state === "DEPLOYING") {
    return deployment.reason === "VERCEL_DEPLOYMENT_PENDING" ? "배포 진행 중"
      : deployment.reason === "SITE_COMMIT_DIFFERS_REPOSITORY" ? "현재 화면 버전 미확인" : "데이터 반영 미확인";
  }
  if (deployment?.state === "VERIFIED") return "실제 사이트 확인 완료";
  if (deployment?.state === "DEPLOYMENT_FAILED") return "배포 실패";
  if (deployment?.state === "VERIFICATION_FAILED") return "사이트 확인 실패";
  if (deployment?.reason === "GITHUB_EVIDENCE_EXPIRED") return "사이트 확인 기록 오래됨";
  if (deployment?.reason === "CURRENT_PAGE_LOADING") return "현재 화면 확인 중";
  return "사이트 확인 불가";
}
