# KIS 공유 접근토큰 관리자 구현 보고서

- 작업일: 2026-08-17
- 기준 체크포인트: `5aa8356c477a8efa3be42733e4281095b9ea3412`
- 범위: 동일 Node 프로세스의 `/api/realtime`, `/api/investor` token 공유
- 미수행: 외부 API 호출, Redis/KV/DB 도입, production 데이터 생성, dry-run, snapshot, `history:resolve`, commit/push/deploy

## 1. 생성·수정 파일

### 신규

- `lib/kis-token-manager-core.mjs`: token cache, expiry, generation, single-flight
- `lib/kis-api-client-core.mjs`: 인증 header 주입, HTTP 401 단일 retry, 안전한 오류 분류
- `lib/kis-token-manager.ts`: `server-only` Next.js facade와 process singleton
- `scripts/test-kis-token-manager.mjs`: token/client 합성 테스트
- `scripts/test-kis-api-routes.mjs`: 두 route와 polling 구조 검사
- `reports/kis-shared-token-manager-implementation-2026-08-17.md`

### 수정

- `app/api/realtime/route.ts`
- `app/api/investor/route.ts`
- `app/page.tsx`
- `package.json`

## 2. token 발급 경로 변경

### 변경 전

```text
/api/realtime → route 내부 getAccessToken → KIS token 발급
/api/investor → 별도 route 내부 getAccessToken → KIS token 발급
5초 polling → /api/realtime → 매번 KIS token 발급
```

### 변경 후

```text
/api/realtime ─┐
               ├→ server-only kisRequest
/api/investor ─┘       ↓
                 process singleton token manager
                   ├→ 유효 token 재사용
                   ├→ 발급 중 Promise 공유
                   └→ 필요할 때만 KIS token 발급
```

두 route의 자체 `getAccessToken()`과 환경변수 직접 참조를 제거했다. app key/secret과 token endpoint는 서버 전용 `lib/kis-token-manager.ts` 및 core 내부에만 존재한다.

검증용 standalone 스크립트의 실행당 1회 token 발급 방식은 이번 운영 route 범위 밖이므로 변경하지 않았다.

## 3. cache·만료·single-flight

### 메모리 record

```text
{ accessToken, expiresAtMs, generation }
```

모듈 closure에는 다음만 유지한다.

- 현재 유효 token record
- 현재 발급 중인 Promise
- 증가하는 generation

파일, JSON, browser storage, cookie에는 저장하지 않는다.

### 만료 파싱

- `expires_in`: 양수 seconds로 파싱
- `access_token_token_expired`: `YYYY-MM-DD HH:mm:ss`이면 KST absolute timestamp로 파싱
- `expires_at`: 표준 parse 가능한 timestamp로 파싱
- 둘 이상 있으면 가장 이른 유효 expiry를 사용
- 파싱 가능한 미래 expiry가 없으면 `KIS_TOKEN_EXPIRY_MISSING`
- 신규 token의 남은 시간이 5분 이하이면 `KIS_TOKEN_EXPIRY_TOO_SOON`
- 불완전한 token 응답은 cache하지 않음

### 재사용/갱신

- 남은 시간이 5분보다 많음: cached record 반환
- 5분 이하: 신규 발급
- 발급 진행 중: 같은 in-flight Promise 반환
- 발급 실패: `finally`에서 in-flight를 제거하여 다음 정상 요청이 다시 시도 가능
- 실패 token/undefined/expiry 누락 응답은 cached record로 저장하지 않음

합성 테스트에서 최초 동시 20개 요청의 token 발급 함수 호출은 1회였다.

## 4. HTTP 상태별 처리

| KIS 업무 HTTP | token 무효화 | token 갱신 | 업무 재시도 | 안전 오류 코드 |
|---:|---|---:|---:|---|
| 200 | 없음 | 0 | 0 | 업무 payload 검증 |
| 401 최초 | 요청에 사용한 token이 현재 cache와 같을 때만 | 최대 1회 | 최대 1회 | 두 번째 401은 `KIS_UNAUTHORIZED` |
| 403 | 없음 | 0 | 0 | `KIS_FORBIDDEN` |
| 429 | 없음 | 0 | 0 | `KIS_RATE_LIMITED` |
| 5xx | 없음 | 0 | 0 | `KIS_UPSTREAM_FAILURE` |
| 그 외 4xx | 없음 | 0 | 0 | `KIS_UPSTREAM_REJECTED` |
| network 오류 | 없음 | 0 | 0 | `KIS_BUSINESS_NETWORK_ERROR` |

HTTP 200 내부의 일반 KIS 업무코드는 인증 만료로 간주하지 않는다. 공식 allowlist가 없으므로 임의 refresh하지 않는다.

최초 업무 요청 1회와 401 후 재시도 1회만 허용한다. 두 번째 401은 추가 발급 없이 그대로 반환된다.

### 늦은 401 보호

token 무효화는 요청에 사용한 record의 `generation + accessToken`이 현재 cache record와 모두 같을 때만 수행한다. 다른 요청이 이미 새 generation을 저장했다면 늦게 도착한 구 token의 401은 새 token을 삭제하지 않는다.

## 5. route 응답 안전화

### realtime

- 이전 가격이나 공식 종가를 realtime 응답으로 반환하지 않음
- HTTP 오류를 안전한 `{ error: { code, message } }`로 반환
- raw KIS body를 browser에 그대로 노출하지 않음
- symbol mismatch, invalid quote, business error를 분리

### investor

- HTTP success와 `rt_cd` 검사 추가
- `output2[0]` 누락을 실제 수급 0으로 바꾸지 않음
- 세 수급 값이 모두 finite인지 검증
- 데이터 없음/오류는 명시적인 안전 오류로 반환
- 성공 응답에 `code`, `source: KIS` 추가

## 6. polling 안전장치

`app/page.tsx`의 5초 `setInterval`을 cleanup 가능한 recursive `setTimeout`으로 교체했다.

- 선택 종목이 없으면 effect 실행 안 함
- browser tab hidden이면 timer 제거 및 진행 요청 abort
- tab visible 복귀 시 polling 재개
- 종목 변경/unmount 시 timer 제거, 요청 abort, visibility listener 제거
- AbortController로 오래된 polling 요청 정리
- 연속 실패 시 5초, 10초의 제한 backoff
- 연속 3회 실패하면 자동 polling 중단
- 성공하면 실패 횟수 0으로 초기화하고 5초 주기로 복귀
- investor 요청도 종목 변경 시 abort하고 code 일치 후에만 state 반영

시장 개장/휴장 자동판정은 이번 범위에서 추가하지 않았다.

## 7. 합성 테스트 결과

`npm run kis:token-test` 통과:

- 최초 요청 token 1회 발급
- 충분한 유효기간 token 재사용
- 만료 5분 이내 갱신
- 동시 20요청 발급 1회
- 발급 실패 미cache 및 다음 요청 회복
- expiry 누락 명시적 실패
- 최초 401: 갱신 1회 + 업무 retry 1회
- 두 번째 401: 추가 갱신 없음
- 403/429/5xx: 갱신 0회
- 동시 401: 신규 token 발급 1회
- 늦은 구 token 401의 새 token 삭제 방지
- 안전 오류 serialization에 token/key/secret 없음

`npm run kis:route-test` 통과:

- route 내부 token endpoint/getAccessToken 제거
- route 내부 KIS 환경변수 직접 참조 제거
- 두 route 모두 공용 `kisRequest` 사용
- investor 누락값 0 fallback 제거
- visibility/AbortController/연속 3회 실패 중단 구조 확인

## 8. 전체 검증 결과

| 검사 | 결과 |
|---|---|
| `npm run kis:token-test` | 통과 |
| `npm run kis:route-test` | 통과 |
| `npm run data:quality-test` | 24개 통과 |
| `npm run snapshot:quality-test` | 15개 통과 |
| `npm run history:dry-run-test` | 5개 통과 |
| `npm run data:normalization-test` | 통과 |
| `npm run ui:top-stocks-test` | 통과 |
| `npm run model:a-v2-test` | 통과 |
| `npm run history:test` | 통과 |
| `npm run history:calendar-test` | 통과 |
| `npx tsc --noEmit --incremental false` | 통과 |
| 신규·변경 서버 코드 ESLint | 통과 |
| `app/page.tsx` 전체 ESLint | 기존 `no-explicit-any` 5건만 잔존, 이번 polling 변경 구간 신규 오류 없음 |
| `npm run build` | 통과 |
| `git diff --check` | 통과 |

외부 API를 호출하는 테스트는 실행하지 않았다. 모든 KIS 검증은 mock `fetch`와 합성 `Response`로 수행했다.

## 9. 비밀정보 미노출 검사

- `KIS_APP_KEY`, `KIS_APP_SECRET`: server-only facade의 `process.env`에서만 읽음
- `NEXT_PUBLIC_KIS*`: 없음
- token log: 없음
- token API 응답 노출: 없음
- token 파일/JSON/browser storage/cookie 저장: 없음
- route 오류 응답: 안전 code/message만 포함
- raw upstream payload/headers/body logging: 없음
- `.env.local`: 기존 `.gitignore` 유지, 수정하지 않음
- 새로운 패키지/lockfile 변경: 없음

합성 테스트의 자격증명 문자열은 명시적으로 synthetic 값이며 안전 오류 serialization에서 제거되는지 확인하는 fixture다.

## 10. 모델 공식·보호 데이터 불변

기준 체크포인트와 diff가 없고 SHA-256이 동일하다.

| 보호 대상 | SHA-256 |
|---|---|
| history/2026-08-13 | `5E4D913A832D241C90808583EAEE1EE7C1165535953C7AC1378C8275F8BECDAA` |
| universe.json | `5E750029D14F8B1263157AD5A0982712BC2A2F25DBB34B47F3604C8116A745F8` |
| top-stocks.json | `6C124B73FA8E07C91998E5296E81C6D3E8DEA29D195DD90F05DE4A298F339BB5` |
| model-registry.json | `4BCB29D977B7A1E4EA4643DAC6A66291C155C9C500D19C523B101548D5FA89B8` |
| A-v1 | `48CCDEC745C050683A4C994EC308CDDD5A6FA2FFC6640ADB2450A70426CA32A6` |
| A-v2 | `B3578FE7F9452D9CC169F705B0508DE3B6F0F0E1674C5D4E10B7BAC3D358BB2A` |
| B-v1 | `B9A45D38D0398617133CE8C9CE9DD05393BA787C3AD8E032EFC8CB5CEA6052D0` |
| C-v1 | `86F255711483AE949EC913750048461AC3A41B98DC28B2C0E21CA10522B16B8B` |
| D-v1 | `033A5F3E40ADBA3C74360E646B622B95683B1A83805BAEB079227226658E732F` |

`history:resolve`, futureReturns, backtestReturns, snapshot 생성 및 production 데이터 쓰기는 실행하지 않았다.

## 11. 로컬 환경에서 해결되는 범위

동일 Next.js Node 프로세스 안에서는 realtime과 investor route가 하나의 token singleton과 in-flight Promise를 공유한다. 따라서 token 유효기간 동안 검색·polling·두 route 간 반복 발급이 제거된다.

개발 server restart 또는 Fast Refresh로 server module이 재적재되면 memory cache는 사라져 token을 한 번 새로 발급할 수 있다. 이는 파일 persistence를 금지한 로컬 메모리 방식의 의도된 제한이다.

## 12. 남은 Vercel 제한

Vercel 다중 instance에서는 각각 별도의 module memory를 가진다. 이 구현만으로는 다음을 막지 못한다.

- cold start instance별 token 발급
- region별 token 발급
- 동시에 생성된 여러 function instance의 token 발급

향후에는 현재 factory/interface 아래에 server-only Redis/KV token store와 distributed lock을 추가해야 한다. 그때도 browser/JSON/Git 저장 금지, 5분 refresh window, HTTP 401 최대 1회 retry, 403/429/5xx no-refresh 정책을 그대로 유지해야 한다.
