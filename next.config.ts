import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Isolated local authentication integration tests; never a Production setting.
  ...(process.env.NODE_ENV === "development" && process.env.TB_AUTH_TEST_BUILD === "1" ? {
    distDir: ".next-auth-test",
    typescript: { tsconfigPath: "tsconfig.auth-test.json" },
  } : {}),
  outputFileTracingIncludes: {
    "/api/intraday-model-top": ["./data/intraday-signals/model-top/latest.json", "./data/intraday-signals/model-top/*/1400.json", "./data/intraday-signals/model-top/*/1430.json", "./data/trading-calendar/status.json"],
    "/api/model-performance": ["./data/intraday-outcomes/model-top/1400/*.json"],
    "/api/forecasts/swing": ["./data/intraday-signals/model-top/latest.json", "./data/intraday-signals/model-top/*/1400.json", "./data/forecast-ledger/swing-5d/*.json", "./data/forecast-outcomes/swing-5d/*/*.json"],
    "/api/screener": ["./data/history/*.json", "./data/analysis/market-seeds/*.json", "./data/trading-calendar/status.json", "./data/intraday-signals/model-top/latest.json", "./data/intraday-signals/model-top/*/1400.json"],
    "/api/model-performance/research": ["./data/history/*.json", "./data/model-history/*.json", "./data/market-prices/*.json", "./data/daily-runs/**/*.json", "./data/trading-calendar/status.json"],
    "/api/kis-eod-top-stocks": ["./data/kis-eod-published/*.json", "./data/history/*.json"],
  },
  outputFileTracingExcludes: {
    "/*": ["./.runtime/kis-eod/**/*"],
    "/api/forecasts/swing": ["./data/intraday-signals/model-top/*/1430.json"],
    "/api/screener": ["./data/intraday-signals/model-top/*/1430.json"],
    "/api/model-performance": ["./data/intraday-outcomes/model-top/????-??-??.json"],
  },
};

export default nextConfig;
