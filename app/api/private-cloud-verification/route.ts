import { withAdminAccess } from "@/lib/admin-access";
import { privateCloudVerificationResponse } from "@/lib/private-cloud-verification.mjs";

export const runtime = "nodejs";
export const GET = withAdminAccess(async (request: Request) => privateCloudVerificationResponse(request));
