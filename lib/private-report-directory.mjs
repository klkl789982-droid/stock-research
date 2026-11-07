import path from "node:path";

export function privateReportDirectory(root, env = process.env) {
  return env.NODE_ENV === "development" && env.TB_AUTH_TEST_BUILD === "1"
    ? path.join(root, "build", "auth-test")
    : path.join(root, "build");
}
