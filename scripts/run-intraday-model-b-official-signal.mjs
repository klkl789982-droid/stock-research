import fs from "node:fs/promises";
import path from "node:path";
import { createKisApiClient } from "../lib/kis-api-client-core.mjs";
import { createKisTokenManager } from "../lib/kis-token-manager-core.mjs";
import { parseKisQuote } from "../lib/kis-quote-provider-core.mjs";
import { collectKisQuotes } from "../lib/kis-intraday-collector.mjs";
import { assertImmutableOfficialSignal, buildIntradayModelBSignal } from "../lib/intraday-model-b-official-signal.mjs";

const root = process.cwd();
const main = async () => {
const kst = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
const format = (parts) => `${parts.year}-${parts.month}-${parts.day}`;
const signalDate = process.argv.find((value) => value.startsWith("--signal-date="))?.slice(14) ?? format(kst());
const allowAnyTime = process.argv.includes("--allow-any-time");
const parts = kst(); const time = `${parts.hour}:${parts.minute}:${parts.second}`;
if (!allowAnyTime && (time < "14:30:00" || time > "14:35:00")) throw new Error("OFFICIAL_SIGNAL_OUTSIDE_COLLECTION_WINDOW");
const credentials = { appKey: process.env.KIS_APP_KEY ?? "", appSecret: process.env.KIS_APP_SECRET ?? "" };
if (!credentials.appKey || !credentials.appSecret) throw new Error("KIS_CREDENTIALS_MISSING");
const seedDir = path.join(root, "data", "analysis", "market-seeds");
const seedNames = (await fs.readdir(seedDir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort().reverse();
if (!seedNames[0]) throw new Error("INTRADAY_SEED_MISSING");
const seed = JSON.parse(await fs.readFile(path.join(seedDir, seedNames[0]), "utf8"));
const tokenManager = createKisTokenManager({ fetchImpl: fetch, getCredentials: () => credentials });
const client = createKisApiClient({ fetchImpl: fetch, tokenManager, getCredentials: () => credentials });
const fetchQuote = async (code) => { const response = await client.request(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`, { headers: { "Content-Type": "application/json", tr_id: "FHKST01010100" } }); if (!response.ok) throw new Error(`KIS_HTTP_${response.status}`); return parseKisQuote(await response.json(), code, new Date().toISOString()); };
const eligibleCodes = seed.records.filter((record) => record.eligible).map((record) => record.code);
const collection = await collectKisQuotes({ codes: eligibleCodes, fetchQuote, delayMs: 150 });
const artifact = buildIntradayModelBSignal({ seed, quotesByCode: collection.quotesByCode, signalDate, collectionStartedAt: collection.startedAt, collectionCompletedAt: collection.completedAt });
const statusDir = path.join(root, "data", "intraday-signals", "model-b"); const signalDir = path.join(statusDir, signalDate); await fs.mkdir(signalDir, { recursive: true });
const signalPath = path.join(signalDir, "1430.json"); let existing = null; try { existing = JSON.parse(await fs.readFile(signalPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const disposition = assertImmutableOfficialSignal(existing, artifact);
if (artifact.status !== "READY") throw new Error(`OFFICIAL_SIGNAL_COLLECTION_INCOMPLETE:${artifact.collection.failed}`);
if (disposition === "create") await fs.writeFile(signalPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
const latest = { schemaVersion: 1, artifactType: "intradayModelBLatestStatus", signalDate, officialSignalTime: "14:30:00", status: artifact.status, signalPath: path.relative(root, signalPath).replaceAll("\\", "/"), contentHash: artifact.contentHash, collection: artifact.collection, collectionStartedAt: artifact.collectionStartedAt, collectionCompletedAt: artifact.collectionCompletedAt, updatedAt: new Date().toISOString() };
await fs.writeFile(path.join(statusDir, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
console.log(`INTRADAY_MODEL_B_RESULT_JSON=${JSON.stringify({ status: artifact.status, signalDate, signalPath: latest.signalPath, latestPath: "data/intraday-signals/model-b/latest.json", collection: artifact.collection })}`);
};

await main().catch(async (error) => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const reason = error instanceof Error ? error.message.slice(0, 120) : "unknownFailure";
  const directory = path.join(root, "data", "intraday-signals", "model-b");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "latest.json"), `${JSON.stringify({ schemaVersion: 1, artifactType: "intradayModelBLatestStatus", signalDate: date, officialSignalTime: "14:30:00", status: "FAILED", reason, updatedAt: now.toISOString() }, null, 2)}\n`);
  console.error(`INTRADAY_MODEL_B_FAILED reason=${reason}`);
  console.log(`INTRADAY_MODEL_B_RESULT_JSON=${JSON.stringify({ status: "FAILED", signalDate: date, latestPath: "data/intraday-signals/model-b/latest.json", reason })}`);
  process.exitCode = 1;
});
