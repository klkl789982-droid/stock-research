# Stock Research v2 스냅샷 품질 게이트 연결 보고서

- 작업일: 2026-08-17
- 프로젝트: `C:\Users\user\Desktop\stock-research`
- 작업 범위: OHLCV·Universe 품질 검증기를 신규 일별 스냅샷 생성 파이프라인에 연결
- 실제 스냅샷 생성: 하지 않음
- 외부 API 호출: 하지 않음
- Git commit·push·배포: 하지 않음

## 요약

신규 일별 스냅샷 생성기는 이제 Universe 전체 공식 일봉을 메모리에 수집한 후 품질 검증을 통과해야만 모델 점수를 계산한다.

- fatal 오류가 하나라도 있으면 모든 산출물 생성을 중단한다.
- 역사 길이가 부족한 종목은 해당 모델에서만 제외한다.
- 제외 종목을 0점 또는 중립점수로 대체하지 않는다.
- 관찰 Universe와 모델별 적격 Universe를 분리한다.
- 데이터 계보, 해시, 품질 결과를 신규 스냅샷에 저장한다.
- 기존 `data/history/2026-08-13.json`은 변경하지 않았다.
- A-v1/A-v2/B-v1/C-v1/D-v1 공식은 변경하지 않았다.

## 1. 생성·수정 파일

### 새 파일

- `config/snapshot-quality-policy.json`
- `lib/snapshot-quality-pipeline.mjs`
- `scripts/test-snapshot-quality-pipeline.mjs`
- `docs/market-data-quality-gate.md`

### 주요 수정 파일

- `scripts/create-daily-model-snapshot.mjs`
- `lib/market-data-quality-validator.mjs`
- `lib/model-history-schema.mjs`
- `lib/model-score-engine.mjs`
- `lib/market-price-ledger.mjs`
- `scripts/run-daily-history.mjs`
- `app/api/top-stocks/route.ts`
- `components/TopStocksPanel.tsx`
- `package.json`

## 2. 품질 게이트 연결 지점

신규 처리 순서는 다음과 같다.

1. 요청 날짜 확인
2. Universe 로드
3. Universe 전체 공식 일봉 조회
4. 모든 응답을 메모리에 보관
5. `market-data-quality-validator` 실행
6. fatal 이슈 검사
7. 모델별 적격 종목 결정
8. 적격 모델만 계산
9. 모델별 순위 부여
10. source manifest와 dataQuality 생성
11. Universe 요약과 제외 목록 생성
12. history·가격 원장·Universe 아카이브 임시 파일 작성
13. 세 산출물 검증 및 확정
14. 거래일 상태를 마지막에 성공으로 갱신
15. `history:resolve` 실행

검증 전에는 모델 점수를 계산하지 않는다.

## 3. fatal / ineligible / warning 처리

### fatal

다음 오류는 하루 전체 생성을 차단한다.

- 요청일과 최신 `basDt` 불일치
- 필수 종목 history 누락
- 종목코드 중복·오류
- 미래 날짜 포함
- 동일 종목·동일 날짜 중복
- invalid OHLCV
- exact-date 시가총액 누락
- 요청일 공식 시가·종가 누락
- 최근 20개 거래대금 날짜 중복·부족

fatal 발생 시:

- 모델 스냅샷 생성 금지
- 가격 원장 생성 금지
- Universe 아카이브 생성 금지
- 기존 파일 변경 금지
- 거래일 상태에 성공 기록 금지

### ineligible

다음은 해당 종목·모델 계산만 제외한다.

- 모델별 최소 역사 길이 부족
- 장기지표 계산에 필요한 행 부족
- 신규상장 등으로 260거래일 미충족

제외 종목의 점수와 순위는 `null`이며 0점이나 중립점수로 대체하지 않는다.

### warning

다음은 생성을 막지 않지만 등급을 `PROVISIONAL`로 제한한다.

- 거래량 0
- 수정주가 정책 unknown
- 기업행위 정책 unknown
- point-in-time 마스터 미인증
- 관리종목·거래정지 상태 unknown
- 원시 API 응답 미보존

## 4. Universe 구분

신규 스냅샷은 다음 Universe를 별도로 저장한다.

### observedUniverse

시가총액·거래대금 필터를 통과하여 당일 관찰한 전체 종목이다.

### modelEligibleUniverse

각 모델의 날짜·OHLCV·역사 길이 검증을 통과한 종목이다.

저장 항목:

- count
- codesHash
- excludedCount

### commonComparisonUniverse

명시된 활성 비교 모델들이 모두 계산 가능한 종목의 교집합이다.

현재 비교 정책:

- B-v1
- C-v1

비교 모델 목록은 `config/snapshot-quality-policy.json`에 저장하고 각 버전이 모델 레지스트리에 등록되어 있는지 실행 시 교차 확인한다.

A-v2는 challenger 상태를 유지하며 자동으로 champion이나 운영 모델로 승격하지 않는다.

## 5. 제외 종목 처리

신규 스냅샷의 `excludedFromScoring`에는 다음이 기록된다.

```json
{
  "code": "000000",
  "name": "종목명",
  "modelVersion": "B-v1",
  "reason": "insufficientHistory",
  "requiredTradingDays": 260,
  "availableTradingDays": 31
}
```

처리 원칙:

- observed Universe에서는 삭제하지 않음
- 해당 모델 점수를 0으로 저장하지 않음
- 중립점수를 저장하지 않음
- 임의 순위를 부여하지 않음
- 모델별 eligible count에서 제외
- `modelVersion`, `code` 오름차순으로 정렬

## 6. 모델별 최소 역사 길이

| 대상 | 최소 고유 거래일 |
|---|---:|
| RSI | 15 |
| ATR | 15 |
| MACD(12, 26, 9) | 34 |
| MA120 | 120 |
| 52주 위치 | 260 |
| A-v1 | 260 |
| A-v2 | 260 |
| B-v1 | 260 |
| C-v1 | 34 |
| D-v1 | 260 |

- A-v2는 A-v1과 동일한 데이터 자격을 사용한다.
- D-v1은 B-v1과 C-v1이 모두 eligible인 종목만 계산한다.

## 7. 모델별 순위와 백분위

각 모델은 해당 모델의 eligible Universe 안에서만 1부터 N까지 순위를 부여한다.

```text
rankPercentile = rank / rankingUniverseCount
```

신규 레코드와 TOP50 응답에는 다음이 포함된다.

- rank
- rankingUniverseCount
- rankPercentile

기존 A-v1/B-v1/C-v1/D-v1 동점 처리는 공식 변경 없이 현재 점수 내림차순 및 입력 순서 규칙을 유지한다.

A-v2 정렬은 기존 규칙을 유지한다.

1. finalScore 내림차순
2. rawScore 내림차순
3. code 오름차순

## 8. Source manifest

신규 스냅샷의 `sourceManifest`에는 다음이 저장된다.

- KIS 종목 마스터 공급자
- 마스터 기준일 인증 상태
- 공공데이터포털 일봉 서비스명
- 요청 날짜
- 종목별 최신 `basDt` 최솟값·최댓값
- 정규화 입력 SHA-256
- Universe SHA-256
- A-v1/A-v2/B-v1/C-v1/D-v1 공식 소스 SHA-256
- 원시 응답 저장 여부

### 해시 정규화 규칙

- 객체 키 순서 정렬
- 종목코드 오름차순
- 종목별 일봉 `basDt` 내림차순
- 배열 순서 결정론적 유지
- 인증키·토큰·인증 URL 파라미터 제외

원시 API 응답은 저장하지 않으므로 다음이 명시된다.

```json
{
  "rawResponseStored": false
}
```

정규화 해시만으로 완전 재현 가능하다고 표시하지 않는다.

## 9. DataQuality 메타데이터

신규 스냅샷에는 실제 검증 결과를 저장한다.

주요 항목:

- overallGrade
- structuralStatus
- coverage
- freshness
- integrity
- insufficientHistoryByModel
- certification
- blockingReasons
- warnings

현재 정책에서는 구조 검증을 통과해도 수정주가·기업행위·point-in-time 마스터가 미인증이므로 기본 등급은 `PROVISIONAL`이다.

인증 상태:

- eligibleForDisplay: true
- eligibleForRanking: 구조 검증 통과 여부
- eligibleForRankBacktest: false
- eligibleForScoreBucketBacktest: false
- eligibleForOptimization: CERTIFIED일 때만 true

## 10. Universe 날짜별 아카이빙

신규 성공 실행부터 다음 경로에 저장한다.

```text
data/universe-history/YYYY-MM-DD.json
```

저장 내용:

- requestedDate
- generatedAt
- filterVersion
- observed Universe 전체 종목
- code, name, market
- exact-date marketCap
- marketCapAsOfDate
- 최근 20개 거래대금
- 20일 평균 거래대금
- tradingValueDates
- 선정 기준
- source manifest 일부
- contentHash

동일 날짜 재실행:

- 동일 contentHash: 멱등 성공
- 다른 contentHash: 충돌로 중단

기존 2026-08-13 Universe는 사후 아카이빙하지 않는다.

## 11. 가격 추적 Universe

가격 원장 추적 대상은 다음 합집합이다.

```text
오늘 observed Universe
+ 과거 futureReturns가 T+20까지 미확정인 종목
+ 과거 backtestReturns가 T+20까지 미확정인 종목
```

각 종목에는 다음 추적 사유가 저장된다.

- currentObservedUniverse
- unresolvedFutureReturn
- unresolvedBacktestReturn

오늘 Universe 밖의 과거 미확정 종목은 기존 공공 일봉 API 경로로만 추가 조회한다. 새로운 외부 API는 추가하지 않았다.

조회가 불가능하면 `trackingPriceUnavailable`에 사유를 기록한다. 가격 또는 미래수익률을 0으로 대체하지 않는다.

## 12. 원자성·복구

하나의 성공 단위:

- `data/history/YYYY-MM-DD.json`
- `data/market-prices/YYYY-MM-DD.json`
- `data/universe-history/YYYY-MM-DD.json`
- `data/trading-calendar/status.json`

처리 방식:

1. 데이터와 검증 결과를 메모리에서 완성
2. 세 데이터 임시 파일 작성
3. 임시 파일 검증
4. 기존 대상 존재 여부·해시 확인
5. 세 파일 확정
6. 중간 실패 시 이번 실행에서 확정한 파일을 역순 제거
7. 세 파일이 모두 확인된 뒤 거래일 상태를 마지막에 성공으로 갱신
8. 이후 `history:resolve` 실행

완전한 DB 트랜잭션은 아니며 파일 기반 보상 삭제 방식이다. 기존 파일은 덮어쓰거나 복구 대상으로 사용하지 않는다.

## 13. 스키마 및 resolver 호환성

신규 history 스키마:

```text
schemaVersion: 5
```

읽기 호환 버전:

- 2
- 3
- 4
- 5

resolver의 불변 view는 `futureReturns`와 `backtestReturns`만 변경 허용 대상으로 제거한다. 따라서 다음 신규 필드는 자동으로 불변 보호된다.

- sourceManifest
- dataQuality
- universeSummary
- excludedFromScoring
- rankingUniverseCount
- rankPercentile

수익률 공식은 변경하지 않았다.

## 14. TOP50 API 및 화면

TOP50 API에 다음 메타데이터가 추가됐다.

- rankingUniverseCount
- rankingUniverseHash
- rankPercentile
- dataQualityGrade
- structuralStatus
- eligibleForRankBacktest
- sourceManifestVersion

기존 응답 필드는 유지한다.

A-v2 데이터가 없는 과거 스냅샷은 기존처럼 fallback하지 않고 명확한 오류를 반환한다.

TOP50 화면에는 작은 품질 안내가 표시될 수 있다.

- 잠정 데이터
- 구조 검증 통과 여부
- 공식 최적화 사용 금지

## 15. 합성 테스트 결과

### 데이터 품질 테스트

```text
npm run data:quality-test
```

- 24개 통과

검증 대상:

- 정상 260거래일
- 코드·날짜 중복
- 종목 누락
- 요청일 불일치
- 미래 날짜
- OHLCV 오류
- 거래량 0
- exact-date 시총
- 최근 20일 거래대금 날짜
- 모델별 역사 길이
- A-v1/A-v2 동일 자격
- D-v1 B/C 교집합
- 반복 실행 결정론

### 스냅샷 품질 파이프라인 테스트

```text
npm run snapshot:quality-test
```

- 15개 통과

검증 대상:

- fatal 시 산출물 0개
- 날짜·종목·OHLC·시총 오류 차단
- 100일 종목의 A/B/D 제외와 C 포함
- 모델별 eligible count
- B/C 공통 Universe
- 제외 종목 null 점수·순위
- rankingUniverseCount와 percentile
- 입력·공식 hash 결정론
- Universe 아카이브 멱등·충돌
- 과거 미확정 종목 추적
- 부분 commit 실패 시 파일 0개
- 신규 필드 resolver 불변
- schema 2/3/4/5 읽기 호환

## 16. 전체 검증 결과

| 명령 | 결과 |
|---|---|
| `npm run data:quality-test` | 24개 통과 |
| `npm run snapshot:quality-test` | 15개 통과 |
| `npm run model:a-v2-test` | 통과 |
| `npm run history:test` | 통과 |
| `npm run history:calendar-test` | 통과 |
| 신규·변경 코드 ESLint | 통과 |
| TypeScript | 통과 |
| `npm run build` | 통과 |
| `git diff --check` | 오류 없음 |

## 17. 기존 파일 불변 확인

| 대상 | SHA-256 |
|---|---|
| `data/history/2026-08-13.json` | `5E4D913A832D241C90808583EAEE1EE7C1165535953C7AC1378C8275F8BECDAA` |
| `data/universe.json` | `5E750029D14F8B1263157AD5A0982712BC2A2F25DBB34B47F3604C8116A745F8` |
| `data/top-stocks.json` | `6C124B73FA8E07C91998E5296E81C6D3E8DEA29D195DD90F05DE4A298F339BB5` |
| `data/model-registry.json` | `4BCB29D977B7A1E4EA4643DAC6A66291C155C9C500D19C523B101548D5FA89B8` |
| A-v1 | `48CCDEC745C050683A4C994EC308CDDD5A6FA2FFC6640ADB2450A70426CA32A6` |
| A-v2 | `B3578FE7F9452D9CC169F705B0508DE3B6F0F0E1674C5D4E10B7BAC3D358BB2A` |
| B-v1 | `B9A45D38D0398617133CE8C9CE9DD05393BA787C3AD8E032EFC8CB5CEA6052D0` |
| C-v1 | `86F255711483AE949EC913750048461AC3A41B98DC28B2C0E21CA10522B16B8B` |
| D-v1 | `033A5F3E40ADBA3C74360E646B622B95683B1A83805BAEB079227226658E732F` |

모델 공식 파일 diff는 0건이다. 신규 파일의 비밀정보 패턴 검사에서도 값이 발견되지 않았다.

## 18. 남은 제한사항

- 공공 일봉 수정주가 여부 미확인
- 기업행위 처리 정책 미확인
- KIS 마스터 point-in-time 미인증
- 원시 API 응답 미보존
- 관리종목·거래정지 상태 미확인
- 실제 신규 날짜 스냅샷을 생성하지 않아 실측 eligible 종목 수는 아직 없음
- 비교 모델 전용 필드가 모델 레지스트리에 없어 별도 정책 설정과 레지스트리 등록 여부 교차 확인을 사용
- 완전한 DB 트랜잭션이 아닌 파일 기반 보상 삭제 방식

## 19. 다음 권장 단계

실제 첫 schema v5 스냅샷을 생성하기 전에 dry-run 모드를 추가하는 것을 권장한다.

dry-run은 다음까지만 실행해야 한다.

1. 공식 일봉 조회
2. 품질 검증
3. fatal·warning 통계
4. 모델별 eligible·excluded 종목 수
5. common comparison Universe
6. source manifest와 해시 계산
7. 파일 쓰기 없이 결과 출력

dry-run 결과를 확인한 후 첫 schema v5 스냅샷 생성을 승인하는 순서가 안전하다.
