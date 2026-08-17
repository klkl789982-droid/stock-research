# 장중 세션 추정 정책 구현 보고서 (2026-08-17)

## 1. 체크포인트

- 1단계 기준 HEAD: `4b371d8996dc62e52025f47b503d8eaa458aa13d`
- 장중 display-only 계층 로컬 체크포인트: `3c2b15940eeba95f9f2ab8751e5ca1eb64e5a32e`
- 커밋 메시지: `feat: add display only intraday market analysis`
- 2단계 세션 정책 변경은 요구대로 커밋하지 않았다.
- push, Vercel 배포, 외부 API, 실제 dry-run/snapshot/seed/history resolver는 실행하지 않았다.

## 2. 생성·수정 파일

신규 파일:

- `config/intraday-session-policy.json`
- `lib/intraday-session-policy.mjs`
- `scripts/test-intraday-session-policy.mjs`
- `reports/intraday-session-policy-implementation-2026-08-17.md`

수정 파일:

- `app/api/intraday-market-analysis/route.ts`
- `app/api/realtime/route.ts`
- `app/page.tsx`
- `components/market-analysis/MarketAnalysisPanel.tsx`
- `lib/kis-quote-provider-core.mjs`
- `package.json`
- `scripts/test-intraday-market-api-ui.mjs`
- `scripts/test-kis-quote-provider.mjs`

`lib/intraday-market-analysis-v1.mjs`는 검토 과정에서 차단 헬퍼 export 변경을 제거해 체크포인트와 동일하게 복원했다. 계산 공식 변경은 없다.

## 3. 정책 및 해시

- `policyVersion`: `intraday-session-policy-v1`
- `timezone`: `Asia/Seoul`
- `evidenceType`: `scheduleAndFreshQuoteInferred`
- 정규장: 09:00:00–15:30:00
- 계산 허용 구간: **09:00:00–15:20:00**
- quote freshness: **60초 미만**. 사용자의 “60초 이상 차단” 정책에 따라 정확히 60.000초도 차단한다.
- quote cache TTL: 5초
- 정책 SHA-256: `f9c0ce232d22930139a8d36cfd091ee1f721748a1231a93c559b2da1ecbbeb52`
- 항상 `displayOnly: true`, `isRealtime: false`, ranking/backtest/optimization eligibility는 모두 false이다.

## 4. 세션 판정 입력·출력

입력은 거래일 원장 레코드, KIS 기준일·체결시각·수신시각, OHLCV quote, 공식 snapshot/seed 검증 결과, 세션 정책 및 선택적 검증 override이다. 출력은 `allowed`, `sessionStatus`, evidence/policy version/hash, quote age/date/time, receipt time, 차단 사유, 품질 상태, UI 라벨과 격리 플래그이다.

서버 수신시각은 체결시각으로 대체하지 않는다. KIS 기준일과 체결시각을 `Asia/Seoul` timestamp로 구성하고 `receivedAt - quoteTimestamp`로 age를 계산한다.

## 5. 09:00 첫 체결 정책

| 조건 | 판정 |
|---|---|
| 08:59:59 | `outsideConservativeWindow`, 차단 |
| 09:00:00, 공식 거래일, 유효 시가, 누적 거래량 > 0, 체결시각 존재, age < 60초 | `inferredOpen`, 허용 |
| 09:00 이후 시가 0/null | `openingTradePending`, 차단 |
| 09:00 이후 누적 거래량 0 | `openingTradePending`, 차단 |
| KIS 체결시각 없음 | `openingTradePending`, 차단 |
| quote age >= 60초 | `openingTradePending` + `quoteStale`, 차단 |
| quote 미래시각 | `quoteFromFuture`, 차단 |
| 날짜 불일치 | `quoteDateMismatch`, 차단 |
| unchecked/collectionFailed | `tradingDayUnverified`, 차단 |
| marketClosed | `marketClosed`, 차단 |
| 15:20:00 | 조건 충족 시 허용 |
| 15:20:01 이후 | `outsideConservativeWindow`, 차단 |
| 특별 일정이나 검증 override 없음 | `specialScheduleUnverified`, 차단 |
| snapshot/seed/hash/date/version 문제 | `resourceBlocked`, 차단 |

09:00–09:05를 시간만으로 일괄 차단하지 않는다. 09:00부터 종목별 첫 유효 체결 증거가 확인되는 경우에만 허용한다.

## 6. API·UI·polling

`/api/intraday-market-analysis`는 정책 판정이 허용된 경우에만 기존 계산기를 호출한다. 차단 시 공식 분석으로 fallback하지 않고 안전한 상태와 기준 정보만 반환한다. `/api/realtime`은 기준일·체결시각·수신시각·age·freshness 메타데이터를 제공하지만 `marketStatus`는 unknown, `isRealtime`은 false를 유지한다.

UI는 `장중 추정 · KIS 마지막 체결 HH:mm:ss`, 서버 수신시각, 최대 60초 정책과 `참고용 · TOP/백테스트/최적화 미사용`을 표시한다. `실시간`이나 공식 개장 인증 라벨은 사용하지 않는다.

polling은 `sessionStatus === inferredOpen`, 선택 종목 유지, visible tab 조건에서만 5초 주기로 진행한다. 종목 변경/unmount/hidden 시 timer와 요청을 정리하고, 세션이 차단 상태로 바뀌면 중단한다. 기존 연속 실패 제한과 stale-response 방지도 유지한다.

## 7. 특별 세션 override

override는 날짜, 공식 source, sourceUrl 또는 noticeId, verifiedAt, session/calculation window, reason, contentHash를 요구한다. 내용 SHA가 일치하지 않거나 공식 근거가 없으면 거부한다. 실제 production override는 추가하지 않았다.

## 8. 검증 결과

다음 테스트가 모두 통과했다.

- 장중 session/quote/seed/calculator/API·UI 테스트
- market analysis 4종 테스트
- company analysis 6종 테스트
- KIS token/route 테스트
- data quality, snapshot quality, dry-run 안전, normalization 테스트
- TOP UI, A-v2, history resolver, calendar 테스트
- TypeScript (`npx tsc --noEmit --incremental false`)
- 변경 코드 ESLint
- `npm run build`
- `git diff --check`

첫 build 시 샌드박스가 `.next/trace-build` 쓰기를 막아 EPERM이 발생했다. 동일 명령을 로컬 쓰기 허용 상태로 재실행했고 compile, TypeScript, 13개 static page 생성까지 정상 완료했다.

## 9. 불변성 및 보안

A-v1/A-v2/B-v1/C-v1/D-v1, market-analysis-v1, company-analysis-v1 및 intraday-market-analysis-v1 공식 파일은 체크포인트 대비 diff가 없다. `data/` production 파일도 변경하지 않았다. `.env.local`, `.next`, `node_modules`는 ignored 상태이며 변경/커밋 대상에 포함하지 않았다. token/key/secret/raw KIS payload를 신규 응답이나 로그에 노출하지 않는다.

## 10. 제한사항과 다음 단계

- 공식 market snapshot 또는 intraday seed가 실제로 없으면 정책 조건이 좋아도 계산은 계속 차단된다.
- `scheduleAndFreshQuoteInferred`는 공식 개장 인증이 아니며 거래정지/체결 가능성을 완전하게 인증하지 못한다.
- 첫 실제 dry-run에서는 snapshot/seed date, sourceHash, formulaHash, version 일치와 09:00 경계의 실제 KIS 필드 품질을 확인해야 한다.
- Vercel 다중 인스턴스에서는 quote cache와 single-flight가 프로세스별로 분리된다. 배포 전 Redis/KV 같은 공유 quote cache와 분산 single-flight/lock 범위를 별도로 설계해야 한다.
