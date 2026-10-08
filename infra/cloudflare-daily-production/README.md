# Tight Budget — 독립 Daily EOD Cron

Cloudflare Cron → 기존 GitHub `daily-production.yml`의 `workflow_dispatch`만 호출한다. 가격 수집·날짜 선택·품질 검증·A~D 계산·성과·승격·Git 게시·Vercel 검증은 기존 workflow가 담당한다. LIVE와 immutable 데이터는 변경하지 않는다.

배포 대상은 사용자가 생성한 **`tight-budget-eod-scheduler`**의 기본 Production 환경이다. 이미 등록된 Secret **`GITHUB_TOKEN`**을 그대로 사용한다. `--env production`으로 다른 suffix Worker를 만들지 않는다.

`DISPATCH_ENABLED=false`로 실제 GitHub 요청은 비활성화되어 있다. Cron을 등록·배포해도 별도 실제 dispatch 승인 전에는 이 스위치를 켜지 않는다. 일반 Git push는 Cloudflare Worker를 배포하지 않는다. 실제 배포 결과는 Wrangler/Cloudflare의 버전·Cron·Secret 이름 목록으로 확인하며 코드 설정만으로 배포 완료라고 판단하지 않는다.

## 실행 시각

당일 확인은 **15:40 KST부터 30분 간격**으로 앞당긴다. 현재 공급처의 다음 영업일 오후 공급을 빨리 감지하기 위해 **13:10~15:10 KST에는 이전 거래일 복구 확인**을 추가한다. Cron은 UTC이고 Cloudflare의 숫자 요일은 GitHub와 다르므로 반드시 `MON-FRI`를 사용한다.

| Cloudflare Cron (UTC) | UTC 월~금 | KST |
| --- | --- | --- |
| `10,40 4-17 * * MON-FRI` (이전 거래일 복구) | 04:10~06:10, 매 30분 | 월~금 13:10~15:10 |
| 동일 Cron (당일 장 마감 이후 확인) | 06:40~14:40, 매 30분 | 월~금 15:40~23:40 |
| 동일 Cron (야간 재시도) | 15:10~17:40, 매 30분 | 화~토 00:10~02:40 |

UTC 평일당 28개 실행 슬롯을 1개 Cron Trigger로 묶는다(이전 거래일 확인 5회 + 당일/야간 확인 23회). 현재 Workers Free는 계정당 5개 trigger/호출당 10ms CPU/50 subrequest 제한이 있으므로 기존 계정 사용량과 실제 runtime CPU를 배포 후 확인한다. 코드가 가볍다는 이유로 무료 운영을 보장하거나 유료 전환을 자동 승인하지 않는다.

주말/공휴일 판정이나 날짜 입력을 Worker에 추가하지 않는다. 공급처에 실제 존재하는 공식 거래일만 기존 파이프라인이 판정한다. Cron 변경은 전파에 최대 15분이 걸릴 수 있으므로 다음 슬롯 직전이 아닌 충분히 미리 설정한다. 예약을 앞당기는 것만으로 공급 시각을 앞당기거나 GitHub runner 대기를 제거하지 못한다.

### 공식 공급 시각과 게시 목표의 한계

- 현재 공식 공급처는 금융위원회/공공데이터포털 `getStockPriceInfo`다. [주식시세정보 공식 안내](https://www.data.go.kr/data/15094808/openapi.do)는 **기준일 다음 영업일 13시 이후 갱신**을 명시한다. [금융위원회 FAQ](https://www.fsc.go.kr/in060501)도 다음 날 새벽 연계·정제 후 13시 이후 개방 및 주말/공휴일 이연을 설명한다. 페이지의 일반적인 ‘실시간’ 메타데이터와 달리 상세 제공 정책은 실시간이 아니다. 기존 `lib/source-availability.mjs`의 동일한 공급 정책은 변경하지 않는다.
- 따라서 **현재 공급처로 당일 16:00~16:30 게시 목표를 충족한다고 보고할 수 없다**. 당일 데이터가 없으면 기존 `NO_NEW_OFFICIAL_EOD`가 553종목 수집 전에 안전하게 종료하고 후속 슬롯이 다시 확인한다. 이전 거래일 자료가 뒤늦게 공급되면 실제 응답의 `basDt`로 기존 순차 복구를 진행한다.
- 저장된 6개 PROMOTED manifest 모두 `sourcePublishedAt=null`이다. 10/07 EOD는 10/08 15:30:53~15:37:38 KST에 관측되고 15:38:32에 승격됐다. 이는 최초 공급 시각이 아닌 시스템 관측 시각이다.
- 2026-10-09 03:57 KST 읽기 전용 재조회: canonical unbounded 260행 최신 `basDt=20261007`, 정확한 10/08 대표 종목 조회는 HTTP 200/business success/0건이었다. 데이터·manifest·snapshot을 생성하거나 수정하지 않았다. 전체 시장 10/08 0건의 이전 관측은 `docs/daily-eod-operating-evidence.md`에 별도로 보존돼 있다.
- 관측된 후보 수집·검증·계산은 **6분 28초~7분 48초**이며 runner 시작/설치/push/Vercel 배포 시간은 제외된다. 새 슬롯에서는 **공급 후 다음 확인까지 0~30분 + 이 처리 시간 + runner·배포 시간**이 필요하다(확인 시간대 밖의 공급은 더 늦을 수 있다). 다음 영업일 13시까지 공급됐다면 13:10 확인 후 약 13:17~13:18부터 계산 완료가 가능하다는 조건부 추정이지 게시 보장이나 실제 최초 공급 확인은 아니다.
- 당일 게시가 필수라면 당일 확정 일봉을 제공하는 별도 소스의 데이터 계약·권한·이용 조건부터 승인해야 한다. 이 변경에서 KIS 장중 가격을 공식 EOD로 대체하거나 새 공급처를 추가하지 않는다.

## API 및 최소 권한

- 대상 고정: `klkl789982-droid/stock-research`, workflow `daily-production.yml`, ref `main`.
- 사전 GET: workflow 활성 상태, 해당 workflow/main의 최근 30개 run 중 실행·대기 상태 확인. 활성 run이 있으면 건너뛴다. 이 검사는 분산 잠금이 아니라 최선의 중복 요청 방지다.
- 이어서 기존 배포 검증기를 재사용해 공개 사이트의 TOP/성과/운영 API를 확인한다. 세 기준일이 해당 예약의 session 날짜와 같고 게시 상태가 `published`/`unchanged`면 `SESSION_ALREADY_PUBLISHED`로 건너뛴다. 야간 슬롯은 UTC 날짜가 직전 KST session 날짜다. 이 날짜는 중복 확인용이며 GitHub에 전달하거나 EOD 후보로 강제하지 않는다. 30분 이상 지연된 이벤트, API 장애·JSON 오류·기준일 불일치에는 건너뛰지 않고 기존 공식 probe를 요청한다. 사이트 요청에 GitHub Authorization을 보내지 않는다.
- POST: `https://api.github.com/repos/klkl789982-droid/stock-research/actions/workflows/daily-production.yml/dispatches`.
- JSON: `{"ref":"main","return_run_details":true}`. `return_run_details`는 GitHub API 옵션이며 workflow input이 아니다. `inputs`/기준일을 보내지 않는다.
- 헤더: Bearer Secret, GitHub JSON Accept, API version `2026-03-10`, User-Agent. Redirect를 따라가지 않는다.
- fine-grained PAT: 소유자 `klkl789982-droid`, **Only select repositories → stock-research**, **Actions: Read and write**. Metadata read는 GitHub 기본 권한이다. Contents write, Workflows write, 관리자/다른 저장소 권한을 추가하지 않는다. 데이터 commit/push는 기존 workflow의 `GITHUB_TOKEN`이 담당한다.
- PAT 값은 Cloudflare **Secret `GITHUB_TOKEN`**에만 저장한다. vars/config/코드/.env/.dev.vars/로그/커밋에 저장하지 않는다. 기존 Secret 값은 읽거나 덮어쓰지 않는다. 토큰 만료/회전은 사용자가 관리한다.

## 성공 구분과 오류

| Worker 결과 | 의미 | 의미하지 않는 것 |
| --- | --- | --- |
| `DISPATCH_ACCEPTED` | HTTP 200 + 유효 run ID 또는 호환 204로 요청 수락 | workflow 계산 성공, 새 EOD 승격, 사이트 게시 성공 |
| `SKIPPED / WORKFLOW_ALREADY_ACTIVE` | 기존 실행/대기 run 발견 | 그 run의 성공 보장 |
| `SKIPPED / SESSION_ALREADY_PUBLISHED` | 공개 TOP·성과·운영 API에서 해당 session의 기존 게시 확인 | 새 workflow 실행 성공 또는 공급처 최신일을 직접 조회한 것 |
| `SKIPPED / DISPATCH_DISABLED` | 안전 스위치 꺼짐 | 실제 운영 활성화 |
| `FAILED` | secret/권한/응답/요청 오류; Cron 호출 실패로 기록 | 기존 데이터 삭제/대체 |
| `OUTCOME_UNKNOWN` | POST 응답 불명확; 수락 여부 미확정; Cron 호출 실패로 기록 | 실패 확정 또는 무조건 재전송 |

`workflowStatus`는 항상 `NOT_VERIFIED`다. `publicationStatus`는 기존 게시를 세 API로 확인한 건너뛰기에서만 `VERIFIED_EXISTING`, 그 외에는 `NOT_VERIFIED`다. `runId`가 있으면 Actions에서 실제 conclusion과 승격·push·Vercel verifier 결과를 확인한다. 204는 run ID가 없으므로 실행 목록을 확인해야 한다. 기존 workflow의 `NO_NEW_OFFICIAL_EOD` 성공은 새로운 거래일 게시와 다르다.

GET의 network/timeout/5xx/rate limit은 최대 3회, 1초/2초 backoff로 재시도한다. 모든 요청 timeout은 10초다. POST는 **명시적 rate-limit 거절**만 최대 3회, 각 재시도 전에 활성 run을 다시 확인한다. Retry-After/reset은 최대 30초 내에서만 기다리고 초과/잘못된 값은 다음 슬롯으로 넘긴다. 인증 401/권한 403/404/422는 반복하지 않는다. POST network/timeout/5xx/잘못된 2xx는 이미 수락됐을 수 있어 즉시 재시도하지 않는다.

로그는 cron, 예정 UTC 시각, 단계, 상태, 안전한 오류 코드, attempt/delay, run ID만 남긴다. token/헤더/전체 요청·응답/예외 원문은 출력하지 않는다. 장애 시 처리한 호출만 로그에 남으므로 **모든 Cloudflare 슬롯이 누락되면 Worker 자신의 로그만으로 감지할 수 없다**. Cron Past Events/Workers Logs와 기존 Actions/사이트 운영 API를 함께 점검한다.

## 중복/누락 안전성

- 같은 isolate의 동일 cron+scheduledTime 재전달은 한 POST로 합친다. 영구/분산 exactly-once 보장은 아니며 새 isolate에서 replay는 발생할 수 있다.
- GitHub native schedule과 외부 dispatch는 같은 `daily-production-refs/heads/main` concurrency 그룹, `cancel-in-progress:false`를 공유한다. Worker가 GitHub runner를 우회하지는 않는다.
- 동일 공식 거래일은 기존 NO_NEW/hash/immutable 정책으로 보호되고, 검증 성공 시에만 allowlist 데이터를 stage한다. 새로운 후보는 기존 non-force fetch/rebase/push를 거친다.
- 이미 현재 session을 게시한 경우의 사이트 guard와 달리, 공급 최신일이 이전 session인 경우에는 새로운 공급이 도착했는지 알 수 없으므로 probe를 계속 요청한다. NO_NEW 상태 게시/배포가 반복될 수 있으나 553종목 재계산은 하지 않는다. 사이트 장애가 공급 복구를 막지 않도록 사이트 확인 실패는 안전한 코드만 기록하고 GitHub 경로를 유지한다.
- GET와 POST 사이 경쟁, queued event의 옛 SHA checkout은 완전히 제거되지 않는다. 기존 immutable/hash 또는 rebase 충돌은 덮어쓰는 대신 중단하지만 중복 수집/안전한 실패가 날 수 있다. 모든 중복 실행이 성공적인 no-op이라고 주장하지 않는다.
- 한 슬롯이 누락/실패해도 이후 슬롯은 독립적으로 자동 기준일 판정을 요청한다. 기존 260행 거래일 목록에서 가장 오래된 누락일 하나를 처리하며 다음 실행이 나머지를 복구한다. 모든 슬롯 누락·GitHub runner 전체 장애·공식 공급 지연은 보장 해결하지 못한다.
- 외부 dispatch는 기존 status에 `trigger=workflow_dispatch`와 `lastAttemptAt`으로 남는다. `lastAutomaticRunAt`은 GitHub native schedule만 집계하므로 Cloudflare 자동 실행은 Worker scheduled 로그로 별도 확인한다. 기존 API 계약을 변경하지 않는다.

## 로컬 검증 (실제 요청 없음)

이 디렉터리에서 `npm test`, `npm run check`를 실행한다. 별도 npm 설치가 필요 없으며 모든 outbound 요청은 mock이다. 실제 Secret을 로컬 테스트에 넣지 않는다. Wrangler local scheduled 테스트도 실제 Secret을 넣으면 실요청할 수 있으므로 승인 전에는 실행하지 않는다.

## 사용자 Cloudflare 설정 절차 — 승인 후 수행

1. Cloudflare 계정/Worker 운영 권한과 사용할 요금제를 사용자가 확인한다. 이 작업은 가입·요금제 변경·credential 생성을 하지 않았다. 저장소 자동 배포 연동도 새로 만들지 않았다.
2. 사용자가 기존 Worker의 Production Secret `GITHUB_TOKEN`을 등록한 상태라면 재생성/재입력하지 않는다. 기존 PAT의 저장소 범위·권한·유효기간만 사용자가 확인한다. 값을 Codex/채팅에 붙여넣지 않는다.
3. 이 디렉터리에서 사용자 PC의 Wrangler 4로 로그인한다: `npm exec --yes --package=wrangler@4 -- wrangler login`. CLI 사용 시 Cloudflare 권한 요청 범위를 확인한다. 이 문서의 명령은 이번 작업에서 실행하지 않았다.
4. `npm exec --yes --package=wrangler@4 -- wrangler whoami`로 인증을 확인한 뒤 `npm exec --yes --package=wrangler@4 -- wrangler secret list --name tight-budget-eod-scheduler`로 Secret **이름/타입만** 확인한다. `secret put/bulk/delete`, `--secrets-file`은 사용하지 않는다. 배포는 기존 Secret을 유지한다.
5. `npm exec --yes --package=wrangler@4 -- wrangler deploy`로 승인된 코드를 배포한다. `workers_dev=false`, preview URL 꺼짐, Cron 1개(UTC 평일 총 28슬롯), Workers Logs 설정을 확인한다. 공개 HTTP dispatch endpoint는 없으며 fetch는 404만 반환한다. 이 단계까지는 실제 dispatch 비활성 상태다.
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
