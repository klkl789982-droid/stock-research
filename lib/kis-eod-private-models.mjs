import { createHash } from "node:crypto";
import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";
import { validateKisEodCandidate, inspectKisEodCollection, KIS_EOD_MODEL_VERSIONS } from "./kis-eod-pipeline.mjs";
import { assertPrivateKisEodPayload } from "./kis-eod-private-store.mjs";

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const validHash = (value) => /^[a-f0-9]{64}$/u.test(value ?? "");
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/u.test(value ?? "") && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const prefix = (mode) => {
  if (!["live", "research", "fixture"].includes(mode)) fail("PRIVATE_MODE_INVALID");
  return `model-top/${mode}`;
};
const digestBytes = (value) => createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
const stamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const allowedExclusions = new Set([null, "officialQuarantinePreserved", "insufficientHistory", "tradingHaltOrNoTrade"]);

// Entire payloads, not just score summaries, are content-addressed. Receipt times
// omitted from the old input identity remain covered by this additional hash.
export async function storePrivateModelBlob(store, folder, value) {
  assertPrivateKisEodPayload(value);
  const identity = sha256Canonical(value), serialized = JSON.stringify(value);
  // JSON fragments are strings, NOT compressed/encoded opaque bytes. The adapter
  // still scans credentials/URLs. Callers supply only provider-normalized fields.
  const pieces = [];
  // Pack near the adapter's byte ceiling to avoid hundreds of GitHub commits.
  // Do not split surrogate pairs; slicing avoids per-character large-blob churn.
  for (let offset = 0; offset < serialized.length;) {
    let end = Math.min(offset + 500_000, serialized.length);
    while (Buffer.byteLength(JSON.stringify(serialized.slice(offset, end))) > 650_000) end = offset + Math.floor((end - offset) * 0.8);
    if (end < serialized.length && /[\uD800-\uDBFF]/u.test(serialized[end - 1])) end -= 1;
    pieces.push(serialized.slice(offset, end)); offset = end;
  }
  if (!pieces.length || pieces.length > 160) fail("PRIVATE_MODEL_BLOB_TOO_LARGE");
  const chunks = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const chunk = { namespace: "kis-private-model-json-fragment", identity, index, text: pieces[index] };
    const key = `${folder}/objects/${identity}/${index}.json`;
    const written = await store.writeImmutable(key, chunk);
    if (written.contentHash !== digestBytes(chunk)) fail("PRIVATE_MODEL_HASH_MISMATCH");
    chunks.push({ key, byteHash: written.contentHash });
  }
  return { identity, chunks };
}

export async function readPrivateModelBlob(store, folder, descriptor) {
  if (!validHash(descriptor?.identity) || !Array.isArray(descriptor?.chunks) || !descriptor.chunks.length || descriptor.chunks.length > 160) fail("PRIVATE_MODEL_HASH_MISMATCH");
  const pieces = [];
  for (let index = 0; index < descriptor.chunks.length; index += 1) {
    const entry = descriptor.chunks[index];
    if (entry?.key !== `${folder}/objects/${descriptor.identity}/${index}.json` || !validHash(entry.byteHash)) fail("PRIVATE_MODEL_PATH_INVALID");
    const stored = await store.read(entry.key), fragment = stored?.value;
    if (!stored || stored.contentHash !== entry.byteHash || fragment?.namespace !== "kis-private-model-json-fragment" || fragment.identity !== descriptor.identity || fragment.index !== index || typeof fragment.text !== "string") fail("PRIVATE_MODEL_HASH_MISMATCH");
    pieces.push(fragment.text);
  }
  let value;
  try { value = JSON.parse(pieces.join("")); } catch { fail("PRIVATE_MODEL_HASH_MISMATCH"); }
  if (sha256Canonical(value) !== descriptor.identity) fail("PRIVATE_MODEL_HASH_MISMATCH");
  return value;
}

export async function recordPrivateModelOperation(store, { mode = "live", status, reason, checkedAt, referenceDate, runId }) {
  if (!["DRY_RUN_READY", "PENDING", "FAILED", "BLOCKED", "PRIVATE_STORED_AND_VERIFIED", "ALREADY_STORED"].includes(status)
    || !/^[A-Z0-9_]{1,80}$/u.test(reason ?? "") || !stamp(checkedAt) || !validDate(referenceDate) || !/^[A-Za-z0-9_.-]{1,100}$/u.test(runId)) fail("PRIVATE_MODEL_OPERATION_INVALID");
  const body = { namespace: "kis-private-model-operation", status, reason, checkedAt, referenceDate, runId, publicationEligible: false };
  await store.writeImmutable(`${prefix(mode)}/operations/${referenceDate}/${sha256Canonical(body)}.json`, body);
}

async function lastOperation(store, mode) {
  const folder = `${prefix(mode)}/operations`, dates = await store.listKeys(folder);
  if (dates.some((entry) => entry.type !== "dir" || !validDate(entry.name))) fail("PRIVATE_MODEL_OPERATION_INVALID");
  if (!dates.length) return null;
  const date = dates.map((entry) => entry.name).sort().at(-1), files = await store.listKeys(`${folder}/${date}`), events = [];
  for (const file of files) {
    if (file.type !== "file" || !/^[a-f0-9]{64}[.]json$/u.test(file.name)) fail("PRIVATE_MODEL_OPERATION_INVALID");
    const event = (await store.read(`${folder}/${date}/${file.name}`))?.value;
    if (!event || event.namespace !== "kis-private-model-operation" || !stamp(event.checkedAt) || event.referenceDate !== date || file.name !== `${sha256Canonical(event)}.json`) fail("PRIVATE_MODEL_OPERATION_INVALID");
    events.push(event);
  }
  return events.sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt)).at(-1) ?? null;
}

function validateLiveBundle(candidate, raw) {
  if (validateKisEodCandidate(candidate).length || candidate.status !== "VALIDATED" || candidate.observationType !== "LIVE_COLLECTION"
    || candidate.quality.structuralErrors.length || candidate.quality.pendingReasons.length
    || inspectKisEodCollection(candidate).status !== "VERIFIED_ALL_NON_QUARANTINED") fail("PRIVATE_MODEL_CANDIDATE_NOT_READY");
  if (raw?.namespace !== "kis-provisional-eod-private-inputs" || raw.referenceDate !== candidate.referenceDate || !Array.isArray(raw.histories)) fail("PRIVATE_MODEL_INPUT_MISMATCH");
  const inputs = new Map(raw.histories.map((entry) => [entry.ticker, entry]));
  if (inputs.size !== raw.histories.length || [...inputs.keys()].some((ticker) => !candidate.records.some((record) => record.ticker === ticker))) fail("PRIVATE_MODEL_INPUT_MISMATCH");
  const identities = candidate.records.map((record) => {
    const input = inputs.get(record.ticker);
    const rows = (input?.rows ?? []).map((row) => Object.fromEntries(["basDt", "mkp", "hipr", "lopr", "clpr", "trqu", "trPrc", "fltRt", "prdy_vrss"].filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]])));
    if (sha256Canonical(rows) !== record.provenance.normalizedInputHash) fail("PRIVATE_MODEL_INPUT_MISMATCH");
    if (rows.length && (input.receivedAt !== record.provenance.sourceReceivedAt || input.priceBasis !== record.provenance.inputPriceBasis
      || sha256Canonical(input.symbolMapping) !== sha256Canonical(record.provenance.symbolMapping))) fail("PRIVATE_MODEL_INPUT_MISMATCH");
    return { ticker: record.ticker, adjustment: input?.adjustment ?? candidate.source.adjustmentPolicy, marketDivision: input?.marketDivision ?? "J", rows };
  });
  if (sha256Canonical(identities) !== candidate.source.normalizedInputHash) fail("PRIVATE_MODEL_INPUT_MISMATCH");
  return candidate;
}

// Research replay has a DIFFERENT namespace and observation type. It cannot be
// inserted into the live head. No historical receipt is changed to close-time.
export function validatePrivateResearchBundle(bundle) {
  if (bundle?.namespace !== "kis-eod-private-research-models" || bundle.observationType !== "HISTORICAL_RESEARCH_REQUEST"
    || !validDate(bundle.referenceDate) || !stamp(bundle.collectionStartedAt) || !stamp(bundle.collectionCompletedAt)
    || Date.parse(bundle.collectionStartedAt) > Date.parse(bundle.collectionCompletedAt) || !Array.isArray(bundle.records) || !bundle.records.length
    || bundle.publicationEligible !== false || bundle.sourceFinality !== "NOT_CONFIRMED" || !validHash(bundle.inputHash)
    || !KIS_EOD_MODEL_VERSIONS.every((version) => validHash(bundle.modelFormulaHashes?.[version]))) fail("PRIVATE_RESEARCH_INVALID");
  if (new Set(bundle.records.map((record) => record.ticker)).size !== bundle.records.length) fail("PRIVATE_RESEARCH_INVALID");
  for (const version of KIS_EOD_MODEL_VERSIONS) {
    const ranks = bundle.records.filter((record) => Number.isInteger(record.ranks?.[version])).map((record) => record.ranks[version]).sort((a, b) => a - b);
    if (ranks.some((rank, index) => rank !== index + 1)) fail("PRIVATE_RESEARCH_INVALID");
    for (const record of bundle.records) if (!allowedExclusions.has(record.exclusionReasons?.[version])
      || (Number.isFinite(record.scores?.[version]) && Number.isInteger(record.ranks?.[version])) !== (record.exclusionReasons?.[version] === null)) fail("PRIVATE_RESEARCH_INVALID");
  }
  return bundle;
}

export async function persistPrivateModelBundle({ store, candidate, raw, research, mode = "live", runId = "local" }) {
  const folder = prefix(mode);
  if (!/^[A-Za-z0-9_.-]{1,100}$/u.test(runId)) fail("PRIVATE_MODEL_RUN_ID_INVALID");
  const result = mode === "research" ? validatePrivateResearchBundle(research) : validateLiveBundle(candidate, raw);
  if (mode === "research" && (raw?.namespace !== "kis-private-model-research-inputs" || raw.referenceDate !== result.referenceDate || sha256Canonical(raw) !== result.inputHash)) fail("PRIVATE_MODEL_INPUT_MISMATCH");
  if (mode === "fixture") fail("PRIVATE_MODEL_FIXTURE_PROMOTION_FORBIDDEN");
  await store.preflight();
  const source = await storePrivateModelBlob(store, folder, raw);
  const models = await storePrivateModelBlob(store, folder, result);
  // A head is visible only AFTER every source/model shard reads back unchanged.
  await readPrivateModelBlob(store, folder, source);
  await readPrivateModelBlob(store, folder, models);
  const body = { namespace: "kis-private-model-promotion", mode, referenceDate: result.referenceDate,
    collectionStartedAt: result.collectionStartedAt, collectionCompletedAt: result.collectionCompletedAt,
    source, models, inputHash: mode === "research" ? result.inputHash : result.source.normalizedInputHash,
    modelFormulaHashes: result.modelFormulaHashes, runId, sourceFinality: "NOT_CONFIRMED", publicationEligible: false };
  const promotionHash = sha256Canonical(body), event = { ...body, promotionHash };
  await store.writeImmutable(`${folder}/heads/${body.referenceDate}/${promotionHash}.json`, event);
  const latest = await readPrivateModelHead(store, mode);
  return { status: "PRIVATE_STORED_AND_VERIFIED", referenceDate: body.referenceDate, promotionHash, latestReferenceDate: latest?.referenceDate ?? null, sourceFinality: "NOT_CONFIRMED", publicationEligible: false };
}

// Append-only pointer journal. Concurrent writes cannot overwrite each other;
// derived maximum(date, receipt time, hash) cannot be moved back by an older run.
// Read failure/corruption fails closed instead of silently serving an older head.
export async function readPrivateModelHead(store, mode = "live") {
  const folder = prefix(mode);
  await store.verifyPrivateRepository();
  const dates = await store.listKeys(`${folder}/heads`);
  if (dates.some((entry) => entry.type !== "dir" || !validDate(entry.name))) fail("PRIVATE_MODEL_HEAD_INVALID");
  if (!dates.length) return null;
  const date = dates.map((entry) => entry.name).sort().at(-1), entries = await store.listKeys(`${folder}/heads/${date}`);
  const heads = [];
  for (const entry of entries) {
    if (entry.type !== "file" || !/^[a-f0-9]{64}[.]json$/u.test(entry.name)) fail("PRIVATE_MODEL_HEAD_INVALID");
    const event = (await store.read(`${folder}/heads/${date}/${entry.name}`))?.value;
    if (!event) fail("PRIVATE_MODEL_HEAD_INVALID");
    const { promotionHash, ...body } = event;
    if (event.namespace !== "kis-private-model-promotion" || event.mode !== mode || event.referenceDate !== date || !stamp(event.collectionCompletedAt)
      || event.publicationEligible !== false || promotionHash !== sha256Canonical(body) || entry.name !== `${promotionHash}.json`) fail("PRIVATE_MODEL_HEAD_INVALID");
    heads.push(event);
  }
  if (!heads.length) fail("PRIVATE_MODEL_HEAD_INVALID");
  return heads.sort((a, b) => Date.parse(a.collectionCompletedAt) - Date.parse(b.collectionCompletedAt) || a.promotionHash.localeCompare(b.promotionHash)).at(-1);
}

export async function queryPrivateModelTop(store, { model = "B", version = null, limit = 5, mode = "live" } = {}) {
  const selectedVersion = version ?? ({ A: "A-v2", B: "B-v1", C: "C-v1", D: "D-v1" })[model];
  if (!KIS_EOD_MODEL_VERSIONS.includes(selectedVersion) || ![5, 10, 20].includes(limit) || !["live", "research"].includes(mode)) fail("PRIVATE_MODEL_QUERY_INVALID");
  const head = await readPrivateModelHead(store, mode);
  const operation = await lastOperation(store, mode);
  if (!head) return { status: "DATA_ACCUMULATING", dataMode: `kisPrivate-${mode}`, referenceDate: null, stocks: [], lastOperation: operation, publicationEligible: false };
  const result = await readPrivateModelBlob(store, prefix(mode), head.models);
  if (result.referenceDate !== head.referenceDate || sha256Canonical(result.modelFormulaHashes) !== sha256Canonical(head.modelFormulaHashes)
    || (mode === "research" ? result.inputHash : result.source?.normalizedInputHash) !== head.inputHash) fail("PRIVATE_MODEL_INPUT_MISMATCH");
  if (mode === "research") validatePrivateResearchBundle(result);
  else if (validateKisEodCandidate(result).length || result.observationType !== "LIVE_COLLECTION" || inspectKisEodCollection(result).status !== "VERIFIED_ALL_NON_QUARANTINED") fail("PRIVATE_MODEL_CANDIDATE_NOT_READY");
  const ranked = result.records.filter((record) => Number.isInteger(record.ranks[selectedVersion])).sort((a, b) => a.ranks[selectedVersion] - b.ranks[selectedVersion]);
  return { status: "PRIVATE_VALIDATED_PROVISIONAL", dataMode: `kisPrivate-${mode}`, observationType: result.observationType,
    referenceDate: result.referenceDate, modelVersion: selectedVersion, limit, collectedAt: head.collectionCompletedAt,
    collectionStartedAt: head.collectionStartedAt, sourceFinality: "NOT_CONFIRMED", publicationEligible: false,
    lastOperation: operation, lastSuccessAt: head.collectionCompletedAt,
    eligibleCount: ranked.length, excludedCount: result.records.length - ranked.length, promotionHash: head.promotionHash,
    modelFormulaHash: head.modelFormulaHashes[selectedVersion], inputHash: head.inputHash,
    stocks: ranked.slice(0, limit).map((record) => ({ rank: record.ranks[selectedVersion], code: record.ticker, name: record.companyName, market: record.market, score: record.scores[selectedVersion] })) };
}
