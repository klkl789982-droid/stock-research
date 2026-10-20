import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const target = process.argv[2]; if (!target || !path.isAbsolute(target)) throw new Error("PRIVATE_OUTPUT_REQUIRED");
const token = /^oauth_token\s*=\s*"([^"]+)"/mu.exec(await fs.readFile(path.join(process.env.APPDATA, "xdg.config/.wrangler/config/default.toml"), "utf8"))?.[1];
const base = "https://api.cloudflare.com/client/v4/accounts/a270e8d00736b9adbeaab41945266c99/workers/scripts/tight-budget-live-kis-diagnostic";
async function read(suffix) {
  const r = await fetch(base + suffix, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`DEPLOY_READ_${r.status}`); const j = await r.json(); if (!j.success) throw new Error("DEPLOY_READ_FAILED"); return j.result;
}
try {
  const [settings, schedules] = await Promise.all([read("/settings"), read("/schedules")]);
  const config = JSON.parse(await fs.readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"));
  const names = ["LIVE_ENABLED", "DIAGNOSTIC_ONLY", "LIVE_PRODUCTION_ENABLED", "LIVE_PRODUCER", "LIVE_CUTOVER_RECEIPT_HASH"];
  const vars = Object.fromEntries(settings.bindings.filter(b => b.type === "plain_text").map(b => [b.name, b.text]));
  if (Object.keys(vars).some(k => !names.includes(k)) || vars.LIVE_PRODUCTION_ENABLED !== "true" || vars.LIVE_PRODUCER !== "cloud"
    || vars.LIVE_ENABLED !== "false" || vars.DIAGNOSTIC_ONLY !== "true" || !/^[a-f0-9]{64}$/u.test(vars.LIVE_CUTOVER_RECEIPT_HASH ?? "")) throw new Error("DEPLOY_OWNER_CONFIG_CHANGED");
  const crons = schedules.schedules.map(s => s.cron).sort();
  if (JSON.stringify(crons) !== JSON.stringify(["40,50 4 * * MON-FRI", "6,8,10 5 * * MON-FRI"].sort())) throw new Error("DEPLOY_CRON_CHANGED");
  for (const binding of config.durable_objects.bindings) if (!settings.bindings.some(b => b.name === binding.name && b.class_name === binding.class_name && b.namespace_id)) throw new Error("DEPLOY_NAMESPACE_CHANGED");
  const secrets = settings.bindings.filter(b => b.type === "secret_text").map(b => b.name).sort();
  if (JSON.stringify(secrets) !== JSON.stringify(["KIS_APP_KEY", "KIS_APP_SECRET", "PRIVATE_LIVE_DELIVERY_WRITE_TOKEN"].sort())) throw new Error("DEPLOY_SECRET_BINDINGS_CHANGED");
  const result = { ...config, main: fileURLToPath(new URL("./src/index.mjs", import.meta.url)), vars, triggers: { crons },
    compatibility_date: settings.compatibility_date, compatibility_flags: settings.compatibility_flags,
    observability: settings.observability ?? { enabled: false }, ...(settings.limits ? { limits: settings.limits } : {}) };
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(result, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ status: "CURRENT_PRODUCTION_CONFIG_PRESERVED", target, producer: vars.LIVE_PRODUCER,
    enabled: vars.LIVE_PRODUCTION_ENABLED, crons, secretNames: secrets, secretsRead: false }));
} catch (e) { console.error(JSON.stringify({ status: "BLOCKED", code: /^DEPLOY_[A-Z_0-9]+$/u.test(e.message) ? e.message : "DEPLOY_CONFIG_FAILED" })); process.exitCode = 1; }
