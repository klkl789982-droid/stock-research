# Daily Worker publication-contract repair

Local implementation, 2026-10-16. The previous 14:00/swing recovery ZIP is preserved unchanged. No remote deployment, workflow dispatch, source collection, credential, permission, account or schedule change occurred.

## Finding

The four failures shared a real production call-contract regression, plus outdated tests. They were not an execution-environment limitation.

`inspectDailyProductionDeployment` requires an expected reference date, canonical snapshot hash and deployed commit SHA. The Worker supplied only the date. The verifier therefore returned `{matches:false, reason:"EXPECTED_IDENTITY_MISSING", actual:null}` before any site request. The caller then dereferenced `actual.publicationStatus`; its catch converted that exception into an unavailable precheck and continued dispatching.

This did not fabricate a successful publication or delete existing data. It disabled the optional already-published-session guard, allowing unnecessary workflow requests. Existing active-run checks, same-isolate replay suppression and immutable data protection still applied. The code findings do not prove how often the deployed Worker exhibited this behavior.

Tests still supplied three unauthenticated date-only DTOs. The current contract has four protected APIs, including Home, and requires exact identity/readiness. Thus changing only the expected request count would not repair the feature.

## Four failures and reproduction

Run from the repository root with the existing trusted Node installation. All HTTP requests in these tests are synthetic fixtures.

| Original failing case | Focused reproduction command | Cause and repaired coverage |
| --- | --- | --- |
| Already published session | `node --test --test-name-pattern='^already published session' infra/cloudflare-daily-production/test/worker.test.mjs` | Missing independent expected identity made the site path unreachable. Now trusted exact Actions job evidence plus four authenticated exact DTOs permits skip; date-only or publicationStatus-only claims do not. |
| Site HTTP/JSON/network/timeout recovery | `node --test --test-name-pattern='^site HTTP/JSON/network/timeout' infra/cloudflare-daily-production/test/worker.test.mjs` | Tests expected three actual site reads but the verifier returned before reading. Now valid independent proof enters all four reads, exercises each failure, preserves canonical dispatch and sanitizes logs. |
| Sibling request cancellation | `node --test --test-name-pattern='^one failed site API' infra/cloudflare-daily-production/test/worker.test.mjs` | No request was started, so expected cancellations were zero. Now one failed API aborts the other three before POST; credentials and exceptions remain absent from logs. |
| Overnight and delayed event | `node --test --test-name-pattern='^overnight slots' infra/cloudflare-daily-production/test/worker.test.mjs` | Overnight proof could never pass; the old mock had no fallback POST and failed. Now exact overnight session proof skips; the 30-minute delayed boundary intentionally performs no jobs/site guard and re-probes without injecting a data date. |

Full regression, with no filtered or skipped cases:

```sh
node --test infra/cloudflare-daily-production/test/worker.test.mjs
node scripts/test-cloudflare-daily-runtime.mjs
node scripts/test-daily-production-deployment-verifier.mjs
node scripts/test-daily-publication-status.mjs
```

The original exact-base suite was 18/22. The revised suite is 28/28, with zero skipped cases. Added negatives cover every endpoint's wrong date/hash/SHA/readiness, all four returning the same wrong identity, absent/malformed/ambient credentials, untrusted or failed runs, malformed/duplicate/future/failed job evidence, missing verifier, unavailable jobs and bounded retry, and refusing fallback to older proof after the selected proof fails.

## Implementation

1. Existing GITHUB_TOKEN-only deployments continue canonical dispatch and explicitly report `SITE_AUTH_UNAVAILABLE`; they do not attempt site reads or claim verified publication. No site token was registered by this change.
2. Only when a separately approved site-read token is already available, read the newest trusted completed successful Daily run's exact-attempt jobs using the existing Actions-read scope. Validate repository, actor, workflow, branch, run/attempt/source SHA, verifier and marker outcomes/timing.
3. Use that independent marker's expected date/hash/deployed SHA for the unchanged strict four-API comparison. Send the site token only to the fixed site and the GitHub token only to the fixed GitHub repository. Never use a token from ambient Node process.env in the Worker.
4. Missing/malformed/failed proof, site mismatch or unavailable site remains an explicit unverified precheck followed by canonical recovery. Malformed job structures cannot throw past that recovery boundary.
5. Separate crypto-free identity checks and pure metadata parsing from Node hash generation and the application's network loader. The Worker does not import the broader GitHub contents/head/status reader and needs no new repository scope.

An additional actual compatibility defect was identified in the prior import graph: it pulled in `node:crypto`, despite the Worker lacking Node compatibility settings. The new local VM test loads the actual five-module graph using Web APIs only, without process, Buffer or Node built-ins, and exercises both credential-free recovery and exact authenticated proof. It does not claim a real deployed Cloudflare execution. No nodejs_compat setting or dependency installation was added.

## Operating limits

Local code/tests are repaired. The deployed Worker has not been updated. Existing GITHUB_TOKEN-only configuration cannot use protected site comparison and will safely keep probing; activating optional site-read access would require a separate explicit approval to configure existing credentials. No such change is part of this work. Scheduling and new source availability remain independent, and exact production proof still requires an authorized deployment and real observation.
