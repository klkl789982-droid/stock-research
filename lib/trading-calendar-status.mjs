import fs from "node:fs/promises";
import path from "node:path";

export const TRADING_CALENDAR_SCHEMA_VERSION = 1;
export const DATE_STATUSES = ["tradingDay", "marketClosed", "collectionFailed", "unchecked"];
export const ARTIFACT_STATUSES = ["created", "missing", "failed", "notRequired"];

export function isWeekend(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function compactDate(date) {
  return typeof date === "string" ? date.replaceAll("-", "") : "";
}

function isoDate(compact) {
  return /^\d{8}$/.test(compact) ? `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}` : null;
}

function nextDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

export function deriveMarketClosedDatesFromOfficialEodHistory({ marketSeed, referenceDate }) {
  const populatedRecords = (marketSeed?.records ?? []).filter((record) => Array.isArray(record?.rows) && record.rows.length > 0);
  if (populatedRecords.length === 0 || marketSeed?.requestedDate !== referenceDate) return {};

  const counts = new Map();
  for (const record of populatedRecords) {
    const dates = new Set(record.rows.map((row) => compactDate(row?.basDt ?? row?.[0])).filter((date) => /^\d{8}$/.test(date)));
    for (const date of dates) counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const completeDates = [...counts.entries()]
    .filter(([, count]) => count === populatedRecords.length)
    .map(([date]) => date)
    .sort();
  const referenceCompact = compactDate(referenceDate);
  if (!completeDates.includes(referenceCompact)) return {};
  const previousCompact = completeDates.filter((date) => date < referenceCompact).at(-1);
  const previousDate = isoDate(previousCompact);
  if (!previousDate) return {};

  const entries = {};
  for (let date = nextDate(previousDate); date < referenceDate; date = nextDate(date)) {
    if (isWeekend(date) || completeDates.includes(compactDate(date))) continue;
    entries[date] = {
      status: "marketClosed",
      observedBasDt: null,
      modelSnapshot: "notRequired",
      marketPriceLedger: "notRequired",
      reason: "absentBetweenCompleteOfficialEodTradingDates",
      evidence: "completeOfficialEodHistoryGap",
      evidenceReferenceDate: referenceDate,
      evidenceRecordCount: populatedRecords.length,
    };
  }
  return entries;
}

export function classifyRequestedDate({ requestedDate, observedBasDt = null, error = null }) {
  if (isWeekend(requestedDate)) {
    return { status: "marketClosed", observedBasDt, reason: "weekend" };
  }
  if (error) return { status: "collectionFailed", observedBasDt, reason: error };
  if (!observedBasDt) return { status: "collectionFailed", observedBasDt: null, reason: "emptyResponse" };
  if (observedBasDt === requestedDate) return { status: "tradingDay", observedBasDt, reason: null };
  if (observedBasDt < requestedDate) {
    return { status: "unchecked", observedBasDt, reason: "weekdayBasDtMismatch" };
  }
  return { status: "collectionFailed", observedBasDt, reason: "futureBasDtResponse" };
}

export async function loadTradingCalendar(root = process.cwd()) {
  const calendarPath = path.join(root, "data", "trading-calendar", "status.json");
  try {
    return JSON.parse(await fs.readFile(calendarPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: TRADING_CALENDAR_SCHEMA_VERSION, dates: {} };
    throw error;
  }
}

export function validateTradingCalendar(calendar) {
  const errors = [];
  if (calendar.schemaVersion !== TRADING_CALENDAR_SCHEMA_VERSION) errors.push("거래일 상태 원장 schemaVersion이 올바르지 않습니다.");
  for (const [date, entry] of Object.entries(calendar.dates ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push(`날짜 형식 오류: ${date}`);
    if (!DATE_STATUSES.includes(entry.status)) errors.push(`${date} 날짜 상태 오류: ${entry.status}`);
    if (!ARTIFACT_STATUSES.includes(entry.modelSnapshot)) errors.push(`${date} 모델 스냅샷 상태 오류`);
    if (!ARTIFACT_STATUSES.includes(entry.marketPriceLedger)) errors.push(`${date} 가격 원장 상태 오류`);
  }
  return errors;
}

function comparableEntry(entry) {
  const copy = { ...entry };
  delete copy.checkedAt;
  return copy;
}

export async function updateTradingCalendarDate(date, nextEntry, root = process.cwd()) {
  const directory = path.join(root, "data", "trading-calendar");
  await fs.mkdir(directory, { recursive: true });
  const calendarPath = path.join(directory, "status.json");
  const lockPath = `${calendarPath}.lock`;
  const temporaryPath = `${calendarPath}.tmp`;
  const backupPath = `${calendarPath}.backup`;
  await fs.writeFile(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  try {
    const calendar = await loadTradingCalendar(root);
    const previous = calendar.dates?.[date];
    const unchanged = previous && JSON.stringify(comparableEntry(previous)) === JSON.stringify(comparableEntry(nextEntry));
    if (unchanged) return { calendar, changed: false, entry: previous };
    const entry = { ...nextEntry, checkedAt: new Date().toISOString() };
    const updated = { ...calendar, dates: { ...calendar.dates, [date]: entry } };
    const errors = validateTradingCalendar(updated);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    await fs.writeFile(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    let hadOriginal = false;
    try {
      await fs.rename(calendarPath, backupPath);
      hadOriginal = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(temporaryPath, calendarPath);
      if (hadOriginal) await fs.rm(backupPath);
    } catch (error) {
      if (hadOriginal) await fs.rename(backupPath, calendarPath);
      throw error;
    }
    return { calendar: updated, changed: true, entry };
  } finally {
    await fs.rm(temporaryPath, { force: true });
    await fs.rm(lockPath, { force: true });
  }
}
