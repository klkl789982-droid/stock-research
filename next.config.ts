import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Isolated local authentication integration tests; never a Production setting.
  ...(process.env.NODE_ENV === "development" && process.env.TB_AUTH_TEST_BUILD === "1" ? {
    distDir: ".next-auth-test",
    typescript: { tsconfigPath: "tsconfig.auth-test.json" },
  } : {}),
  outputFileTracingIncludes: {
    "/api/model-performance": ["./build/private-model-performance/*.json"],
    "/api/home-dashboard": ["./build/private-home-dashboard/*.json"],
    "/api/watchlist": ["./data/history/*.json", "./data/trading-calendar/status.json"],
    "/api/market-overview": ["./data/model-history/*.json", "./data/market-prices/*.json", "./data/trading-calendar/status.json"],
    "/api/model-performance/live": ["./data/market-prices/*.json", "./data/trading-calendar/status.json"],
    "/api/screener": ["./data/history/*.json", "./data/analysis/market-seeds/*.json", "./data/trading-calendar/status.json", "./data/intraday-signals/model-top/latest.json", "./data/intraday-signals/model-top/*/1430.json"],
    "/api/model-performance/research": ["./data/history/*.json", "./data/model-history/*.json", "./data/market-prices/*.json", "./data/daily-runs/**/*.json", "./data/trading-calendar/status.json", "./data/model-validation/daily-publication-evidence.json"],
    "/api/kis-eod-top-stocks": ["./data/kis-eod-published/*.json", "./data/history/*.json"],
  },
  outputFileTracingExcludes: {
    "/*": ["./.runtime/kis-eod/**/*", "./build/auth-test/**/*"],
  },
};

export default nextConfig;
