# 과거 Walk-forward 데이터 확보 사전검증 보고서

## 1. 선행 체크포인트

- 백테스트 엔진 커밋: `721c663c999a3467cf40c7369c5e59193561321c`
- 메시지: `feat: add rank based backtest aggregation engine`
- 커밋 직후 작업 트리 clean 확인
- push 및 배포 미실행

## 2. 조사 범위와 호출

사용 데이터 소스는 금융위원회 공공데이터 `GetStockPriceInfo` 하나뿐이다. KIS, DART 및 다른 API는 호출하지 않았다. 이 API의 공식 설명은 OHLCV 등 주식시세를 제공하며 기준일 다음 영업일 오후 1시 이후 갱신된다고 명시한다. [공공데이터포털 공식 API 설명](https://www.data.go.kr/data/15094808/openapi.do)

검사 종목은 총 9개이다.

- 장기상장: 삼성전자, SK하이닉스, 현대차, NAVER, LG화학
- 영문 혼합 6자리: 삼성에피스홀딩스(`0126Z0`), 에임드바이오(`0009K0`)
- 짧은 이력: 매드업(`0039P0`), 스트라드비젼(`475040`)
- 상장폐지 종목은 신뢰할 수 있는 코드·상태 근거를 현재 로컬 데이터에서 확보하지 못해 임의 선정하지 않았다.

각 종목은 최대 10,000행 조회 1회와 260행 pagination 경계 조회를 수행했다. 260행 초과 종목은 page 2까지 확인했다. 정상 최종 배치의 요청 수는 23회이다.

초기 credential 단일 인코딩 검증 과정에서 403 요청 9회가 있었고 재시도는 없었다. 출력 캡처 한계로 동일 9종목 정상 진단이 두 차례 더 완료된 후 3개 배치로 결과를 재확인했다. 전체 실행 호출은 78회이며, 어느 실행도 종목 10개·요청 30회 상한을 넘지 않았다. 이 반복은 결과 캡처 문제에 따른 것으로 전체 수집 단계에서는 허용하지 않아야 한다.

원시 응답, API key, 인증 URL은 저장하거나 출력하지 않았다.

## 3. 현재 코드와 API 계약

- endpoint: `/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo`
- 현재 snapshot 생성기: `pageNo=1`, `numOfRows=260`, `likeSrtnCd`, 선택적 `endBasDt`
- API body에는 `totalCount`, items가 있으며 `pageNo`와 `numOfRows` pagination이 실제 동작했다.
- 실측에서 page 1/2 경계 중복은 0건이었다.
- 최대 10,000행 요청에서 장기상장 5개 종목의 `totalCount`와 반환행이 모두 1,624로 일치했다.
- API 결과 순서는 최신일 우선 내림차순이었다.
- 응답 필드로 OHLCV, 거래대금, 시가총액, 시장 구분을 확보할 수 있다.
- 수정주가 여부, 분할·병합·유무상증자 보정, 명시적 거래정지 상태, 코드변경·합병 계보는 응답 필드와 공식 설명에서 확인되지 않았다.

공식 페이지는 이 API를 KRX 연계 주식시세로 설명하지만 수정주가 정책은 명시하지 않는다. 따라서 `adjustedPricePolicy: UNKNOWN`으로 취급해야 한다. 상장·상장폐지일 같은 별도 정보는 다른 공식 주식발행정보 데이터에 존재할 가능성이 확인되지만 이번 단계에서는 호출하지 않았다. [공공데이터포털 주식발행정보](https://www.data.go.kr/data/15043423/openapi.do?recommendDataYn=Y)

## 4. 종목별 실측

| 코드 | 종목 | 거래일 | 최초일 | 최종일 | 260 초과 | 중복 | invalid OHLCV | 0거래량 |
|---|---|---:|---|---|---|---:|---:|---:|
| 005930 | 삼성전자 | 1,624 | 2020-01-02 | 2026-08-13 | 가능 | 0 | 0 | 0 |
| 000660 | SK하이닉스 | 1,624 | 2020-01-02 | 2026-08-13 | 가능 | 0 | 0 | 0 |
| 005380 | 현대차 | 1,624 | 2020-01-02 | 2026-08-13 | 가능 | 0 | 0 | 0 |
| 035420 | NAVER | 1,624 | 2020-01-02 | 2026-08-13 | 가능 | 0 | 0 | 0 |
| 051910 | LG화학 | 1,624 | 2020-01-02 | 2026-08-13 | 가능 | 0 | 0 | 0 |
| 0126Z0 | 삼성에피스홀딩스 | 177 | 2025-11-24 | 2026-08-13 | 불가 | 0 | 0 | 0 |
| 0009K0 | 에임드바이오 | 169 | 2025-12-04 | 2026-08-13 | 불가 | 0 | 0 | 0 |
| 0039P0 | 매드업 | 31 | 2026-07-01 | 2026-08-13 | 불가 | 0 | 0 | 0 |
| 475040 | 스트라드비젼 | 32 | 2026-06-30 | 2026-08-13 | 불가 | 0 | 0 | 0 |

장기상장 종목도 2020년 이전 데이터가 반환되지 않았다. 따라서 이 소스의 현재 관측 가능 범위는 약 2020년 이후이며, 회사의 실제 상장 이력 전체를 제공한다고 볼 수 없다.

## 5. 예상 Walk-forward 표본

장기상장 5종목은 동일하다.

| 모델 | 최초 신호 가능일 | T1 | T5 | T20 |
|---|---|---:|---:|---:|
| A-v1/A-v2/B-v1/D-v1 | 2021-01-19 | 1,364 | 1,360 | 1,345 |
| C-v1 | 2020-02-20 | 1,590 | 1,586 | 1,571 |

영문 혼합 신규 종목:

| 종목 | A/A-v2/B/D T1/T5/T20 | C-v1 최초일 | C T1/T5/T20 |
|---|---|---|---:|
| 삼성에피스홀딩스 | 0 / 0 / 0 | 2026-01-13 | 143 / 139 / 124 |
| 에임드바이오 | 0 / 0 / 0 | 2026-01-23 | 135 / 131 / 116 |

매드업 31일과 스트라드비젼 32일은 C-v1 최소 34일에도 미달하여 모든 모델·horizon이 0이다.

이는 종목별 가격 입력 가능 횟수일 뿐 Universe point-in-time 인증이나 모델 성능 표본을 의미하지 않는다.

## 6. 과거 Universe 재현성

| 수준 | 판정 | 근거 |
|---|---|---|
| CERTIFIED_POINT_IN_TIME | 불가 | 과거 전체 상장목록, 상장폐지, 코드변경, 기업행위 계보가 없음 |
| PROVISIONAL_POINT_IN_TIME | 현재 불가 | exact-date 가격·시총·거래대금은 있으나 당시 전체 종목마스터가 없음 |
| FIXED_CURRENT_UNIVERSE_RESEARCH_ONLY | 기술적으로 가능하나 실행 금지 | 현재 553종목 기준이라 survivorship bias와 미래 종목선정 정보가 유입됨 |

현재 Universe를 과거 날짜에 적용하면 그 날짜 이후 상장 종목이 포함되고, 이후 상장폐지된 종목이 빠진다. 이는 순위·benchmark·수익률 모두를 왜곡하므로 공식 성능평가, 모델 승격, 최적화에 사용할 수 없다.

## 7. 데이터 소스 판정표

| 필요 데이터 | 현재 소스 | 가능 | 기간/PIT | 수정 여부 | 등급·사용 범위 | 추가 필요 |
|---|---|---|---|---|---|---|
| 일별 OHLCV | GetStockPriceInfo | 가능 | 실측 2020~ / 종목별 | UNKNOWN | PROVISIONAL 연구 입력 | 수정주가 정책 인증 |
| 기업행위 | 없음 | 불가 | 없음 | 해당 없음 | BLOCKED | 분할·병합·증자 공식 이력 |
| 과거 종목마스터 | 현재 Universe | 불가 | 현재시점만 | 해당 없음 | FIXED_CURRENT_UNIVERSE 연구 전용 | 날짜별 KRX 마스터 |
| 상장/상폐일 | 현재 소스에 명시 없음 | 불가 | 없음 | 해당 없음 | BLOCKED | 공식 상장·상폐 이력 |
| 코드변경 이력 | 없음 | 불가 | 없음 | 해당 없음 | BLOCKED | ISIN 기반 코드 계보 |
| exact-date 시총 | 일봉 `mrktTotAmt` | 가능 | 제공 행 기간 | 원시 | PROVISIONAL | 기업행위 교차검증 |
| 20일 거래대금 | 일봉 `trPrc` | 계산 가능 | 20일 확보 시 | 원시 | PROVISIONAL | 무거래/기업행위 정책 |
| 거래정지 상태 | 거래량 0 추정만 | 명시적 불가 | 없음 | 해당 없음 | BLOCKED | 공식 정지 상태 원장 |
| 시장 구분 | 일봉 시장 필드 | 가능 | 응답 행 기준 | 해당 없음 | PROVISIONAL | 마스터와 교차검증 |
| 미래 종가 | 일봉 종가 | 가능 | 데이터 끝 전 horizon | UNKNOWN | PROVISIONAL predictive | 수정주가 정책 |
| 다음 거래일 시가 | 일봉 시가 | 가능 | 다음 행 존재 시 | UNKNOWN | PROVISIONAL executable | 정지·체결가능성 처리 |

## 8. 최종 판정

항목별 판정:

- OHLCV history/pagination: `APPROVED_FOR_PROVISIONAL_BACKFILL`
- 장기상장 2020년 이후 모델 입력 길이: 충분
- 신규상장 A/B/D 입력 길이: `INSUFFICIENT_HISTORY`
- 과거 certified Universe: `DATA_SOURCE_NOT_RELIABLE`
- 현재 553 고정 Universe: `RESEARCH_ONLY_FIXED_UNIVERSE`
- pagination: 지원됨 (`API_PAGINATION_NOT_SUPPORTED` 아님)

전체 판정은 **`RESEARCH_ONLY_FIXED_UNIVERSE`**이다. 가격 데이터만 보면 provisional backfill이 가능하지만, 당시 전체 Universe와 기업행위·수정주가 인증이 없으므로 공식 walk-forward 검증을 승인할 수 없다.

## 9. 권장 향후 스키마

구현 전 권장 경로:

- `data/raw-market-history/{source}/{code}.json`
- `data/security-master-history/YYYY-MM-DD.json`
- `data/corporate-actions/{code}.json`
- `data/research-backfills/{backfillId}/`

각 파일에는 source, requestedAt, asOfDate, firstDate, lastDate, rowCount, pagination metadata, normalizedContentHash, rawResponseStored, adjustedPricePolicy, pointInTimeStatus, certification, warnings를 기록한다. 자격증명과 전체 인증 URL은 저장하지 않는다.

## 10. 전체 수집 전 차단 요소

1. 날짜별 KOSPI/KOSDAQ 전체 상장·상폐 종목마스터 확보
2. 코드변경·합병을 ISIN 또는 영속 식별자로 연결
3. 수정주가 여부 및 기업행위 보정 정책 공식 확인
4. 거래정지와 실제 진입 가능 여부 원장
5. exact-date 시총과 20일 거래대금의 PIT 교차검증
6. 데이터 보유 시작일 2020 제한을 수용할지 결정
7. fixed-current-Universe 결과가 모델 승격에 사용되지 않도록 시스템 차단

## 11. 구현·검증 및 불변성

추가 파일:

- `lib/backfill-data-preflight.mjs`
- `scripts/run-backfill-data-preflight.mjs`
- `scripts/test-backfill-data-preflight.mjs`
- 본 보고서

수정 파일:

- `package.json`

`npm run backfill:data-preflight -- --dry-run`은 최대 10종목, 최대 30요청, 150ms 간격, 동일 요청 cache, 401/403/429 즉시 중단을 적용한다. 합성 pagination·중복·날짜순서·미래날짜·invalid OHLCV·0거래량·429·인증중단·중복요청 테스트가 통과했다.

기존 전체 회귀, TypeScript, 변경 코드 ESLint, Next.js production build, `git diff --check`가 통과했다. A-v1/A-v2/B-v1/C-v1/D-v1 및 market/company/intraday 공식과 production data는 변경하지 않았다. history:resolve, snapshot, seed, 백테스트 latest 생성, 과거 점수·순위 계산, push, 배포는 실행하지 않았다.
