import "server-only";

import { createKisApiClient } from "./kis-api-client-core.mjs";
import { createKisTokenManager } from "./kis-token-manager-core.mjs";
import { createKisReadTransport, createSharedKisReadTokenManager } from "./kis-shared-read-token.mjs";
import { authConfig, createRedisCommand } from "./admin-auth.mjs";

function getCredentials() {
  return {
    appKey: (process.env.KIS_APP_KEY ?? "").trim(),
    appSecret: (process.env.KIS_APP_SECRET ?? "").trim(),
  };
}

const readTransport = createKisReadTransport(fetch);
export const kisTokenManager = process.env.VERCEL === "1"
  ? createSharedKisReadTokenManager({ getCredentials, fetchImpl:readTransport, command: (args: unknown[]) => createRedisCommand(authConfig())(args) })
  : createKisTokenManager({ fetchImpl:readTransport, getCredentials });
const kisApiClient = createKisApiClient({ fetchImpl:readTransport, tokenManager:kisTokenManager, getCredentials });

export async function kisRequest(input: string | URL, init: RequestInit = {}) {
  return kisApiClient.request(input, init);
}

export { classifyKisHttpStatus, safeKisError } from "./kis-api-client-core.mjs";
