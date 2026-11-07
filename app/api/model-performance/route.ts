import { readFile } from "node:fs/promises";
import path from "node:path";
import { withAdminAccess } from "@/lib/admin-access";
import { isAutomationRequest } from "@/lib/admin-auth.mjs";
import { isCommitSha } from "@/lib/publication-identity.mjs";
import { privateReportDirectory } from "@/lib/private-report-directory.mjs";

type View = "report" | "identity" | "home";
const bodies = new Map<View, Promise<string>>();

async function readReport(view: View) {
  const text = await readFile(path.join(privateReportDirectory(process.cwd()), "private-model-performance", view + ".json"), "utf8");
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (!isCommitSha(sha)) return text;
  const value = JSON.parse(text);
  if (!value.dataIdentity) return text;
  if (value.dataIdentity.commitSha === sha) return text;
  if (value.dataIdentity.commitSha != null) throw new Error("PERFORMANCE_RELEASE_IDENTITY_MISMATCH");
  value.dataIdentity.commitSha = sha;
  return JSON.stringify(value);
}

async function handleGet(request: Request) {
  const view = isAutomationRequest(request) ? "identity" : new URL(request.url).searchParams.get("view") === "home" ? "home" : "report";
  const headers = { "Cache-Control": "private, no-store", "Content-Type": "application/json" };
  try {
    // The report is regenerated from this release's inputs before every build.
    // Only private response bytes are memoized. Every invocation still authenticates.
    let body = bodies.get(view);
    if (!body) {
      body = readReport(view);
      bodies.set(view, body);
    }
    return new Response(await body, { headers });
  } catch {
    bodies.delete(view);
    return Response.json({ error: { code: "PERFORMANCE_REPORT_UNAVAILABLE" } }, { status: 503, headers });
  }
}

export const GET = withAdminAccess(handleGet);
