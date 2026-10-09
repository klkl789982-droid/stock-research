import { createHash, randomUUID } from "node:crypto";
import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";

const PREFIX = "evidence/kis-eod-private-slot-observation";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failure = (code) => Object.assign(new Error(code), { code });
const bodyHash = ({ artifactHash: omitted, ...body }) => { void omitted; return sha256Canonical(body); };
const validDate = (date) => /^\d{4}-\d{2}-\d{2}$/u.test(date ?? "") && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
const validSlot = (slot) => ["15:40", "16:10", "16:40"].includes(slot);

export function assertPrivateKisEodPayload(value) {
  const visit = (entry, depth = 0) => {
    if (depth > 24) throw failure("PRIVATE_STORE_PAYLOAD_INVALID");
    if (typeof entry === "string" && /(?:https?:\/\/|\bBearer\s|\bgh[pousr]_[A-Za-z0-9]|github_pat_)/iu.test(entry)) throw failure("PRIVATE_STORE_SECRET_REJECTED");
    if (entry && typeof entry === "object") for (const [key, child] of Object.entries(entry)) {
      if (/(?:app_?key|app_?secret|token|authorization|credential|password|api_?key|headers|url)$/iu.test(key)) throw failure("PRIVATE_STORE_SECRET_REJECTED");
      visit(child, depth + 1);
    }
  };
  visit(value);
}

// A dedicated private repository is required. This adapter exposes neither an
// update/delete method nor the credential/response body in an error or log.
export function createKisEodPrivateStore({ repository, token, branch = "main", fetchImpl = fetch,
  now = () => new Date(), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") || repository.toLowerCase() === "klkl789982-droid/stock-research"
    || typeof token !== "string" || !token.trim() || !/^[A-Za-z0-9_.-]+$/u.test(branch)) throw failure("PRIVATE_STORE_NOT_CONFIGURED");
  const base = `https://api.github.com/repos/${repository}`;
  let verified = false;
  const checkedKey = (key) => {
    if (!/^[A-Za-z0-9_./:-]+[.]json$/u.test(key ?? "") || key.includes("..") || key.startsWith("/") || key.length > 240) throw failure("PRIVATE_STORE_PATH_INVALID");
    return `${PREFIX}/${key}`.split("/").map(encodeURIComponent).join("/");
  };
  const validatePayload = (value) => {
    assertPrivateKisEodPayload(value);
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > 900_000) throw failure("PRIVATE_STORE_PAYLOAD_TOO_LARGE");
    return bytes;
  };
  async function request(method, suffix, body = null) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(`${base}${suffix}`, { method, redirect: "error", signal: AbortSignal.timeout(15_000), cache: "no-store",
          headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "tight-budget-private-observation", ...(body ? { "Content-Type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch {
        if (attempt === 3) throw failure("PRIVATE_STORE_NETWORK_FAILED");
        await wait(attempt * 750); continue;
      }
      const retryable = response.status === 429 || response.status >= 500 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
      if (retryable && attempt < 3) { await response.body?.cancel(); await wait(attempt * 750); continue; }
      if ([200, 201, 404, 409, 422].includes(response.status)) {
        let json = null;
        if (response.status === 200 || response.status === 201) try { json = await response.json(); } catch { throw failure("PRIVATE_STORE_RESPONSE_INVALID"); }
        else await response.body?.cancel();
        return { status: response.status, json };
      }
      await response.body?.cancel();
      throw failure(response.status === 401 || response.status === 403 ? "PRIVATE_STORE_AUTHORIZATION_FAILED" : retryable ? "PRIVATE_STORE_RETRY_EXHAUSTED" : "PRIVATE_STORE_REQUEST_FAILED");
    }
    throw failure("PRIVATE_STORE_RETRY_EXHAUSTED");
  }
  async function verifyPrivateRepository() {
    const result = await request("GET", "");
    if (result.status !== 200 || result.json?.private !== true || result.json.full_name?.toLowerCase() !== repository.toLowerCase()
      || result.json.fork === true || result.json.archived === true || result.json.disabled === true || result.json.has_pages === true) throw failure("PRIVATE_STORE_REPOSITORY_NOT_PRIVATE");
    verified = true;
    return { status: "PRIVATE_REPOSITORY_VERIFIED", sourcePricesPublished: false };
  }
  async function read(key) {
    if (!verified) await verifyPrivateRepository();
    const result = await request("GET", `/contents/${checkedKey(key)}?ref=${encodeURIComponent(branch)}`);
    if (result.status === 404) return null;
    if (result.status !== 200 || result.json?.type !== "file" || result.json.encoding !== "base64" || typeof result.json.content !== "string"
      || !Number.isSafeInteger(result.json.size) || result.json.size > 900_000) throw failure("PRIVATE_STORE_RESPONSE_INVALID");
    const bytes = Buffer.from(result.json.content.replaceAll("\n", ""), "base64");
    if (bytes.length !== result.json.size) throw failure("PRIVATE_STORE_RESPONSE_INVALID");
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw failure("PRIVATE_STORE_RESPONSE_INVALID"); }
    validatePayload(value);
    return { value, contentHash: hash(bytes), bytes: bytes.toString("utf8") };
  }
  async function writeImmutable(key, value) {
    // Recheck visibility immediately before every private write, not only once
    // at job startup. Administrators remain a separate trust boundary.
    await verifyPrivateRepository();
    const bytes = validatePayload(value), contentHash = hash(bytes), existing = await read(key);
    if (existing) {
      if (existing.contentHash !== contentHash) throw failure("PRIVATE_STORE_IMMUTABLE_CONFLICT");
      return { status: "ALREADY_STORED", contentHash };
    }
    await verifyPrivateRepository();
    const result = await request("PUT", `/contents/${checkedKey(key)}`, { message: "chore: preserve private observation evidence", branch, content: Buffer.from(bytes).toString("base64") });
    // No `sha` is provided: GitHub must create, never replace a prior file.
    if (![201, 409, 422].includes(result.status)) throw failure("PRIVATE_STORE_CREATE_FAILED");
    const stored = await read(key);
    if (!stored || stored.contentHash !== contentHash) throw failure(stored ? "PRIVATE_STORE_IMMUTABLE_CONFLICT" : "PRIVATE_STORE_READBACK_FAILED");
    return { status: result.status === 201 ? "STORED_AND_VERIFIED" : "ALREADY_STORED", contentHash };
  }
  async function preflight() {
    await verifyPrivateRepository();
    const probeId = randomUUID(), key = `preflight/${probeId}.json`;
    const probe = { schemaVersion: 1, namespace: "kis-eod-private-storage-preflight", probeId, checkedAt: new Date(now()).toISOString(),
      payload: "NO_PRICES_NO_CREDENTIALS", publicationEligible: false };
    // A fresh price-free object proves current write permission. A read-only
    // token cannot pass by reading an old successful probe.
    const written = await writeImmutable(key, probe);
    const reread = await read(key);
    if (reread?.contentHash !== written.contentHash) throw failure("PRIVATE_STORE_READBACK_FAILED");
    return { status: "PRIVATE_WRITE_READ_HASH_VERIFIED", contentHash: written.contentHash, sourcePricesIncluded: false };
  }
  // Bounded directory inventory only; no update/delete or download URLs exposed.
  // Used by the append-only model-head journal, not a mutable latest.json file.
  async function listKeys(folder) {
    if (!verified) await verifyPrivateRepository();
    const encoded = checkedKey(`${folder}/index.json`).replace(/index[.]json$/u, "");
    const result = await request("GET", `/contents/${encoded}?ref=${encodeURIComponent(branch)}`);
    if (result.status === 404) return [];
    if (result.status !== 200 || !Array.isArray(result.json) || result.json.length >= 1000) throw failure("PRIVATE_STORE_INVENTORY_INVALID");
    return result.json.map((entry) => {
      if (!["file", "dir"].includes(entry.type) || !/^[A-Za-z0-9_.-]+$/u.test(entry.name ?? "") || entry.name.includes("..")) throw failure("PRIVATE_STORE_INVENTORY_INVALID");
      return { name: entry.name, type: entry.type };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  const slotKey = (date, slot) => {
    if (!validDate(date) || !validSlot(slot)) throw failure("PRIVATE_STORE_PATH_INVALID");
    return `${date}/${slot.replace(":", "")}`;
  };
  async function readCompleted(date, slot) {
    const key = slotKey(date, slot), completed = await read(`completed/${key}.json`);
    if (!completed) return null;
    const marker = completed.value;
    if (!/^[0-9TZ.-]+-[a-f0-9]{64}[.]json$/u.test(marker.artifactFile ?? "") || !/^[a-f0-9]{64}$/u.test(marker.artifactHash ?? "")) throw failure("PRIVATE_STORE_HASH_MISMATCH");
    const stored = await read(`journal/${key}/${marker.artifactFile}`), artifact = stored?.value;
    if (!artifact || artifact.status !== "OBSERVED" || artifact.referenceDate !== date || artifact.slot !== slot
      || artifact.artifactHash !== marker.artifactHash || bodyHash(artifact) !== marker.artifactHash) throw failure("PRIVATE_STORE_HASH_MISMATCH");
    return { artifact, marker };
  }
  async function claim(date, slot, ownerId) {
    const key = `claims/${slotKey(date, slot)}.json`, existing = await read(key);
    if (existing) return existing.value.ownerId === ownerId;
    const value = { namespace: "kis-eod-private-slot-claim", referenceDate: date, slot, ownerId, claimedAt: new Date(now()).toISOString(),
      recovery: "NO_AUTOMATIC_RECLAIM_NO_RETROSPECTIVE_COLLECTION" };
    try { await writeImmutable(key, value); return true; }
    catch (error) { if (error.code === "PRIVATE_STORE_IMMUTABLE_CONFLICT") return false; throw error; }
  }
  async function persistArtifact(artifactFile, artifact) {
    if (artifact.namespace !== "kis-eod-private-slot-observation" || bodyHash(artifact) !== artifact.artifactHash
      || !artifactFile.endsWith(`-${artifact.artifactHash}.json`)) throw failure("PRIVATE_STORE_HASH_MISMATCH");
    const key = slotKey(artifact.referenceDate, artifact.slot);
    const result = await writeImmutable(`journal/${key}/${artifactFile}`, artifact);
    if (artifact.status === "OBSERVED") await writeImmutable(`completed/${key}.json`, { artifactFile, artifactHash: artifact.artifactHash });
    return result;
  }
  async function listJournal(date, slot) {
    if (!verified) await verifyPrivateRepository();
    const key = slotKey(date, slot), folder = checkedKey(`journal/${key}/index.json`).replace(/index[.]json$/u, "");
    const response = await request("GET", `/contents/${folder}?ref=${encodeURIComponent(branch)}`);
    if (response.status === 404) return [];
    if (response.status !== 200 || !Array.isArray(response.json) || response.json.length > 100) throw failure("PRIVATE_STORE_RESPONSE_INVALID");
    const result = [];
    for (const entry of response.json) {
      if (entry.type !== "file" || !/^[0-9TZ.-]+-[a-f0-9]{64}[.]json$/u.test(entry.name ?? "")) throw failure("PRIVATE_STORE_RESPONSE_INVALID");
      const artifact = (await read(`journal/${key}/${entry.name}`))?.value;
      if (!artifact || artifact.namespace !== "kis-eod-private-slot-observation" || artifact.referenceDate !== date || artifact.slot !== slot
        || bodyHash(artifact) !== artifact.artifactHash || !entry.name.endsWith(`-${artifact.artifactHash}.json`)) throw failure("PRIVATE_STORE_HASH_MISMATCH");
      result.push({ artifactFile: entry.name, artifact });
    }
    return result;
  }
  async function persistComparison(report) {
    if (report.namespace !== "kis-eod-private-official-comparison") throw failure("PRIVATE_STORE_PAYLOAD_INVALID");
    const { comparisonHash: omitted, comparedAt: omittedTime, ...body } = report;
    void omitted; void omittedTime;
    if (sha256Canonical(body) !== report.comparisonHash) throw failure("PRIVATE_STORE_HASH_MISMATCH");
    const key = `comparisons/${slotKey(report.referenceDate, report.slot)}/${report.comparisonHash}.json`;
    const existing = await read(key);
    if (existing) {
      const { comparisonHash, comparedAt, ...prior } = existing.value;
      void comparedAt;
      if (comparisonHash !== report.comparisonHash || sha256Canonical(prior) !== report.comparisonHash) throw failure("PRIVATE_STORE_HASH_MISMATCH");
      return { status: "ALREADY_STORED", contentHash: existing.contentHash };
    }
    return writeImmutable(key, report);
  }
  async function recordOutcome(result, runId) {
    if (!validDate(result.referenceDate) || !validSlot(result.slot) || !/^[a-f0-9-]{36}$/u.test(runId)) throw failure("PRIVATE_STORE_PATH_INVALID");
    const value = { namespace: "kis-eod-private-operational-outcome", ...result, runId };
    return writeImmutable(`operations/${slotKey(result.referenceDate, result.slot)}/${runId}.json`, value);
  }
  async function auditDay(date, calendar, checkedAt = new Date(now()).toISOString()) {
    if (!validDate(date) || new Date(checkedAt).getTime() < Date.parse(`${date}T16:45:00+09:00`)) throw failure("PRIVATE_STORE_AUDIT_TOO_EARLY");
    const fields = calendar?.sourceFields;
    const verifiedCalendar = calendar?.source === "KIS" && calendar.operation === "chk-holiday" && calendar.referenceDate === date
      && fields?.bass_dt === date.replaceAll("-", "") && ["Y", "N"].includes(fields.opnd_yn) && ["Y", "N"].includes(fields.tr_day_yn)
      && Number.isFinite(Date.parse(calendar.receivedAt)) && Date.parse(calendar.receivedAt) <= Date.parse(checkedAt);
    const tradingDay = verifiedCalendar && fields.opnd_yn === "Y" && fields.tr_day_yn === "Y" && calendar.isTradingDay === true;
    const closed = verifiedCalendar && fields.opnd_yn === "N" && fields.tr_day_yn === "N" && calendar.isTradingDay === false;
    const slots = [];
    for (const slot of ["15:40", "16:10", "16:40"]) {
      const completed = await readCompleted(date, slot), reserved = await read(`claims/${slotKey(date, slot)}.json`);
      slots.push({ slot, status: completed ? "OBSERVED" : closed ? "MARKET_CLOSED" : !tradingDay ? "CALENDAR_UNKNOWN"
        : reserved ? "CLAIMED_NOT_COMPLETED" : "SCHEDULE_OR_RUNNER_MISSING", artifactHash: completed?.artifact.artifactHash ?? null });
    }
    const calendarEvidence = verifiedCalendar ? { source: "KIS", operation: "chk-holiday", referenceDate: date, receivedAt: calendar.receivedAt,
      isTradingDay: tradingDay ? true : closed ? false : null,
      sourceFields: { bass_dt: fields.bass_dt, opnd_yn: fields.opnd_yn, tr_day_yn: fields.tr_day_yn } } : null;
    const report = { namespace: "kis-eod-private-retention-audit", referenceDate: date, checkedAt, calendarEvidence, slots,
      sourceFinality: "NOT_CONFIRMED", publicationEligible: false, productionChanged: false };
    const reportHash = sha256Canonical(report);
    await writeImmutable(`reconciliation/${date}/${reportHash}.json`, report);
    return { referenceDate: date, missingCount: slots.filter((entry) => ["CLAIMED_NOT_COMPLETED", "SCHEDULE_OR_RUNNER_MISSING"].includes(entry.status)).length,
      unknownCount: slots.filter((entry) => entry.status === "CALENDAR_UNKNOWN").length, observedCount: slots.filter((entry) => entry.status === "OBSERVED").length, reportHash };
  }
  return { verifyPrivateRepository, preflight, read, writeImmutable, listKeys, readCompleted, claim, persistArtifact, listJournal, persistComparison, recordOutcome,
    readCalendar: async (date) => { if (!validDate(date)) throw failure("PRIVATE_STORE_PATH_INVALID"); return (await read(`calendar/${date}.json`))?.value ?? null; },
    persistCalendar: (date, value) => { if (!validDate(date)) throw failure("PRIVATE_STORE_PATH_INVALID"); return writeImmutable(`calendar/${date}.json`, value); },
    auditDay, createRunId: randomUUID };
}

export function kisEodPrivateStoreFromEnv(env = process.env, options = {}) {
  return createKisEodPrivateStore({ ...options, repository: env.KIS_OBSERVATION_STORE_REPOSITORY,
    token: env.KIS_OBSERVATION_STORE_TOKEN, branch: env.KIS_OBSERVATION_STORE_BRANCH ?? "main" });
}
