import "server-only";

import { createKisApiClient } from "./kis-api-client-core.mjs";
import { createKisTokenManager } from "./kis-token-manager-core.mjs";

function getCredentials() {
  return {
    appKey: process.env.KIS_APP_KEY ?? "",
    appSecret: process.env.KIS_APP_SECRET ?? "",
  };
}

export const kisTokenManager = createKisTokenManager({ fetchImpl: fetch, getCredentials });
const kisApiClient = createKisApiClient({ fetchImpl: fetch, tokenManager: kisTokenManager, getCredentials });

export async function kisRequest(input: string | URL, init: RequestInit = {}) {
  return kisApiClient.request(input, init);
}

export { classifyKisHttpStatus, safeKisError } from "./kis-api-client-core.mjs";
