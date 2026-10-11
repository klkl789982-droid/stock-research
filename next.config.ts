import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Isolated local authentication integration tests; never a Production setting.
  ...(process.env.NODE_ENV === "development" && process.env.TB_AUTH_TEST_BUILD === "1" ? {
    distDir: ".next-auth-test",
    typescript: { tsconfigPath: "tsconfig.auth-test.json" },
  } : {}),
  outputFileTracingIncludes: {
    "/api/model-performance/research": ["./data/history/*.json", "./data/model-history/*.json", "./data/market-prices/*.json", "./data/daily-runs/**/*.json", "./data/trading-calendar/status.json"],
    "/api/kis-eod-top-stocks": ["./data/kis-eod-published/*.json", "./data/history/*.json"],
  },
  outputFileTracingExcludes: {
    "/*": ["./.runtime/kis-eod/**/*"],
  },
};

export default nextConfig;
