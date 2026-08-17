# Point-in-time Universe·기업행위 데이터 사전검증 보고서

## 1. 선행 체크포인트

- Walk-forward source preflight 커밋: `152dda3fdba0df41e13196b7e18aeec0823128bc`
- 메시지: `chore: add walk forward data source preflight`
- 커밋 직후 작업 트리 clean 확인
- push·배포 미실행

## 2. 공식 소스 계약

최우선 조사 소스는 금융위원회 `주식발행정보 V3`이며 원천 보유기관은 한국예탁결제원이다. 공식 페이지는 일 1회 갱신, 기준일 다음 영업일 오후 1시 이후 제공이라고 명시한다. [금융위원회 주식발행정보 공식 페이지](https://www.data.go.kr/data/15043423/openapi.do?recommendDataYn=Y)

확인된 서비스:

- Base URL: `apis.data.go.kr/1160100/GetStocIssuInfoService_V3`
- 종목기본정보: `getItemBasiInfo_V3`
- 주식발행내역: `getStocIssuInfo_V3`
- 의무보호예수 반환: `getLockUpRetuInfo_V3`
- 주식발행현황: `getStocIssuStat_V3`
- 공통 pagination: `pageNo`, `numOfRows`, 응답 `totalCount`
- 종목기본정보 검색키: `basDt`, `isinCd`, `crno`

공식 설명에는 종목 기본정보, 액면가, 발행주식수, 상장·상장폐지일, 발행사유, 보통주·우선주 수 등이 포함된다고 명시되어 있다. 다만 시장 구분, 단축코드 계보, 합병·분할 연결, 수정주가 정책은 문서 설명만으로 확정되지 않는다. [공식 API 명세 요약](https://www.data.go.kr/en/data/15043423/openapi.do)

## 3. 실제 외부 요청 결과

- 실행 ID: `pit-20260817`
- 허용 기준일: 2020-01-02, 2022-01-03, 2024-01-02, 2026-08-13
- 실제 API 요청: **1회**
- 첫 요청: 2020-01-02 `getItemBasiInfo_V3`
- 결과: HTTP 403
- 자동 재시도: 0회
- 이후 날짜 요청: 0회
- KIS, DART, 비공식 API, OHLCV API 호출: 0회
- 원시 응답·API key·전체 URL 저장: 없음

현재 프로젝트의 공공데이터 key는 주식시세 API에는 접근 가능하지만 주식발행정보 V3 활용 권한은 확인되지 않았다. 공식 포털도 서비스별 활용신청·권한 오류를 별도로 설명한다. 따라서 동일 key라는 이유만으로 서비스 접근 가능하다고 가정할 수 없다.

## 4. 기준일별 결과

| 요청일 | HTTP | actualAsOfDate | 종목 수 | KOSPI/KOSDAQ | ISIN/영속 ID | 상장·상폐일 | 판정 |
|---|---:|---|---:|---|---|---|---|
| 2020-01-02 | 403 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | AUTHORIZATION_BLOCKED |
| 2022-01-03 | 미호출 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | NOT_MEASURED |
| 2024-01-02 | 미호출 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | NOT_MEASURED |
| 2026-08-13 | 미호출 | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | NOT_MEASURED |

403 이후 날짜를 호출하거나 최신값·인접 날짜로 대체하지 않았다. 따라서 날짜별 종목 수와 필드 충족률을 임의 산출하지 않는다.

## 5. Universe·계보·유형 필터 가능성

문서 계약상 `basDt`, ISIN, 법인등록번호, 상장·상폐일 및 증권종류 관련 필드는 point-in-time 복원 후보로 적합하다. 그러나 실제 응답을 받지 못했으므로 다음은 모두 미검증이다.

- `basDt`가 exact-date snapshot인지 해당 날짜까지의 최신 레코드 검색인지
- 과거 상폐 종목이 과거 기준일 전체 조회에 포함되는지
- 미래 상장 종목이 과거 기준일 응답에서 제외되는지
- KOSPI/KOSDAQ 시장 구분 필드 존재 여부
- 단축코드, ISIN, 법인등록번호의 충족률과 중복
- 보통주/우선주/스팩/리츠/ETF 분류 재현성
- 명칭 변경 및 코드 변경 전후 연결 가능성

현재 Universe 필터는 `securityGroupCode=ST`, ETP product code 비어 있음, SPAC 제외, 우선주 코드 제외를 사용한다. 공식 V3 응답의 실제 증권유형 코드와 매핑을 검증하기 전에는 동일 필터를 과거에 재현할 수 없다.

## 6. 기업행위 소스 판정

문서상 주식발행내역과 발행현황은 발행사유·주식수·액면가 등을 제공하므로 유상증자, 무상증자, 감자 일부를 식별할 후보이다. 종목기본정보의 상장폐지일은 상폐 상태 후보이다. 하지만 실제 contract/응답을 확보하지 못했고 다음 사건은 공식 연결 필드가 확인되지 않았다.

- 액면분할·병합
- 합병·회사분할
- 구코드→신코드
- 이전상장
- 거래정지·재개
- ex-date 및 가격 조정 ratio

따라서 포괄적 기업행위 원장 판정은 **`CORPORATE_ACTION_SOURCE_NOT_AVAILABLE`**이다. 이는 공식 데이터가 전혀 없다는 의미가 아니라, 현재 접근권한과 검증 범위에서 필요한 최소 사건 계약을 인증하지 못했다는 의미다.

권장 최소 이벤트 필드는 `persistentSecurityId`, old/new code, eventType, announcement/effective/ex-date, ratio, source, sourceAsOfDate, sourceHash이다.

## 7. 수정주가 정책

`GetStockPriceInfo` 공식 설명과 주식발행정보 설명에는 가격이 기업행위 반영 수정주가인지 명시되어 있지 않다. 가격 연속성만으로 판단하지 않았으며 최종 상태는 **`UNKNOWN`**이다.

기업행위가 확보되더라도 원주가와 수정주가를 별도 계열로 보존하고, 이벤트 ratio와 유효일이 공식 인증된 경우에만 재현 가능한 보정 계열을 생성해야 한다. 이번 단계에서는 보정값을 만들지 않았다.

## 8. Point-in-time 최종 판정

| 수준 | 판정 |
|---|---|
| CERTIFIED_POINT_IN_TIME | 불가 |
| PROVISIONAL_POINT_IN_TIME | 아직 불가 |
| RESEARCH_ONLY_POINT_IN_TIME | 계약 후보만 존재, 실제 데이터 미확보 |
| NOT_RECONSTRUCTABLE | **현재 실행 환경의 최종 판정** |

현재 전체 판정은 **`NOT_RECONSTRUCTABLE`**이다. 이유는 API 계약 후보는 존재하지만 해당 서비스 접근이 403으로 차단되어 exact-date 전체 종목, 상폐 포함성, 미래 상장 제외, 식별자 충족률을 실제 확인할 수 없기 때문이다.

주식발행정보 V3 활용신청이 승인되고 네 날짜 응답이 exact-date 조건을 충족하면 `PROVISIONAL_POINT_IN_TIME`으로 재평가할 가능성은 있다. 기업행위와 수정주가 정책까지 인증되기 전에는 certified로 승격할 수 없다.

## 9. Universe 재현 알고리즘 권장안

신호일 T마다 다음 순서를 사용한다.

1. 공식 마스터에서 `actualAsOfDate === T`인 응답만 승인
2. 승인된 보통주 등 증권 유형 필터
3. `listingDate <= T`
4. 상폐일이 있으면 `T < delistingDate`
5. exact-date 시가총액 결합
6. T까지의 과거 20거래일 거래대금만 집계
7. 시가총액 1,000억원 이상
8. 평균 거래대금 20억원 이상
9. T 이후 필드 사용 금지
10. 정렬된 persistent ID·code 목록과 source/content hash 저장

권장 경로:

- `data/security-master-history/YYYY-MM-DD.json`
- `data/corporate-actions/{persistentSecurityId}.json`
- `data/research-backfills/{backfillId}/universe/YYYY-MM-DD.json`

동일 날짜는 source hash와 contentHash가 모두 같을 때만 멱등 성공으로 처리한다.

## 10. 중복 호출 방지

신규 진단기는 SHA-256 request fingerprint, 한 실행 내 single-flight, 최대 40회, 401/403/429 즉시 중단, 5xx 최대 1회 재시도 정책을 사용한다.

임시 manifest 경로:

`%TEMP%/stock-research-pit-preflight/{safe-run-id}.json`

manifest에는 operation, 날짜, HTTP/업무 상태, totalCount, 안전한 집계만 저장하며 credential, 전체 URL, 원시 응답을 저장하지 않는다.

- `--run-id=<id>`: 최초 실행
- `--resume=<id>`: 기존 완료 fingerprint 재사용
- `--report-only=<id>`: 외부 요청 없이 보고서 재출력

실제 `--report-only=pit-20260817` 실행의 외부 요청은 0회였다. manifest는 진단 재현이 필요한 동안만 임시 디렉터리에 보존하고, 검토 종료 후 안전한 run-id의 파일만 삭제한다. production 경로에는 복사하지 않는다.

## 11. 구현·검증 및 잔여 차단 요소

신규:

- `lib/point-in-time-universe-preflight.mjs`
- `scripts/run-point-in-time-preflight.mjs`
- `scripts/test-point-in-time-preflight.mjs`
- 본 보고서

수정:

- `package.json`

합성 테스트는 exact-date, 미래 상장 제외, 과거 상폐의 과거 포함/상폐 후 제외, 코드·ISIN 중복 차단, 영문 혼합 코드, 유형 분류, fingerprint single-flight, 401/403/429 즉시 중단을 검증한다.

공식 walk-forward 잔여 차단 요소:

1. 주식발행정보 V3 활용신청·접근권한 승인
2. 4개 기준일 actualAsOfDate exact-match 실측
3. 과거 상폐 포함·미래 상장 제외 실측
4. 시장·증권유형·ISIN·법인번호 충족률 검증
5. 코드/명칭/합병·분할 계보 공식 연결
6. 수정주가 또는 기업행위 보정 정책 인증
7. 거래정지·재개 및 실제 진입 가능성 데이터

기존 모델 공식, market/company/intraday 공식 및 production 데이터는 변경하지 않았다. 553종목 OHLCV, 과거 점수·순위·snapshot, backfill, returns resolver, backtest latest, 기업행위 가격 보정, push, 배포는 실행하지 않았다.
