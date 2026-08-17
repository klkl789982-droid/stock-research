import fs from "node:fs/promises";
import path from "node:path";
import {
  immutableSnapshotView,
  prepareMarketPriceLedgers,
  prepareSnapshots,
  resolveFutureReturns,
  serializableSnapshot,
} from "../lib/future-return-resolver.mjs";
import { loadTradingCalendar, validateTradingCalendar } from "../lib/trading-calendar-status.mjs";
import { resolveExecutionReturns } from "../lib/execution-return-resolver.mjs";

const historyDirectory = path.join(process.cwd(), "data", "history");
const marketPriceDirectory = path.join(process.cwd(), "data", "market-prices");
await fs.mkdir(historyDirectory, { recursive: true });
await fs.mkdir(marketPriceDirectory, { recursive: true });
const filenames = (await fs.readdir(historyDirectory))
  .filter((filename) => /^\d{4}-\d{2}-\d{2}\.json$/.test(filename))
  .sort();

const rawSnapshots = await Promise.all(
  filenames.map(async (filename) =>
    JSON.parse(await fs.readFile(path.join(historyDirectory, filename), "utf8")),
  ),
);
const ledgerFilenames = (await fs.readdir(marketPriceDirectory))
  .filter((filename) => /^\d{4}-\d{2}-\d{2}\.json$/.test(filename))
  .sort();
const rawLedgers = await Promise.all(
  ledgerFilenames.map(async (filename) =>
    JSON.parse(await fs.readFile(path.join(marketPriceDirectory, filename), "utf8")),
  ),
);
for (let index = 0; index < rawLedgers.length; index += 1) {
  if (rawLedgers[index].date !== ledgerFilenames[index].replace(".json", "")) {
    throw new Error(`${ledgerFilenames[index]}의 파일명과 가격 원장 날짜가 일치하지 않습니다.`);
  }
}

for (let index = 0; index < rawSnapshots.length; index += 1) {
  if (rawSnapshots[index].asOfDate !== filenames[index].replace(".json", "")) {
    throw new Error(`${filenames[index]}의 파일명과 asOfDate가 일치하지 않습니다.`);
  }
}

const snapshots = prepareSnapshots(rawSnapshots);
const marketPriceLedgers = prepareMarketPriceLedgers(rawLedgers);
const tradingCalendar = await loadTradingCalendar();
const calendarErrors = validateTradingCalendar(tradingCalendar);
if (calendarErrors.length > 0) throw new Error(calendarErrors.join("\n"));
const immutableBefore = new Map(
  snapshots.map((snapshot) => [
    snapshot.asOfDate,
    JSON.stringify(immutableSnapshotView(serializableSnapshot(snapshot))),
  ]),
);
const result = resolveFutureReturns(snapshots, marketPriceLedgers, tradingCalendar);
const executionResult = resolveExecutionReturns(result.snapshots, marketPriceLedgers, tradingCalendar);
result.snapshots = executionResult.snapshots;
result.changedDates = [...new Set([...result.changedDates, ...executionResult.changedDates])].sort();
result.statistics.executionPolicy = { policyId: "public-eod-t2-open-v1", changedDates: executionResult.changedDates };

for (const date of result.changedDates) {
  const snapshot = result.snapshots.find((item) => item.asOfDate === date);
  const serializable = serializableSnapshot(snapshot);
  const immutableAfter = JSON.stringify(immutableSnapshotView(serializable));
  if (immutableBefore.get(date) !== immutableAfter) {
    throw new Error(`${date}: 허용된 수익률 필드 외 원본 데이터가 변경되었습니다.`);
  }

  const outputPath = path.join(historyDirectory, `${date}.json`);
  const temporaryPath = `${outputPath}.resolve-tmp`;
  const backupPath = `${outputPath}.resolve-backup`;
  const lockPath = `${outputPath}.resolve-lock`;

  await fs.writeFile(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(serializable, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.rename(outputPath, backupPath);
    try {
      await fs.rename(temporaryPath, outputPath);
      await fs.rm(backupPath);
    } catch (error) {
      await fs.rename(backupPath, outputPath);
      throw error;
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
    await fs.rm(lockPath, { force: true });
  }
}

console.log(JSON.stringify(result.statistics, null, 2));
if (result.changedDates.length === 0) {
  console.log("보정 가능한 미래 거래일 스냅샷이 아직 없습니다.");
} else {
  console.log(`보정 완료 스냅샷: ${result.changedDates.join(", ")}`);
}
