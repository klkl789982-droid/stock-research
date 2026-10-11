# Administrator access control

## Deployment gate

All application pages and APIs are private. Missing/invalid credentials or an
unreachable session store fail closed. `/login` remains available; APIs return
401 (no valid session) or 503 (authentication unavailable). Do not report
Production activation before validating a real login and anonymous denial.

No new service has been created, no administrator credentials have been selected,
and no Vercel/GitHub secrets have been provisioned by this change.

## Required server-only Vercel variables

| Variable | Setup |
| --- | --- |
| `TB_ADMIN_USERNAME` | Choose the sole administrator ID, maximum 100 characters. |
| `TB_ADMIN_PASSWORD_HASH` | Run `node scripts/hash-admin-password.mjs` locally. Enter a unique password of at least 8 characters containing an English letter and a digit; special characters are optional (maximum 1024 bytes). Copy only the generated hash. Never commit the password or hash. |
| `TB_SESSION_SECRET` | Generate 32 random bytes using the command below. |
| `TB_AUTH_ORIGIN` | Exact canonical HTTPS origin, e.g. `https://stock-research-chi.vercel.app`, no trailing slash. Preview deployments need their own exact origin. |
| `TB_AUTH_REDIS_URL` | HTTPS Redis REST endpoint (Upstash-compatible). |
| `TB_AUTH_REDIS_TOKEN` | Server-side read/write token for the authentication Redis store. |
| `TB_AUTOMATION_READ_TOKEN` | Separate random 32-byte token, also register under the same name in stock-research GitHub Actions Repository secrets. |

Generate each token **separately**, personally in a trusted terminal:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use Vercel Project → Settings → Environment Variables, Production, sensitive
server-only variables (never `NEXT_PUBLIC_`). Redeploy after registering them.
Do not reuse KIS credentials, GitHub PATs, or Cloudflare secrets.

Redis must support atomic EVAL/INCR/EXPIRE and GET/SET NX EX/DEL. Sessions and
rate limits cannot safely use process memory or Vercel's temporary filesystem:
instances restart and do not share memory. Reuse a suitable existing Redis store
if available. Otherwise creation of a Redis account/database and its pricing
requires the owner's decision; it has **not** been performed. Keep Preview and
Production in separate stores. A store outage prevents new logins and protected
access; logout does not falsely report success if revocation failed.

The hash uses Node's built-in scrypt N=131072, r=8, p=1, random salt,
constant-time comparison. These are the OWASP recommended scrypt fallback
parameters: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html

## Security contract

- New password generation uses the same server-side policy as the hidden-prompt
  script: 8+ characters, at least one English letter and one digit; special
  characters are optional. Existing configured hashes are still verified as-is
  at login; this change does not rotate credentials or invalidate existing sessions.
- Random 256-bit session ID, HMAC signature, credential-bound server record.
- Eight-hour absolute expiry; password/username/session secret rotation revokes
  existing sessions. Logout deletes the server record; replay is rejected.
- Cookie is HttpOnly, Path=/, SameSite=Lax, Secure and `__Host-` in Production.
- Login rotates the session; no localStorage authentication token.
- Atomic rate limit: at most 5 attempts per source and 30 across all sources
  per 15 minutes (successes also count). This protects password hashing resources
  but intentional attacks can temporarily deny login to the sole administrator.
- Only Vercel's overwritten source-IP header is trusted. Other hosting environments
  conservatively share one source bucket; x-forwarded-for cannot bypass limits.
- Login/logout require exact configured Origin and reject cross-site Fetch Metadata.
  GET never changes authentication state. Login JSON body is limited to 4096 bytes.
- Proxy covers all paths, including RSC and static files. Each data route also
  validates authentication independently at the data boundary.
- Private responses are no-store; no credential logging. Source maps are not
  publicly exempted. Only login, auth endpoints, framework code/fonts/CSS,
  favicon, and two audited brand images are anonymous resources.

## Existing routes and automation

All 17 existing API routes require an administrator session: stock, price,
financial, realtime, investor, company-analysis, market-analysis,
intraday-market-analysis, intraday-model-top, top-stocks, model-performance,
model-performance/research, screener, home-dashboard, backtests/rank,
daily-production-status, kis-eod-top-stocks. Authentication does not enable the
KIS publication flag or give web access to the separate private KIS CLI store.

The automation token is read-only and limited to GET top-stocks,
model-performance, daily-production-status. It receives **only reference dates
and publication/freshness status**, not ranks, stocks, returns, or prices.
Daily deployment verification sends this token. Without registering the same
token in GitHub and Vercel the data generation/push steps still run, but protected
deployment verification fails rather than falsely reporting publication success.
No Daily/LIVE computation or Cloudflare trigger policy is changed.

`public/` currently contains only brand images and default SVGs, no raw prices or
snapshots. The two login brand images are allowed; other public paths are gated.
All data stays in server-side `data/`. Auth cannot make historical files already
committed to a **public GitHub repository** confidential: changing repository
visibility/reviewing past disclosures is a separate owner decision, not performed.
Likewise, review and remove access to older unauthenticated Vercel deployments
through Vercel Deployment Protection/retention. A new app release cannot secure
old deployments. No repository or platform access settings were changed here.

## Activation verification

1. Before push, run auth/HTTP tests, relevant API/UI regressions, typecheck, lint,
   build, diff-check. Existing unrelated files must remain unstaged.
2. Register variables and Redis. Register automation token in GitHub. Deploy.
3. Anonymous `/` redirects to `/login`; each API denies access; unknown static
   data URLs and protected image-optimizer URLs do not return data.
4. Real administrator login → home → model/screener/detail; check cookie flags.
5. Logout then replay old cookie: page redirects, API401. Tampered and expired
   cookies are rejected. Wrong ID/password uses the same message; attempts limited.
6. POST login/logout from another origin must be403. Missing env/store must never
   return protected data. Automation token retrieves dates only on its three routes.
7. Check existing Daily deployment verification with the new token and inspect
   older deployment URLs before asserting site-wide confidentiality.

Local HTTP integration uses an isolated in-memory Redis REST **test double** and
ephemeral test credentials in child-process environment only. This is not a
Production store, real administrator account, or KIS/market-data observation.
