import { buildIntradayModelTopSignal, calculateIntradayModelTopScores, hashIntradayModelTop, MODEL_SPECS, validateIntradayModelTopSignal, isCurrentIntradayModelTopSignal } from "../../lib/intraday-model-top-official-signal.mjs";
import { mergeProvisionalCandle } from "../../lib/intraday-model-b-official-signal.mjs";
import { validateIntradayMarketSeed } from "../../lib/intraday-market-seed.mjs";
import { classifyOfficialSignalWindow, signalWeekday, OFFICIAL_SIGNAL_TIME } from "../../lib/intraday-model-top-time-policy.mjs";

export const clockKst = (ms) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
};
const versions = Object.values(MODEL_SPECS).map((spec) => spec.modelVersion);
const iso = (now) => new Date(now()).toISOString();
export const safeReason = (error) => /^[A-Z][A-Z0-9_]{2,95}$/u.test(error?.message ?? "") ? error.message : "EXECUTOR_OPERATION_FAILED";

// This type cannot be consumed as an Official Signal. Real current timestamps
// are retained and only the unchanged score functions are exercised after hours.
export function buildShadowResult(seed, quotes, date, startedAt, completedAt) {
  const records = seed.records.filter((item) => item.eligible).map((item) => {
    const quote = quotes.get(item.code);
    const observed = Date.parse(`${date}T${quote?.asOfTime}+09:00`), received = Date.parse(quote?.receivedAt);
    if (quote?.asOfDate !== date || !Number.isFinite(observed) || !Number.isFinite(received) || observed > received) throw new Error("SHADOW_QUOTE_TIMESTAMP_INVALID");
    const rows = mergeProvisionalCandle(item.rows, quote);
    if (!rows) throw new Error("SHADOW_OHLCV_INVALID");
    const { scores } = calculateIntradayModelTopScores(rows, quote);
    if (!versions.every((version) => Number.isFinite(scores[version]))) throw new Error("MODEL_SCORE_INVALID");
    return { ticker: item.code, companyName: item.name, market: item.market, scores, ranks: {}, quote };
  });
  const top5 = {};
  for (const version of versions) {
    const ranked = [...records].sort((a, b) => b.scores[version] - a.scores[version] || a.ticker.localeCompare(b.ticker));
    ranked.forEach((record, i) => { record.ranks[version] = i + 1; });
    top5[version] = ranked.slice(0, 5).map((r) => ({ ticker: r.ticker, companyName: r.companyName, score: r.scores[version], rank: r.ranks[version] }));
  }
  const base = { schemaVersion: 1, artifactType: "independentLiveExecutorShadow", observationType: "CURRENT_TIME_SHADOW", eligibleForOfficialSignal: false, eligibleForOutcomes: false, signalDate: date,
    collectionStartedAt: startedAt, collectionCompletedAt: completedAt, seedReferenceDate: seed.requestedDate, seedHash: seed.contentHash,
    modelFormulaHashes: seed.sourceManifest.modelFormulaHashes, status: "READY", collection: { successful: records.length, failed: 0, ineligible: seed.records.length - records.length }, top5, records };
  return { ...base, contentHash: hashIntradayModelTop(base) };
}

export function createExecutor({ store, source, loadSeed, verifyFormula, verifySeedSession = async () => { throw new Error("LIVE_INPUT_NOT_READY_PREVIOUS_SESSION_UNVERIFIED"); }, getInputProvenance = () => null, requireFinalInputRefresh = true, verifyClock = async () => null, now = Date.now, publish = null, recordSwing = null, expectedUniverseCount = 553, onProgress = () => {} }) {
  async function prepare(mode, date, runId = date) {
    signalWeekday(date);
    if (!["live", "shadow"].includes(mode) || !/^[A-Za-z0-9-]+$/u.test(runId)) throw new Error("EXECUTOR_ARGUMENT_INVALID");
    const base = `${mode}/${date}/${runId}`;
    const finalInputs = await store.read(`${base}/collection-prepared.json`);
    const existing = finalInputs ?? await store.read(`${base}/prepared.json`);
    const finalRefresh = mode === "live" && requireFinalInputRefresh && !finalInputs && clockKst(now()).time >= "13:59:00";
    if (finalRefresh && now() >= Date.parse(`${date}T${OFFICIAL_SIGNAL_TIME}+09:00`)) throw new Error("LIVE_INPUT_NOT_READY_REFRESH_LATE");
    if (existing && !finalRefresh) {
      await verifyFormula(existing.formulaEvidence);
      if (mode === "live") await verifySeedSession(await store.read(existing.seedKey), date, existing.inputProvenance ?? null);
      return existing;
    }
    const clockEvidence = await verifyClock();
    const calendar = await source.calendar(date);
    if (calendar.isTradingDay === false) throw new Error("MARKET_CLOSED");
    if (calendar.isTradingDay !== true) throw new Error("TRADING_CALENDAR_UNAVAILABLE");
    const seed = await loadSeed(date);
    if (validateIntradayMarketSeed(seed, expectedUniverseCount).length || seed.requestedDate >= date) throw new Error("PRIOR_SEED_INVALID");
    if (mode === "live") await verifySeedSession(seed, date);
    // The exact verified preceding session is required, with its actual date and
    // availability retained. An older seed cannot bridge a missing session.
    const formulaEvidence = await verifyFormula();
    const seedKey = `${mode}/seeds/${seed.contentHash}.json`;
    await store.writeImmutable(seedKey, seed);
    const prepared = { mode, date, runId, base, seedKey, seedHash: seed.contentHash, inputProvenance: getInputProvenance(seed), formulaEvidence, calendar,
      ...(clockEvidence == null ? {} : { clockEvidence }), preparedAt: iso(now), eligibleCount: seed.records.filter((r) => r.eligible).length, universeCount: seed.records.length };
    // Preserve prewarm evidence and pin a separate last-minute input receipt.
    if (finalRefresh && now() >= Date.parse(`${date}T${OFFICIAL_SIGNAL_TIME}+09:00`)) throw new Error("LIVE_INPUT_NOT_READY_REFRESH_LATE");
    await store.writeImmutable(`${base}/${finalRefresh ? "collection-prepared" : "prepared"}.json`, prepared);
    return prepared;
  }

  async function advance({ mode = "live", date = clockKst(now()).date, runId = date } = {}) {
    return store.withLock("executor", async () => {
      const base = `${mode}/${date}/${runId}`;
      let status = await store.read(`${base}/status.json`) ?? { attempts: 0, preparationAttempts: 0, status: "NEW" };
      const saved = await store.read(`${base}/result.json`);
      const finish = async (artifact) => {
        const previous = await store.read(`${mode}/latest.json`);
        if (!previous || previous.signalDate <= date) await store.writeMutable(`${mode}/latest.json`, { signalDate: date, artifactKey: `${base}/result.json`, contentHash: artifact.contentHash, observationType: artifact.observationType, storedAt: status.storedAt ?? iso(now) });
        status = { ...status, status: "STORED", reason: null, storedAt: status.storedAt ?? iso(now), contentHash: artifact.contentHash };
        await store.writeMutable(`${base}/status.json`, status);
        if (mode === "live" && recordSwing && status.swing?.status !== "RECORDED"
          && (status.swingAttempts ?? 0) < 3 && (status.nextSwingAt ?? 0) <= now()) {
          status.swingAttempts = (status.swingAttempts ?? 0) + 1;
          try { status.swing = await recordSwing(artifact); }
          catch (error) { status.swing = { status: "FAILED", reason: safeReason(error) }; }
          status.nextSwingAt = now() + 60000;
          await store.writeMutable(`${base}/status.json`, status);
        }
        if (mode === "live" && publish) {
          const outbox = await store.read("live/outbox.json") ?? { dates: [] };
          if (!outbox.dates.includes(date)) await store.writeMutable("live/outbox.json", { dates: [...outbox.dates, date].sort() });
        }
        if (mode === "live" && publish && status.publication !== "VERIFIED" && (status.publicationAttempts ?? 0) < 3 && (status.nextPublicationAt ?? 0) <= now()) {
          status.publicationAttempts = (status.publicationAttempts ?? 0) + 1;
          try { const result = await publish(artifact); status.publication = result.publicationVerified ? "VERIFIED" : result.status; status.publicationResult = result; }
          catch (error) { status.publication = "FAILED"; status.publicationReason = safeReason(error); }
          status.nextPublicationAt = now() + 60000;
          await store.writeMutable(`${base}/status.json`, status);
          if (status.publication === "VERIFIED") {
            const outbox = await store.read("live/outbox.json");
            await store.writeMutable("live/outbox.json", { dates: outbox.dates.filter((value) => value !== date) });
          }
        }
        return status;
      };
      if (saved) {
        if (mode === "live" && !isCurrentIntradayModelTopSignal(saved)) return { status: "ARCHIVED", reason: "LEGACY_OBSERVATION_READ_ONLY", contentHash: saved.contentHash };
        const pointer = await store.read(`${mode}/latest.json`);
        if (status.status === "STORED" && pointer?.contentHash === saved.contentHash && (!publish || status.publication === "VERIFIED")
          && (!recordSwing || status.swing?.status === "RECORDED" || (status.swingAttempts ?? 0) >= 3 || (status.nextSwingAt ?? 0) > now())) return status;
        if (status.status === "FAILED" && ((status.nextAttemptAt ?? 0) > now() || (status.storageRecoveryAttempts ?? 0) >= 3)) return status;
        try { return await finish(saved); }
        catch (error) {
          // A durable result must not turn a pointer/status write failure into
          // a hot retry loop. Recover only storage; never recollect its prices.
          status = { ...status, status: "FAILED", reason: safeReason(error), storageRecoveryAttempts: (status.storageRecoveryAttempts ?? 0) + 1,
            nextAttemptAt: now() + 60000, recordedAt: iso(now) };
          await store.writeMutable(`${base}/status.json`, status);
          return status;
        }
      }
      if (status.status === "MISSED" || status.status === "MARKET_CLOSED") return status;
      let prepared, preparationAttempted = false;
      try {
        const clock = clockKst(now());
        if (clock.date !== date) throw new Error("EXECUTOR_DATE_MISMATCH");
        if (mode === "live" && [0, 6].includes(signalWeekday(date))) throw new Error("MARKET_CLOSED");
        const previousPreparation = await store.read(`${base}/collection-prepared.json`) ?? await store.read(`${base}/prepared.json`);
        if (mode === "live" && !previousPreparation && classifyOfficialSignalWindow({ time: clock.time, weekday: signalWeekday(date) }) === "AFTER_WINDOW") {
          status = { ...status, status: "MISSED", reason: "OFFICIAL_SIGNAL_OUTSIDE_COLLECTION_WINDOW", successful: 0, recordedAt: iso(now) };
          await store.writeMutable(`${base}/status.json`, status); return status;
        }
        if ((status.nextAttemptAt ?? 0) > now()) return status;
        if ((status.preparationAttempts ?? 0) >= (mode === "live" ? 25 : 3) && !previousPreparation) return status;
        if (!previousPreparation) {
          // Calendar/seed/network failures during prewarm must not consume the
          // separate three-attempt budget for observation-price collection.
          status = { ...status, preparationAttempts: (status.preparationAttempts ?? 0) + 1 };
          preparationAttempted = true;
          await store.writeMutable(`${base}/status.json`, status);
        }
        prepared = await prepare(mode, date, runId);
        const window = classifyOfficialSignalWindow({ time: clockKst(now()).time, weekday: signalWeekday(date) });
        if (mode === "live" && window === "BEFORE_WINDOW") {
          status = { ...status, status: "PREPARED", scheduledAt: `${date}T${OFFICIAL_SIGNAL_TIME}+09:00`, preparedAt: prepared.preparedAt };
          await store.writeMutable(`${base}/status.json`, status); return status;
        }
        const seed = await store.read(prepared.seedKey);
        if (seed.contentHash !== prepared.seedHash || validateIntradayMarketSeed(seed, expectedUniverseCount).length) throw new Error("PREPARED_SEED_CORRUPT");
        await verifyFormula(prepared.formulaEvidence);
        const quotes = new Map(), eligible = seed.records.filter((record) => record.eligible);
        for (const item of eligible) {
          const quote = await store.read(`${base}/quotes/${item.code}.json`);
          if (quote) quotes.set(item.code, quote);
        }
        if (status.attempts >= 3 && quotes.size !== eligible.length) return status;
        if (mode === "live" && window !== "COLLECT" && quotes.size !== eligible.length) {
          status = { ...status, status: "MISSED", reason: "OFFICIAL_SIGNAL_OUTSIDE_COLLECTION_WINDOW", successful: quotes.size, recordedAt: iso(now) };
          await store.writeMutable(`${base}/status.json`, status); return status;
        }
        status = { ...status, status: "COLLECTING", attempts: status.attempts + (quotes.size < eligible.length ? 1 : 0), collectionStartedAt: status.collectionStartedAt ?? iso(now), failureCodes: {} };
        await store.writeMutable(`${base}/status.json`, status);
        const missing = eligible.filter((r) => !quotes.has(r.code));
        // Two workers share the source's request limiter; successful quotes survive restarts.
        let cursor = 0;
        await Promise.all(Array.from({ length: 2 }, async () => {
          while (cursor < missing.length) {
            const item = missing[cursor++];
            try {
              const quote = await source.collectQuote(item.code, { date, live: mode === "live" });
              await store.writeImmutable(`${base}/quotes/${item.code}.json`, quote);
              quotes.set(item.code, quote);
            } catch (error) {
              const reason = safeReason(error); status.failureCodes[reason] = (status.failureCodes[reason] ?? 0) + 1;
              if (/WINDOW|CREDENTIAL|AUTH|TOKEN/u.test(reason)) break;
            }
            if (quotes.size % 50 === 0) onProgress({ successful: quotes.size, requested: eligible.length });
          }
        }));
        const responseTimes = [...quotes.values()].map((quote) => quote.minuteReceivedAt ?? quote.receivedAt).filter((stamp) => Number.isFinite(Date.parse(stamp))).sort();
        status.collectionCompletedAt = responseTimes.at(-1) ?? iso(now);
        status.successful = quotes.size; status.failed = eligible.length - quotes.size;
        if (status.failed) {
          status.status = "PARTIAL"; status.nextAttemptAt = now() + 15000;
          await store.writeMutable(`${base}/status.json`, status); return status;
        }
        const artifact = mode === "live"
          ? buildIntradayModelTopSignal({ seed, quotesByCode: quotes, signalDate: date, collectionStartedAt: status.collectionStartedAt, collectionCompletedAt: status.collectionCompletedAt, inputProvenance: prepared.inputProvenance ?? null })
          : buildShadowResult(seed, quotes, date, status.collectionStartedAt, status.collectionCompletedAt);
        if (artifact.status !== "READY" || (mode === "live" && (validateIntradayModelTopSignal(artifact).length || versions.some((version) => artifact.rankingUniverse[version].count !== eligible.length)))) throw new Error("MODEL_SIGNAL_VALIDATION_FAILED");
        status.calculationCompletedAt = iso(now);
        await store.writeImmutable(`${base}/result.json`, artifact);
        return await finish(artifact);
      } catch (error) {
        const failedAt = now(), cutoff = Date.parse(`${date}T${OFFICIAL_SIGNAL_TIME}+09:00`), finalRefreshAt = cutoff - 60000;
        // Do not let prewarm backoff skip the final refresh minute. A newly
        // published exact-session seed can still arrive during 13:59. Keep the
        // existing preparation budget and never admit inputs at/after 14:00.
        const nextAttemptAt = mode === "live" && !prepared && failedAt < cutoff
          ? failedAt < finalRefreshAt ? Math.min(failedAt + 60000, finalRefreshAt) : Math.min(failedAt + 10000, cutoff)
          : failedAt + 60000;
        status = { ...status, status: error.message === "MARKET_CLOSED" ? "MARKET_CLOSED" : error.message.startsWith("LIVE_INPUT_NOT_READY_") ? "WAITING" : "FAILED", reason: safeReason(error), attempts: Math.max(status.attempts, (await store.read(`${base}/status.json`))?.attempts ?? 0),
          preparationAttempts: (status.preparationAttempts ?? 0) + (!prepared && !preparationAttempted ? 1 : 0), nextAttemptAt, recordedAt: iso(now) };
        await store.writeMutable(`${base}/status.json`, status);
        return status;
      }
    });
  }
  return { prepare, advance };
}
