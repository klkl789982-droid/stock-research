# Schema v6 회사 네트워크 진단 — 2026-08-21

## 범위와 안전 조건

- 실제 주식시세 업무 요청과 dry-run은 실행하지 않았다.
- `apis.data.go.kr`의 DNS, TCP 443, TLS 및 자격증명 없는 HTTPS 루트 `HEAD`만 각각 1회 진단했다.
- API 키, service key, query string, 전체 업무 URL, 원시 응답은 읽거나 기록하지 않았다.
- 코드·설정·production 데이터는 변경하지 않았다.

## Canonical public EOD 요청 구조

| 항목 | 확인 결과 |
|---|---|
| hostname | `apis.data.go.kr` |
| protocol / port | HTTPS / 443 |
| 서비스 식별 pathname | `/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo` |
| Node HTTP 구현 | Node 24의 전역 `fetch`(Undici 기반) 직접 호출 |
| timeout | 15,000ms, `AbortController` 사용 |
| proxy agent | 사용하지 않음 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | 코드에서 읽거나 적용하지 않음 |
| 시스템 프록시 자동 인식 | 코드상 설정 없음. Node 전역 `fetch`는 현재 구현에서 WinHTTP 프록시를 명시적으로 연결하지 않음 |

## 계층별 결과

| 계층 | PowerShell 결과 | Node 결과 | 판정 |
|---|---|---|---|
| DNS | 성공, IPv4 1개 | 성공, IP 1개 | 정상 |
| TCP 443 | 성공 | 성공 | 정상 |
| TLS | TLS 1.3 handshake 및 인증서 검증 성공 | TLS 1.3 handshake 및 인증서 검증 성공 | 정상 |
| HTTP 응답 도달 | 자격증명 없는 루트 `HEAD`에 HTTP 400 | 동일하게 HTTP 400 | HTTP 계층 도달 성공 |
| 프록시 적용 | WinHTTP 직접 연결 | proxy agent 없음 | 프록시 불필요한 직접 경로 |

HTTP 400은 자격증명 없는 루트 요청에 대한 서버 응답이므로 네트워크 연결 성공으로 판정한다.

### TLS 인증서

- Subject: `CN=*.data.go.kr, O=National Information Society Agency, L=Dong-gu, S=Daegu, C=KR`
- Issuer: `CN=GlobalSign RSA OV SSL CA 2018, O=GlobalSign nv-sa, C=BE`
- 유효기간: 2026-03-10 14:26:45 KST ~ 2027-04-11 14:26:44 KST
- PowerShell과 Node 모두 인증서 검증 성공

## 프록시 상태

- WinHTTP: 직접 연결, 명시적 프록시 없음
- `HTTP_PROXY`: 미설정
- `HTTPS_PROXY`: 미설정
- `NO_PROXY`: 미설정
- 프록시 인증정보 입력이나 우회는 수행하지 않았다.

## 원인 판정

- 확인된 분류: `NETWORK_PATH_OK`
- 실행 장소 판정: `COMPANY_NETWORK_OK`
- 현재 진단에서는 DNS 실패, TCP 차단, TLS 인증서 거부, 필수 회사 프록시, Node 프록시 누락의 증거가 없다.
- 앞선 `fetch failed`는 현재 재현되지 않아 지속적인 회사 네트워크 차단으로 볼 수 없다. 구체적인 과거 원인은 `TEMPORARY_NETWORK_FAILURE`일 가능성이 있으나, 원래 cause code가 저장되지 않아 확정하지 않는다.

## 오류 원인 보존 상태

| 안전 항목 | 현재 상태 |
|---|---|
| `error.name` | 분류 시 `AbortError`, `TypeError`만 사용하며 manifest에는 저장하지 않음 |
| `error.code` | 분류 시 allowlist 형태로 읽을 수 있으나 정확한 code는 저장하지 않음 |
| `error.cause.code` | 분류 시 읽을 수 있으나 정확한 code는 저장하지 않음 |
| `errno` / `syscall` / `hostname` | 저장하지 않음 |
| attempt count | 저장함 |
| timeout 여부 | `outcome=timeout`, `errorCategory=timeout`으로 저장함 |

현재 구현은 알려진 code를 `dns`, `tls`, `connectionReset` 등으로 분류할 수 있지만, 분류되지 않은 과거 `fetch failed`의 안전한 원인 code를 사후 복원할 수 없다. 필요하다면 다음 단계에서 `lib/public-eod-request-observability.mjs`와 관련 테스트만 수정하여 승인된 code allowlist(`ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`, 인증서 관련 code)를 `safeErrorCode`로 저장하는 설계가 적절하다. hostname은 canonical hostname과 일치할 때만 고정값으로 기록하고, errno·syscall은 별도 allowlist 없이는 저장하지 않는다. 이번 진단에서는 이 변경을 적용하지 않았다.

## Git 변경 분류

- 요청 관측성 코드: `lib/public-eod-request-observability.mjs`, `lib/dry-run-issue-manifest.mjs`, `scripts/create-daily-model-snapshot.mjs`
- 테스트: `scripts/test-public-eod-request-observability.mjs`, `scripts/test-dry-run-issue-manifest.mjs`, `scripts/test-history-dry-run.mjs`
- 실행/보고 경로 보강: `scripts/run-history-dry-run.mjs`
- 기존 진단·dry-run 산출물: `reports/schema-v6-request-execution-diagnosis-2026-08-21.md`, `reports/schema-v6-full-universe-dry-run-2026-08-18.md`, `reports/dry-run-issues/schema-v6-issue-manifest-2026-08-20.json`
- 이번에 생성한 파일: `reports/schema-v6-company-network-diagnosis-2026-08-21.md`
- production/history/model/resolver/backtest 변경: 없음

## 다음 실행

현재 회사 네트워크에서 HTTPS 경로가 정상임을 확인했으므로 집 또는 핫스팟으로 옮길 필요는 없다. 다음 실제 실행을 별도로 승인할 때 사용할 명령은 다음 하나다.

```powershell
npm run history:dry-run -- --latest --max-attempts=3
```

