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
