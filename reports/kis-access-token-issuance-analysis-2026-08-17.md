# KIS 접근토큰 반복 발급 분석

- 작성일: 2026-08-17
- 대상: 현재 `stock-research` 프로젝트
- 분석 방식: 로컬 소스 정적 분석
- 미수행: 코드 변경, KIS/외부 API 호출, production 데이터 생성, snapshot/resolver 실행
- 선행 보고서: `reports/search-read-model-architecture-analysis-2026-08-17.md`

## 핵심 결론

카카오톡의 반복적인 “접근토큰이 발급되었습니다” 알림은 현재 코드 구조로 설명된다.

- 운영 API route인 `/api/realtime`과 `/api/investor`가 각각 자체 `getAccessToken()`을 가지고 있다.
- 두 함수 모두 **route 요청이 들어올 때마다** KIS `/oauth2/tokenP`를 호출한다.
- token cache, expiry, refresh window, single-flight가 없다.
- 종목 검색 1회 직후 realtime 1회 + investor 1회로 최소 2회 발급된다.
- realtime은 선택 종목이 유지되는 동안 5초마다 호출되므로 1분에 약 12회가 추가된다.
- 따라서 검색 직후 1분 동안 단일 브라우저 탭 기준 최대 약 14회 토큰 발급 요청이 발생할 수 있다.

기업분석·시장분석 탭 클릭 자체는 token 발급 함수를 호출하지 않는다. 다만 polling이 activeTab과 무관하게 계속되므로, 사용자는 탭을 보는 동안에도 발급 알림을 계속 받는다.

가장 작은 안전한 해결책은 서버 전용 공용 KIS token manager를 추가하고 모든 KIS route가 이를 공유하게 하는 것이다. token은 메모리 또는 서버 전용 공유 cache에만 저장하고 브라우저·응답·로그·Git·JSON에 노출하지 않아야 한다.

---

## 1. KIS 접근토큰 발급 파일과 함수

전체 프로젝트에서 KIS `/oauth2/tokenP`를 직접 호출하는 위치는 4개다.

| 구분 | 파일 | 함수 | 호출 단위 | 운영 화면 영향 |
|---|---|---|---|---|
| API route | `app/api/realtime/route.ts` | `getAccessToken()` | realtime GET마다 1회 | 직접 영향 |
| API route | `app/api/investor/route.ts` | `getAccessToken()` | investor GET마다 1회 | 직접 영향 |
| 검증 스크립트 | `scripts/compare-technical-models.mjs` | `getToken()` | 스크립트 실행당 1회 | 웹 화면에는 영향 없음 |
| 검증 스크립트 | `scripts/validate-technical-sample.mjs` | `getKisToken()` | 스크립트 실행당 1회 | 웹 화면에는 영향 없음 |

두 검증 스크립트는 한 번 발급한 token을 반복 종목 조회에 재사용한다. 현재 반복 알림의 핵심 원인은 이 스크립트가 아니라 두 API route다.

### 운영 API route의 구조

```text
GET /api/realtime
  → realtime route의 getAccessToken()
  → POST KIS /oauth2/tokenP
  → GET KIS inquire-price

GET /api/investor
  → investor route의 별도 getAccessToken()
  → POST KIS /oauth2/tokenP
  → GET KIS investor-trend-estimate
```

route 간에 공통 모듈이나 token state를 공유하지 않는다.

## 2. 검색·탭·polling 호출 경로와 예상 횟수

### 2.1 성공한 종목 검색 1회

`app/page.tsx`의 `handleSearch()`가 검색 결과 종목을 선택하면 다음이 실행된다.

1. `fetch(/api/realtime?code=...)`
2. realtime route가 token 1회 발급
3. `stockInfo` 변경으로 investor effect 실행
4. `fetch(/api/investor?code=...)`
5. investor route가 token 1회 발급

따라서 성공한 검색 1회당 **즉시 최소 2회** 발급된다.

공공데이터 `/api/stock`, `/api/price`와 DART `/api/financial`은 KIS token을 발급하지 않는다.

### 2.2 5초 polling

`stockInfo`가 존재하면 effect가 `setInterval(..., 5000)`을 등록한다. interval은 매번 `/api/realtime`을 호출하고 realtime route는 매 요청마다 token을 새로 발급한다.

| 선택 종목 유지 시간 | 검색 직후 | polling 발급 | investor | 예상 합계 |
|---:|---:|---:|---:|---:|
| 즉시 | 1 | 0 | 1 | 2 |
| 30초 | 1 | 약 6 | 1 | 약 8 |
| 1분 | 1 | 약 12 | 1 | 약 14 |
| 5분 | 1 | 약 60 | 1 | 약 62 |

브라우저 탭·사용자·서버 instance가 늘면 거의 선형으로 증가한다. 두 브라우저 탭이 같은 종목을 열고 1분 유지하면 공용 cache가 없으므로 약 28회의 발급 요청이 가능하다.

### 2.3 기업분석·시장분석 탭 클릭

- 기업분석 클릭: `setActiveTab("investor")`만 실행
- 시장분석 클릭: `setActiveTab("trader")`만 실행
- 클릭 자체의 token 발급: **0회**
- 그러나 activeTab과 무관하게 realtime interval은 계속 동작: **5초마다 1회**

탭 클릭으로 렌더가 다시 일어나도 `stockInfo` 객체가 바뀌지 않으면 polling effect dependency는 바뀌지 않으므로 interval을 새로 만들지 않는다. 사용자가 탭 클릭과 발급 알림을 연관해서 느끼는 이유는 background polling이 지속되기 때문이다.

### 2.4 동일 종목 재검색

동일한 code여도 `/api/stock` 결과로 새 `stockInfo` 객체가 설정된다. 기존 effect cleanup 후 새 effect가 생기고 investor 요청과 realtime 즉시 요청이 다시 실행된다. 따라서 같은 종목 재검색도 최소 2회의 신규 발급을 유발한다.

## 3. API route별 개별 발급 여부

그렇다. 현재 두 KIS API route는 완전히 독립적이다.

- 서로 다른 `getAccessToken()` 구현
- module-level cached token 없음
- 공용 expiry 없음
- 공용 in-flight Promise 없음
- 한 route에서 받은 token을 다른 route가 알 수 없음

realtime route의 token fetch에는 `cache: "no-store"`가 명시돼 있다. investor route에는 fetch cache 옵션이 없지만 POST token 요청을 application token cache로 사용하는 코드가 없으므로 공유된다고 볼 수 없다.

## 4. 기존 token cache와 저장 위치

운영 API route에는 token cache가 없다.

| 저장 후보 | 현재 상태 |
|---|---|
| React/browser state | 저장하지 않음 — 정상 |
| API 응답 | token을 반환하지 않음 — 정상 |
| module memory | 없음 |
| `globalThis` | 없음 |
| Redis/KV/DB | 없음 |
| JSON/data 파일 | 없음 — 정상 |
| environment variable | app key/secret만 존재, access token 없음 |

검증 스크립트는 실행 중 지역 변수 `token`에만 저장하고 프로세스 종료 시 사라진다. 이는 웹 route 간 공유 cache가 아니다.

## 5. token 만료시간 관리 여부

관리하지 않는다.

- token 응답의 만료 관련 필드를 읽지 않음
- `expiresAt` 계산 없음
- 만료 5분 전 refresh 없음
- cache 자체가 없어 모든 요청을 신규 발급으로 처리
- token이 아직 유효한지 검사하지 않음

KIS token 응답의 실제 만료 필드 이름과 단위는 향후 구현 전 공식 계약/실제 안전한 fixture로 확정해야 한다. 현재 프로젝트에는 이를 검증하는 schema나 fixture가 없다. 필드가 없거나 파싱할 수 없을 때 임의로 장기 유효하다고 가정해서는 안 된다.

## 6. 동시 요청 시 중복 발급 가능성

매우 높다.

검색 직후 `/api/realtime`과 `/api/investor`가 거의 동시에 실행될 수 있고, 각각 token endpoint를 호출한다. 여러 요청이 같은 route에 동시에 들어와도 다음 보호가 없다.

- token cache double-check
- in-flight Promise 공유
- mutex
- distributed lock
- app key 단위 발급 제한

예를 들어 token이 없는 상태에서 realtime 10건과 investor 10건이 동시에 들어오면 현재 구조상 최대 20건의 token 발급 요청이 동시에 실행될 수 있다.

## 7. React Strict Mode·중복 effect·polling 영향

### 확인된 구조

- `next.config.ts`에 `reactStrictMode` 명시 설정은 없음
- App Router/개발 환경의 React 개발 검사는 effect setup/cleanup을 추가 실행할 수 있음
- realtime effect는 `stockInfo`에 의존
- investor effect도 `stockInfo`에 의존
- event handler인 `handleSearch()`는 Strict Mode 때문에 자동 두 번 호출되는 함수는 아님

초기 mount 시 `stockInfo`가 null이므로 두 effect는 즉시 외부 요청을 하지 않는다. 종목 선택 후 dependency 변경 effect가 개발 환경에서 정확히 몇 번 실행되는지는 React/Next 개발 동작과 Fast Refresh/remount 조건에 영향을 받는다. 다만 현재 cleanup이 realtime interval에는 존재하므로 정상적인 effect 재실행 시 이전 interval은 해제된다.

중복 발급의 주원인은 Strict Mode가 아니라 다음이다.

1. realtime/investor route가 각각 token 발급
2. realtime 5초 polling
3. 동일 종목 재검색
4. 여러 브라우저 탭/사용자
5. 개발 Fast Refresh 또는 component remount

investor effect에는 AbortController나 request ID/code 일치 보호가 없으므로 빠른 종목 전환 시 오래된 요청이 남을 수 있다. 이는 token 추가 발급과 stale 수급 응답 위험을 함께 만든다.

## 8. 401·403·rate limit·일반 오류 처리

현재는 어떤 일반 오류도 “token 만료”로 판정해 재발급하지 않는다. 즉 **잘못 재발급하는 분기 자체는 아직 없다.** 대신 오류 분류와 안전한 1회 refresh가 전혀 없다.

### realtime route

- token endpoint HTTP 실패: 오류 throw
- quote endpoint HTTP 401/403/429/5xx: 모두 `KIS 시세 HTTP N` 형태의 502 응답
- 업무 응답 `rt_cd !== "0"`: 일반 오류 응답
- 401에 대한 1회 refresh 없음
- 403/429에 대한 refresh도 없음

### investor route

- token endpoint의 `response.ok` 검사 없음
- `access_token` 존재 검증이 없음
- investor endpoint의 `response.ok` 검사 없음
- KIS 업무 코드 검증 없음
- output이 없으면 수급 세 값을 0으로 반환

따라서 investor route는 인증 실패·권한 오류·rate limit·업무 오류를 실제 순매수 0처럼 표시할 위험이 있다.

### 향후 분류 원칙

- HTTP 401만 token invalidation + 최대 1회 refresh 대상으로 인정
- HTTP 403은 권한/계정/endpoint 문제로 처리하고 재발급 금지
- HTTP 429는 rate limit으로 처리하고 token refresh 금지
- 400, 404, 5xx도 token refresh 금지
- KIS가 HTTP 200 안에 인증 만료 업무코드를 반환한다면, 공식 문서로 확인된 **명시적 allowlist 코드만** 401과 동일 취급 가능
- 알 수 없는 `rt_cd/msg_cd`는 일반 API 실패로 유지

## 9. token 발급 실패 후 반복 루프

### realtime

단일 route 요청 안에는 재귀나 while retry가 없다. 그러나 브라우저 interval이 멈추지 않으므로 token 발급 실패 후에도 5초마다 `/api/realtime`이 다시 호출되고, 매번 token 발급을 다시 시도한다.

따라서 request 내부 무한 루프는 아니지만, 선택 종목이 유지되는 한 **시간적으로 무제한 반복되는 발급 시도**가 존재한다.

### investor

`stockInfo` 변경당 한 번 호출하므로 자체 polling은 없다. 다만 재검색, remount, Fast Refresh가 발생하면 다시 발급한다. token 실패가 명시적으로 처리되지 않아 route 500 또는 잘못된 0 응답으로 이어질 수 있다.

### 필요한 차단

- token 발급 실패에 짧고 제한된 negative cache/cooldown
- 동일 in-flight 발급 공유
- 한 요청에서 최대 1회 발급/refresh
- realtime client의 연속 실패 시 polling 중단 또는 backoff
- 사용자 명시 재시도 전까지 인증 설정 오류 반복 금지

## 10. 로컬 Next.js와 Vercel cache 방식

### 로컬 Next.js 단일 프로세스

module-level server memory cache로 충분한 1차 효과를 얻을 수 있다.

```text
cachedToken = { value, expiresAt }
tokenPromise = Promise | null
```

- 모든 route가 같은 공용 module을 import
- 유효 token은 memory에서 반환
- 발급 중이면 같은 Promise await
- 개발 HMR/서버 재시작 시 cache 소실은 허용
- token을 파일에 쓰지 않음

주의: 개발 HMR로 module이 다시 로드되면 신규 발급될 수 있다. `globalThis`에 개발 전용 cache를 둘 수도 있지만 타입과 production 격리를 명확히 해야 한다.

### Vercel 서버리스

module memory는 warm instance 안에서만 재사용되고 다음 경우 공유되지 않는다.

- cold start
- 여러 concurrent function instance
- region 분산
- deployment 교체

따라서 module cache만 사용하면 instance마다 token을 발급할 수 있다. 권장 구조는 다음이다.

1. 서버 전용 managed Redis/KV에 암호화 또는 접근 통제된 token+expiresAt 저장
2. app key/environment 단위 분산 lock
3. lock 획득자가 token 발급 후 cache 저장
4. 다른 instance는 짧게 대기 후 cache 재확인
5. cache 장애 시 각 instance가 무제한 발급하지 않도록 fail-closed/cooldown

Vercel deployment 환경에서 token은 browser-accessible 환경변수나 `NEXT_PUBLIC_*`에 두면 안 된다. Redis/KV도 server-only credential로 접근해야 한다.

## 11. 모든 KIS route가 token 하나를 공유하기 위한 파일

### 최소 수정 대상

- 신규 `lib/kis-token-manager.ts` 또는 런타임 중립적인 `lib/kis-token-manager.mjs`
- 신규 `lib/kis-client.ts` — 인증 요청과 401 1회 retry를 중앙화하는 경우 권장
- 수정 `app/api/realtime/route.ts` — 자체 `getAccessToken()` 제거
- 수정 `app/api/investor/route.ts` — 자체 `getAccessToken()` 제거, 응답 오류 검증 보강
- 수정 `app/page.tsx` — 반복 실패 polling 중단/backoff 및 visibility/market status 정책 적용 시
- 신규 token manager 합성 테스트
- `package.json` — 테스트 명령 추가

### 검증 스크립트

- `scripts/compare-technical-models.mjs`
- `scripts/validate-technical-sample.mjs`

이 스크립트들은 이미 실행당 1회 발급 후 재사용하므로 운영 알림의 핵심 원인은 아니다. 공용 모듈이 Node script에서도 안전하게 사용 가능하도록 설계하면 차후 통합할 수 있지만, 웹 route 수정과 한 번에 과도하게 결합할 필요는 없다.

### 변경하지 않을 파일

- A-v1/A-v2/B-v1/C-v1/D-v1 공식
- snapshot/history schema 및 기존 파일
- 품질 gate
- `history:resolve`, futureReturns, backtestReturns

## 12. single-flight / mutex 구조

### 단일 프로세스 권장 의사코드

```ts
let cache: { token: string; expiresAtMs: number } | null = null;
let inFlight: Promise<TokenRecord> | null = null;

async function getValidKisToken(options = {}) {
  if (!options.forceRefresh && isUsable(cache, 5 * 60_000)) return cache.token;
  if (inFlight) return (await inFlight).token;

  inFlight = issueTokenAndValidateExpiry();
  try {
    cache = await inFlight;
    return cache.token;
  } finally {
    inFlight = null;
  }
}
```

중요 사항:

- 발급 Promise를 cache에 저장해 동시 호출이 모두 같은 Promise를 await
- 실패 시 inFlight를 반드시 null로 정리
- 실패 token/undefined를 cache하지 않음
- refresh 중에도 아직 안전한 유효 token을 쓸지 여부는 정책으로 결정
- cache record나 오류에 token 문자열을 serialize하지 않음

### 분산 환경

```text
read shared cache
  → usable: return
  → expired/missing: acquire distributed lock
      → lock acquired: cache double-check → issue once → store → unlock
      → lock not acquired: bounded wait → cache re-read
      → timeout: fail, independent uncontrolled issue 금지
```

분산 lock은 TTL이 있어야 하며 프로세스 crash 후 영구 잠금이 되면 안 된다. 대기와 cache 재확인은 횟수/시간 상한을 둔다.

## 13. 만료 5분 전 갱신과 401 최대 1회 정책

### 정상 요청

1. `expiresAt - now > 5분`: 기존 token 사용
2. 5분 이하: single-flight refresh
3. expiry를 파싱할 수 없음: 장기 cache 금지, 명시적 오류 또는 공식 계약에 따른 보수적 TTL

### KIS business API 요청

```text
token = getValidToken()
response = callKis(token)

if HTTP 401 and retryCount == 0:
  invalidate only if cached token == token used by request
  refreshed = getValidToken(forceRefresh=true)
  retry exactly once
else:
  return/classify error without token refresh
```

### race 보호

오래된 요청이 401을 받은 사이 다른 요청이 이미 새 token을 저장했을 수 있다. 따라서 “내가 사용한 token과 현재 cached token이 같을 때만 invalidate”해야 새 token을 지우지 않는다.

### 절대 refresh하지 않는 경우

- 403
- 429
- 일반 4xx
- 5xx
- timeout/network 오류
- response parse 오류
- 데이터 없음
- 확인되지 않은 KIS 업무 오류코드

최대 시도는 최초 1회 + 401 후 retry 1회, 총 2회다. 두 번째 401이면 그대로 실패하고 재발급하지 않는다.

## 14. token·key·secret 노출 감사

### 현재 양호한 부분

- `.env.local`은 `.gitignore`의 `.env*` 규칙으로 제외됨
- app key/secret은 `process.env.KIS_APP_KEY`, `process.env.KIS_APP_SECRET`에서 읽음
- `NEXT_PUBLIC_*` 사용 없음
- API 응답에 token을 포함하지 않음
- JSON production 데이터에 token 저장 코드 없음
- token 자체를 명시적으로 `console.log`하지 않음
- dry-run sanitizer는 query credential과 Bearer 값을 마스킹함

### 주의할 부분

- realtime route catch는 `error.message`를 브라우저 응답으로 반환한다. 현재 오류 메시지에 token/key를 직접 넣지는 않지만 향후 공용 client가 raw response/request를 error message에 넣지 않도록 해야 함
- investor route는 종목코드만 로그에 남기며 token은 로그하지 않음
- fetch exception이나 디버그 logger에 headers/body 전체를 출력하면 app key/secret/token이 노출될 수 있으므로 금지
- token manager object를 JSON.stringify하거나 persisted cache dump/log로 출력하지 않아야 함
- shared Redis/KV 사용 시 일반 사용자 접근이 불가능한 server-only store와 최소 권한 credential 필요

### 금지 저장 위치

- browser state/localStorage/sessionStorage/cookie
- API JSON 응답
- source code/Git
- `data/*.json`, reports, logs
- client-accessible environment variables

## 15. 가장 작은 안전한 수정안과 테스트 계획

### 1단계: 공용 token manager

1. server-only 공용 token manager 추가
2. token과 expiresAt을 process memory에만 저장
3. in-flight Promise 기반 single-flight
4. 만료 5분 전 refresh
5. token 응답 schema 검증
6. token/key/secret 없는 안전한 오류 코드만 반환

### 2단계: 두 route 통합

1. realtime/investor의 중복 `getAccessToken()` 제거
2. 공용 KIS client로 business API 호출
3. HTTP 401만 최대 1회 강제 refresh
4. 403/429/5xx는 refresh하지 않음
5. investor의 HTTP/업무코드/데이터 검증 추가
6. 누락 수급을 0으로 대체하지 않고 명시적 오류 반환

### 3단계: polling 안전화

1. 페이지 hidden 시 polling 중단
2. 휴장/장마감 또는 실시간 카드 비활성 시 중단
3. 연속 인증 실패 시 interval 중단 또는 bounded backoff
4. AbortController로 종목 변경 시 이전 요청 취소
5. investor request에 requestId/code 일치 보호

### 합성 테스트

| 사례 | 기대 결과 |
|---|---|
| token 없음, 동시 20요청 | 발급 함수 1회, 20요청 동일 token 공유 |
| 유효기간 5분 초과 | 발급 0회 |
| 만료 5분 이내 | single-flight 발급 1회 |
| token endpoint 실패 | 실패 cache/cooldown, token 값 저장 없음 |
| business HTTP 401 | token 1회 refresh 후 business retry 1회 |
| 두 번째 401 | 즉시 실패, 추가 발급 없음 |
| HTTP 403 | refresh 0회 |
| HTTP 429 | refresh 0회 |
| HTTP 500/network timeout | refresh 0회 |
| 동시 401 여러 건 | 새 token 발급 1회 |
| 오래된 token 요청의 늦은 401 | 이미 갱신된 token을 invalidate하지 않음 |
| investor output 없음 | 0이 아니라 명시적 DATA_UNAVAILABLE |
| logger/API 응답 | token/key/secret 문자열 없음 |
| module reset | 신규 발급 가능하나 파일/browser 저장 없음 |

### 통합 테스트

- 검색 1회 후 realtime+investor가 같은 token record 사용
- 1분 polling에서도 token 발급은 0회 추가(유효기간 내)
- 동일 종목 재검색 시 token 재사용
- 여러 browser 요청 동시 실행 시 single-flight 유지
- 모델 공식·history·품질 gate·resolver SHA 불변
- 외부 API 없이 mock fetch로만 검증

## 최종 판정

현재 구조는 “검색·polling마다 token 신규 발급”이며 운영에 적합하지 않다. 카카오톡 알림은 정상적인 코드 실행 결과지만, token 생명주기 관리가 없다는 명확한 신호다.

로컬에서는 공용 module memory + single-flight로 즉시 개선할 수 있다. Vercel에서는 warm instance memory만으로 전체 중복 발급을 막을 수 없으므로 server-only shared cache와 distributed lock이 필요하다. 어느 환경에서도 일반 403·429·5xx를 token 만료로 보지 않고, HTTP 401에 한해 최대 한 번만 refresh해야 한다.
