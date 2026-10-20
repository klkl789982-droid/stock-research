import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { runCongestion } from "./congestion-runner.mjs";
export async function replayCongestion(options = {}) {
  const db = new DatabaseSync(":memory:");
  const stats = { queries: 0, usageUpdates: 0, modeledRead: 0, modeledWritten: 0 };
  const sql = { get databaseSize() { return db.prepare("PRAGMA page_count").get().page_count * 4096; }, exec(query, ...args) {
    const rows = db.prepare(query).all(...args);
    const c = { toArray: () => rows, rowsRead: rows.length + 1, rowsWritten: /^(?:INSERT|UPDATE|DELETE)/u.test(query) ? 2 : 0 };
    stats.queries++; if (query.startsWith("UPDATE usage")) stats.usageUpdates++;
    stats.modeledRead += c.rowsRead; stats.modeledWritten += c.rowsWritten; return c;
  } };
  const transaction = fn => { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  try { return { ...await runCongestion({ ...options, sql, transaction }), stats }; } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await replayCongestion(), null, 2));
