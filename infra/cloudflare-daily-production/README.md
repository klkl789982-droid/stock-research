# Tight Budget — 독립 Daily EOD Cron

Cloudflare Cron → 기존 GitHub `daily-production.yml`의 `workflow_dispatch`만 호출한다. 가격 수집·날짜 선택·품질 검증·A~D 계산·성과·승격·Git 게시·Vercel 검증은 기존 workflow가 담당한다. LIVE와 immutable 데이터는 변경하지 않는다.

**현재 배포되지 않았으며 `DISPATCH_ENABLED=false`로 안전하게 비활성화되어 있다.** 계정 인증/배포 승인, 별도의 실제 GitHub 실행 테스트 승인 전에는 deploy·secret 설정·실제 dispatch를 수행하지 않는다. 일반 Git push는 Cloudflare Worker를 배포하지 않는다.

## 실행 시각

기존 GitHub 슬롯보다 8분 늦게 실행하여 동시 요청을 줄인다. Cron은 UTC이고 Cloudflare의 숫자 요일은 GitHub와 다르므로 반드시 `MON-FRI`를 사용한다.

| Cloudflare Cron (UTC) | UTC 월~금 | KST |
| --- | --- | --- |
| `55 9 * * MON-FRI` | 09:55 | 월~금 18:55 |
| `25 11,13,15,17 * * MON-FRI` | 11:25 | 월~금 20:25 |
| 동일 Cron | 13:25 | 월~금 22:25 |
| 동일 Cron | 15:25 | 화~토 00:25 |
| 동일 Cron | 17:25 | 화~토 02:25 |

5개 실행 슬롯을 2개 Cron Trigger로 묶어 계정의 trigger 한도를 절약한다. 현재 Workers Free는 계정당 5개 trigger/호출당 10ms CPU/50 subrequest 제한이 있으므로 기존 계정 사용량과 실제 runtime CPU를 배포 후 확인한다. 코드가 가볍다는 이유로 무료 운영을 보장하거나 유료 전환을 자동 승인하지 않는다.

주말/공휴일 판정이나 날짜 입력을 Worker에 추가하지 않는다. 공급처에 실제 존재하는 공식 거래일만 기존 파이프라인이 판정한다. Cron 변경은 전파에 최대 15분이 걸릴 수 있으므로 다음 슬롯 직전이 아닌 충분히 미리 설정한다. 위 슬롯은 20:30 게시를 보장하지 않으며, 공급·runner 지연은 여전히 게시를 늦출 수 있다.

## API 및 최소 권한

- 대상 고정: `klkl789982-droid/stock-research`, workflow `daily-production.yml`, ref `main`.
- 사전 GET: workflow 활성 상태, 해당 workflow/main의 최근 30개 run 중 실행·대기 상태 확인. 활성 run이 있으면 건너뛴다. 이 검사는 분산 잠금이 아니라 최선의 중복 요청 방지다.
- POST: `https://api.github.com/repos/klkl789982-droid/stock-research/actions/workflows/daily-production.yml/dispatches`.
- JSON: `{"ref":"main","return_run_details":true}`. `return_run_details`는 GitHub API 옵션이며 workflow input이 아니다. `inputs`/기준일을 보내지 않는다.
- 헤더: Bearer Secret, GitHub JSON Accept, API version `2026-03-10`, User-Agent. Redirect를 따라가지 않는다.
- fine-grained PAT: 소유자 `klkl789982-droid`, **Only select repositories → stock-research**, **Actions: Read and write**. Metadata read는 GitHub 기본 권한이다. Contents write, Workflows write, 관리자/다른 저장소 권한을 추가하지 않는다. 데이터 commit/push는 기존 workflow의 `GITHUB_TOKEN`이 담당한다.
- PAT 값은 Cloudflare **Secret `GITHUB_ACTIONS_TOKEN`**에만 저장한다. vars/config/코드/.env/.dev.vars/로그/커밋에 저장하지 않는다. 토큰 만료/회전은 사용자가 관리한다.

## 성공 구분과 오류

| Worker 결과 | 의미 | 의미하지 않는 것 |
| --- | --- | --- |
| `DISPATCH_ACCEPTED` | HTTP 200 + 유효 run ID 또는 호환 204로 요청 수락 | workflow 계산 성공, 새 EOD 승격, 사이트 게시 성공 |
| `SKIPPED / WORKFLOW_ALREADY_ACTIVE` | 기존 실행/대기 run 발견 | 그 run의 성공 보장 |
| `SKIPPED / DISPATCH_DISABLED` | 안전 스위치 꺼짐 | 실제 운영 활성화 |
| `FAILED` | secret/권한/응답/요청 오류; Cron 호출 실패로 기록 | 기존 데이터 삭제/대체 |
| `OUTCOME_UNKNOWN` | POST 응답 불명확; 수락 여부 미확정; Cron 호출 실패로 기록 | 실패 확정 또는 무조건 재전송 |

`workflowStatus`와 `publicationStatus`는 항상 `NOT_VERIFIED`다. `runId`가 있으면 Actions에서 실제 conclusion과 승격·push·Vercel verifier 결과를 확인한다. 204는 run ID가 없으므로 실행 목록을 확인해야 한다. 기존 workflow의 `NO_NEW_OFFICIAL_EOD` 성공은 새로운 거래일 게시와 다르다.

GET의 network/timeout/5xx/rate limit은 최대 3회, 1초/2초 backoff로 재시도한다. 모든 요청 timeout은 10초다. POST는 **명시적 rate-limit 거절**만 최대 3회, 각 재시도 전에 활성 run을 다시 확인한다. Retry-After/reset은 최대 30초 내에서만 기다리고 초과/잘못된 값은 다음 슬롯으로 넘긴다. 인증 401/권한 403/404/422는 반복하지 않는다. POST network/timeout/5xx/잘못된 2xx는 이미 수락됐을 수 있어 즉시 재시도하지 않는다.

로그는 cron, 예정 UTC 시각, 단계, 상태, 안전한 오류 코드, attempt/delay, run ID만 남긴다. token/헤더/전체 요청·응답/예외 원문은 출력하지 않는다. 장애 시 처리한 호출만 로그에 남으므로 **모든 Cloudflare 슬롯이 누락되면 Worker 자신의 로그만으로 감지할 수 없다**. Cron Past Events/Workers Logs와 기존 Actions/사이트 운영 API를 함께 점검한다.

## 중복/누락 안전성

- 같은 isolate의 동일 cron+scheduledTime 재전달은 한 POST로 합친다. 영구/분산 exactly-once 보장은 아니며 새 isolate에서 replay는 발생할 수 있다.
- GitHub native schedule과 외부 dispatch는 같은 `daily-production-refs/heads/main` concurrency 그룹, `cancel-in-progress:false`를 공유한다. Worker가 GitHub runner를 우회하지는 않는다.
- 동일 공식 거래일은 기존 NO_NEW/hash/immutable 정책으로 보호되고, 검증 성공 시에만 allowlist 데이터를 stage한다. 새로운 후보는 기존 non-force fetch/rebase/push를 거친다.
- GET와 POST 사이 경쟁, queued event의 옛 SHA checkout은 완전히 제거되지 않는다. 기존 immutable/hash 또는 rebase 충돌은 덮어쓰는 대신 중단하지만 중복 수집/안전한 실패가 날 수 있다. 모든 중복 실행이 성공적인 no-op이라고 주장하지 않는다.
- 한 슬롯이 누락/실패해도 이후 슬롯은 독립적으로 자동 기준일 판정을 요청한다. 기존 260행 거래일 목록에서 가장 오래된 누락일 하나를 처리하며 다음 실행이 나머지를 복구한다. 모든 슬롯 누락·GitHub runner 전체 장애·공식 공급 지연은 보장 해결하지 못한다.
- 외부 dispatch는 기존 status에 `trigger=workflow_dispatch`와 `lastAttemptAt`으로 남는다. `lastAutomaticRunAt`은 GitHub native schedule만 집계하므로 Cloudflare 자동 실행은 Worker scheduled 로그로 별도 확인한다. 기존 API 계약을 변경하지 않는다.

## 로컬 검증 (실제 요청 없음)

이 디렉터리에서 `npm test`, `npm run check`를 실행한다. 별도 npm 설치가 필요 없으며 모든 outbound 요청은 mock이다. 실제 Secret을 로컬 테스트에 넣지 않는다. Wrangler local scheduled 테스트도 실제 Secret을 넣으면 실요청할 수 있으므로 승인 전에는 실행하지 않는다.

## 사용자 Cloudflare 설정 절차 — 승인 후 수행

1. Cloudflare 계정/Worker 운영 권한과 사용할 요금제를 사용자가 확인한다. 이 작업은 가입·요금제 변경·credential 생성을 하지 않았다. 저장소 자동 배포 연동도 새로 만들지 않았다.
2. GitHub에서 위 최소 권한의 fine-grained PAT를 직접 생성하고 유효기간을 정한다. 값을 Codex/채팅에 붙여넣지 않는다.
3. 이 디렉터리에서 사용자 PC의 Wrangler 4로 로그인한다: `npm exec --yes --package=wrangler@4 -- wrangler login`. CLI 사용 시 Cloudflare 권한 요청 범위를 확인한다. 이 문서의 명령은 이번 작업에서 실행하지 않았다.
4. **배포 승인 후**, `DISPATCH_ENABLED=false`를 유지한 채 `npm exec --yes --package=wrangler@4 -- wrangler secret put GITHUB_ACTIONS_TOKEN`의 숨겨진 입력 프롬프트에 PAT를 넣는다. 이 명령은 Worker 버전을 생성/배포할 수 있으므로 승인 전 실행 금지. Secret은 dashboard의 Variables and Secrets에서 Type=Secret으로도 설정 가능하다.
5. `npm exec --yes --package=wrangler@4 -- wrangler deploy`로 승인된 코드를 배포한다. `workers_dev=false`, preview URL 꺼짐, Cron 2개(총 5슬롯), Workers Logs 설정을 확인한다. 공개 HTTP dispatch endpoint는 없으며 fetch는 404만 반환한다. 이 단계까지는 실제 dispatch 비활성 상태다.
6. **실제 GitHub 실행 테스트에 별도 명시적 승인한 다음**, `wrangler.jsonc`의 `DISPATCH_ENABLED`를 `true`로 바꾸고 배포한다. 다음 Cron 슬롯을 사용한 실테스트도 실제 API 실행 요청이다. 값의 운영 변경은 저장소 config와 일치시키며 token은 절대 config에 넣지 않는다.
7. Cron Past Events의 DISPATCH_ACCEPTED/run ID → GitHub 실제 run conclusion → 후보/승격/push → Vercel/API 기준일을 순서대로 확인한다. no-new이면 점검 상태 게시만 확인하고 신규 EOD 성공으로 계산하지 않는다.
8. 비상 중지: `DISPATCH_ENABLED=false`로 배포. Cron 자체 제거가 필요하면 `triggers.crons=[]`로 배포한다. Secret 만료/회전 후 안전한 시간에 승인된 실제 테스트를 재수행한다.

미검증: 실제 Cloudflare 번들/runtime·Cron 전달·Secret 권한·GitHub 실요청·runner·실거래일 데이터/승격·Vercel/API end-to-end. Cloudflare 배포와 실제 dispatch 승인이 필요한 상태이며 운영 완료로 보고하지 않는다.

### 공식 근거

- [Cloudflare Cron UTC/요일/전파](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
- [Cloudflare Secret 관리](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare 계정/CPU 한도](https://developers.cloudflare.com/workers/platform/limits/)
- [GitHub workflow dispatch와 Actions 권한](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [GitHub return_run_details/200·204](https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids/)
