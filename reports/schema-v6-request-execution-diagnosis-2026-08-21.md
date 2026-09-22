# Schema v6 Request Execution Diagnosis — 2026-08-21

## 판정

**NETWORK_ENVIRONMENT_BLOCKED**

대표 종목의 공공 일봉 요청이 HTTP 응답 전에 `fetch failed`로 종료되어 full-Universe 수집과 데이터 품질 검증에 도달하지 못했다. 전체 dry-run은 재실행하지 않았다.

## 표 1: 실행 개요

| 항목 | 결과 |
|---|---|
| HEAD | `d53dee9` |
| 실행 명령 | `npm run history:dry-run -- --latest --max-attempts=3` |
| 외부 dry-run 실행 횟수 | 1 |
| candidate date | 미산출 |
| 시작·종료 시각 | 프로세스 결과에 미보존 |
| 관측 실행시간 | 약 4.6초 |
| max attempts | 3 |
| full-Universe 요청/성공/실패 | 미도달 / 0 / 미집계 |
| 대표 요청 성공/실패 | 0 / 1 |
| retry 회복 | 0 |
| 최종 품질 판정 | 미도달 |

## 표 2: 요청 오류 분포

| 오류 범주 | 종목 수 | 요청 시도 수 | retry 후 회복 | 최종 실패 | 대표 코드 |
|---|---:|---:|---:|---:|---|
| `networkError/fetchFailed` | 1 | 3 | 0 | 1 | `005930` |

HTTP 상태, 업무 응답, 원시 응답은 수신되지 않았다. DNS/TLS/proxy/connection-reset 세부 코드는 최종 오류에 보존되지 않아 임의 추정하지 않는다.

## 표 3: 시도 횟수 분포

| 시도 횟수 | 종목 수 |
|---|---:|
| 1회 성공 | 0 |
| 2회째 성공 | 0 |
| 3회째 성공 | 0 |
| 3회까지 실패 | 1 |

## 표 4: 데이터 품질 분포

| severity | issue type | 전체 건수 | 영향 종목 수 | 처리 원칙 |
|---|---|---:|---:|---|
| - | 전체 품질 검증 | 미산출 | 미산출 | full-Universe 수집 전이므로 판정하지 않음 |
| fatal | `missingHistoryCodes` | 미산출 | 미산출 | 기존 결과로 대체하지 않음 |
| fatal | `zeroVolumePriceChanged` | 미산출 | 미산출 | 공식 근거 없이 완화·보정하지 않음 |

## 표 5: 다음 단계 판정

| 단계 | 판정 | 사유 |
|---|---|---|
| production snapshot | 차단 | full-Universe 수집·품질 검증 미도달 |
| `history:resolve` | 차단 | 신규 검증 snapshot 없음 |
| T+2 resolver | 차단 | 신규 검증 snapshot 없음 |
| rank backtest | 차단 | 신규 검증 snapshot 없음 |
| commit | 대기 | 관측성 변경 검토와 사용자 승인 필요 |

## 불변·보안 확인

- API key, 전체 URL, 원시 오류 stack, 원시 응답 body를 기록하지 않았다.
- stale 데이터나 다른 종목 데이터로 실패를 대체하지 않았다.
- 품질 게이트와 모델 공식을 변경하지 않았다.
- production snapshot, history, market-price ledger, Universe archive, resolver, backtest를 실행하지 않았다.
- 이번 실패는 대표 probe 단계에서 발생해 신규 issue manifest와 full-Universe 보고서가 생성되지 않았다.
