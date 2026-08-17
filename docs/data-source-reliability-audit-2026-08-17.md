# Stock Research v2 데이터 소스 신뢰성 감사 보고서

- 감사일: 2026-08-17
- 대상 프로젝트: `C:\Users\user\Desktop\stock-research`
- 기준 HEAD: `7728101a7cce7195dfc057a4816c1fa395a9ae0a`
- 감사 방식: 로컬 코드·저장 데이터 읽기 전용 분석
- 외부 API 호출: 없음

## 요약 판정

현재 시스템은 운영 화면 참고 및 향후 순위 데이터 축적에는 사용할 수 있지만, 현 상태로 과거 백테스트나 공식 최적화를 시작하기에는 데이터 계보와 재현성이 부족하다.

| 대상 | 판정 |
|---|---|
| A-v1 | RANK_BACKTEST_ONLY |
| A-v2 | PROSPECTIVE_COLLECTION_ONLY |
| B-v1 | RANK_BACKTEST_ONLY |
| C-v1 | RANK_BACKTEST_ONLY |
| D-v1 | RANK_BACKTEST_ONLY |
| 점수 구간 분석 | BLOCKED_PENDING_VALIDATION |
| T+1/T+5/T+20 예측력 분석 | PROSPECTIVE_COLLECTION_ONLY |
| next-open 실매매 백테스트 | PROSPECTIVE_COLLECTION_ONLY |
| 2026-08-13 스냅샷 재현성 | RANK_ONLY_REPRODUCIBLE |
| E 수급 모델 | 데이터 추가 검증 필요 |
| F 평균회귀 모델 | 데이터 추가 검증 필요 |

## 1. 전체 데이터 계보

```text
KIS KOSPI/KOSDAQ 종목 마스터 ─┐
                               ├─ Universe 생성 ─┐
공공데이터포털 공식 일봉 ──────┘                 │
                                                  ├─ 553종목 OHLCV 조회
공공데이터포털 공식 일봉 ─────────────────────────┘
     ↓
기술 factor 계산
     ↓
A-v1 / A-v2 / B-v1 / C-v1 / D-v1 점수
     ↓
모델별 순위
     ↓
data/history/YYYY-MM-DD.json
     ├─ /api/top-stocks → 시장 TOP 종목 화면
     └─ futureReturns / backtestReturns
                            ↑
data/market-prices ─────────┤
data/trading-calendar ──────┘

KIS 조회 시세 ───────────────→ 개별 종목 화면
KIS investor-trend-estimate → 수급 화면
DART 재무제표 ───────────────→ 기업 분석 화면
```

주요 연결 파일:

- `scripts/build-universe.mjs`: Universe 생성
- `scripts/create-daily-model-snapshot.mjs`: 일별 모델 스냅샷과 가격 원장 생성
- `lib/model-score-engine.mjs`: 모델 계산 어댑터
- `lib/market-price-ledger.mjs`: 가격 원장
- `lib/future-return-resolver.mjs`: 미래수익률 보정
- `lib/trading-calendar-status.mjs`: 거래일 상태
- `app/api/top-stocks/route.ts`: TOP50 조회
- `app/page.tsx`: 개별 종목 화면

## 2. 데이터 소스별 등급

| 데이터 | 공급기관·경로 | 기준일·길이 | 사용처 | 등급 | 근거 |
|---|---|---|---|---|---|
| 상장종목 마스터 | KIS ZIP `.mst` | 다운로드 시점 현재 | Universe | PROVISIONAL | 과거 시점 원본·해시 미보존 |
| 일봉 OHLCV | 공공데이터포털 `getStockPriceInfo` | `basDt`, 최대 260행 요청 | Universe·모델·화면 | PROVISIONAL | 수정주가·기업행위·중복·누락 검증 미완료 |
| 시가총액 | 일봉 `mrktTotAmt` | 최신 반환일 | Universe | PROVISIONAL | 정확한 최신일이 없으면 `rows[0]` 사용 |
| 거래대금 | 일봉 `trPrc` 20개 평균 | 최근 반환 20행 | Universe | PROVISIONAL | 고유 거래일 검증 없이 첫 20행 사용 |
| KIS 조회 시세 | `inquire-price` | 응답 영업일·시각 | 개별 종목 화면 | PROVISIONAL | 마지막 조회가이며 실시간 인증·시장상태가 불완전 |
| KIS 수급 추정 | `investor-trend-estimate` | 기준일 미노출 | 수급 화면 | UNKNOWN | 추정 필드 의미·확정성 미검증, 누락을 0 처리 |
| DART 재무제표 | `fnlttSinglAcntAll` | 2025 사업연도 고정 | 기업 분석 | PROVISIONAL | 공시가용시점·정정 이력 미보존 |
| 기업코드 매핑 | DART `corpCode.xml` 결과 | 생성 기준일 미기록 | 재무 API | PROVISIONAL | 원본 버전·해시 없음 |
| history 스냅샷 | 로컬 JSON | 2026-08-13 | TOP50·향후 검증 | PROVISIONAL | 점수·순위는 있으나 원시 OHLCV·공식 해시 없음 |
| 가격 원장 | 로컬 JSON | 신규 스냅샷부터 | 미래수익률 | PROVISIONAL | 구조만 있고 실제 일별 원장이 아직 없음 |
| 거래일 원장 | 로컬 JSON | 명시적 검사일 | T+N 계산 | PROVISIONAL | 평일 휴장 확정 수단 부족 |
| `data/top-stocks.json` | 하드코딩 fixture | 불명 | 개발 fixture | REJECTED | 예시 가격·점수이며 운영 입력 금지 |
| 30종목 검증 JSON | 연구 샘플 | 생성 시점 | 연구 참고 | PROVISIONAL | KIS 실패 시 일봉 fallback |
| 백테스트 집계 JSON | 빈 템플릿 | 스냅샷 0개 | 미사용 | REJECTED | 유효 검증 결과가 아님 |

현재 코드만으로 CERTIFIED 등급을 부여할 수 있는 데이터 소스는 없다. 공식 기관 데이터라도 point-in-time 재현성과 기업행위 처리 검증이 완료되지 않았기 때문이다.

## 3. Universe 553종목 감사

| 단계 | 전체 | KOSPI | KOSDAQ |
|---|---:|---:|---:|
| 전체 마스터 | 4,380 | 2,558 | 1,822 |
| ETF 제거 | 3,217 | 1,395 | 1,822 |
| ETN 제거 | 2,849 | 1,027 | 1,822 |
| 스팩 제거 | 2,778 | 1,027 | 1,751 |
| 우선주 제거 | 2,665 | 917 | 1,748 |
| 시총 필터 | 1,328 | 605 | 723 |
| 거래대금 필터 | 553 | 261 | 292 |

확인 결과:

- 종목코드 중복: 0
- 시가총액 결측: 0
- 20일 평균 거래대금 결측: 0
- 20개 거래행 보유: 553개 전부
- 저장된 시가총액 기준일: `20260813`
- 평균 거래대금: 날짜 내림차순 최근 20행 `trPrc` 평균
- ETF/ETN/스팩/우선주: 마스터 고정폭 필드로 제거
- 리츠: 별도 제외 규칙 없음
- 관리종목·거래정지·상장폐지 예정: 별도 필터 없음

핵심 위험:

1. Universe는 2026-08-16에 내려받은 현재 마스터와 2026-08-13 가격을 결합해 생성됐다.
2. 2026-08-13 당시 사용 가능했던 마스터만 사용했다고 보증할 수 없다.
3. 정확한 기준일 시총 행이 없으면 해당 종목의 `rows[0]`을 사용한다.
4. 종목별 실제 시총 기준일이 저장되지 않아 혼합 기준일 가능성을 사후 확인할 수 없다.
5. `data/universe.json`은 재생성 시 덮어쓰므로 Universe 변경 이력이 별도로 보존되지 않는다.
6. history의 종목 목록으로 당시 사용한 구성은 알 수 있지만 선정 근거 전체를 독립 재현할 수 없다.

판정: **PROVISIONAL**. 2026-08-13 Universe를 point-in-time Universe로 인증할 수 없다.

## 4. 공식 일봉 OHLCV 감사

사용 필드:

- `basDt`: 거래 기준일
- `mkp`: 시가
- `hipr`: 고가
- `lopr`: 저가
- `clpr`: 종가
- `trqu`: 거래량
- `trPrc`: 거래대금
- `mrktTotAmt`: 시가총액
- `fltRt`: 등락률
- `srtnCd`: 단축 종목코드

안전하게 구현된 부분:

- 종목코드의 선행 `A`를 제거한 뒤 정확히 비교
- 스냅샷 생성 전 날짜 내림차순 정렬
- `--date` 실행 시 최신 `basDt`가 요청일과 다르면 실패
- 이전 거래일 값을 요청일 가격으로 대체하지 않음
- 종목별 최신 기준일이 하나로 일치하는지 검사
- 신규 스냅샷 시가는 양수·finite 여부 검사

미흡한 부분:

- 260행을 요청하지만 스냅샷의 최소 요구량은 20행뿐이다.
- 2026-08-13 스냅샷에서 535종목만 260행이고, 18종목은 31~252행이다.
- 날짜 중복·날짜 누락·고유 거래일 수를 검사하지 않는다.
- 모델 계산 전 모든 OHLCV 필드에 대해 양수·finite 검증을 하지 않는다.
- 고가≥저가, 고가≥시가·종가 같은 OHLC 관계를 검사하지 않는다.
- 수정주가 여부와 액면분할·무상증자·합병 반영 정책이 확인되지 않았다.
- 원시 응답 또는 원시 응답 해시를 저장하지 않는다.
- API 사후 정정 시 동일 결과를 재현할 수 있는지 알 수 없다.
- 52주 고저는 실제 고정 52주가 아니라 반환된 전체 행을 사용한다.
- 거래정지·거래량 0 처리 정책이 없다.

| 용도 | 판정 |
|---|---|
| 기술지표 계산 | PROVISIONAL |
| Universe 필터 | PROVISIONAL |
| 신호일 종가 | PROVISIONAL |
| T+1 시가 | 원장 축적 전 PROVISIONAL |
| T+1/T+5/T+20 청산 종가 | 원장 축적 전 PROVISIONAL |
| 화면 최근 종가 | 기준일 라벨이 있을 때만 PROVISIONAL |

## 5. KIS 데이터 감사

### 조회 시세

`app/api/realtime/route.ts`는 다음 값을 사용한다.

- `stck_prpr`: 마지막 조회 가격
- `stck_hgpr`, `stck_lwpr`: 당일 고가·저가
- `acml_vol`: 누적 거래량
- `prdy_vrss`, `prdy_ctrt`: 전일 대비·등락률
- `stck_bsop_date`, `stck_cntg_hour`: 기준일·기준시각

장점:

- 종목코드와 가격 유효성을 검증한다.
- 오류 시 과거 종목 가격을 API fallback으로 반환하지 않는다.
- `isRealtime:false`, `lastQuotedPrice`로 표현한다.
- 현재 history 스냅샷 계산에는 사용되지 않는다.

위험:

- 요청마다 새 액세스 토큰을 발급한다.
- 토큰 캐시·재사용이 없어 반복 호출 시 403 또는 발급 제한 위험이 있다.
- 화면에서 5초마다 조회한다.
- 시장 상태는 주말 `closed`, 평일 `unknown`뿐이다.
- 553종목 대량 수집의 호출 제한과 재현성이 검증되지 않았다.

### 투자자 수급

`app/api/investor/route.ts`는 다음 추정 필드를 사용한다.

- `frgn_fake_ntby_qty`
- `orgn_fake_ntby_qty`
- `sum_fake_ntby_qty`

문제:

- API 경로부터 `investor-trend-estimate`이다.
- 응답 성공 코드·종목코드·기준일·기준시각을 검증하지 않는다.
- 응답이 없으면 수급량을 0으로 바꾼다.
- 요청마다 토큰을 발급한다.
- 확정 수급으로 볼 공식 근거가 현재 코드에 없다.
- 종목 전환 요청 ID 보호가 없어 이전 종목 응답이 늦게 반영될 수 있다.
- 프로그램 순매수 데이터는 구현돼 있지 않다.

판정:

- KIS 조회 시세: `DISPLAY_ONLY / PROVISIONAL`
- investor-trend-estimate: `UNKNOWN`
- 확정 수급 factor 사용: 금지
- 현재 A/B/C/D/A-v2 history 영향: 없음

## 6. A/B/C/D/A-v2 입력 데이터 감사

| 모델 | 주요 입력 | 필요 길이 | 결측 처리 | 데이터 등급 |
|---|---|---:|---|---|
| A-v1 | OHLCV, MA20/60/120, RSI, MACD, 모멘텀, ATR, 52주 위치 | 최대 120+ | 부족 지표가 주로 0점 기여 | PROVISIONAL |
| A-v2 | A-v1과 동일 | 동일 | A-v1 원시점수를 0~100 clamp | PROVISIONAL |
| B-v1 | MA 구조·기울기, 지속성, 모멘텀20, MACD/ATR, 52주 위치 | 최대 120+ | null 입력은 주로 0점 | PROVISIONAL |
| C-v1 | 당일 OHLCV, 등락률, 3/5일 모멘텀, RSI/MACD 변화, MA5/20 | 최대 26+ | 일부 중립값 40/50, 일부 0 | PROVISIONAL |
| D-v1 | B×C/100 | B/C와 동일 | B/C에 전적으로 의존 | PROVISIONAL |

| Factor 그룹 | 최대 점수 영향 |
|---|---:|
| A 모멘텀 | 25점 |
| A 추세 | 20점 |
| A 거래량 | 20점 |
| A MACD | 15점 |
| A RSI | 10점 |
| A 52주 위치 | 10점 |
| A 반전 보너스 | +10점 |
| B MA 구조 | 35점 |
| B 지속성 | 25점 |
| B 모멘텀 | 20점 |
| B MACD | 10점 |
| B 52주 위치 | 10점 |
| C 가격 행동 | 25점 |
| C 거래량 확인 | 20점 |
| C 단기 모멘텀 | 20점 |
| C RSI/MACD 전환 | 20점 |
| C 단기 MA | 15점 |
| C 위험 패널티 | 최대 -35점 |

추가 주의점:

- A-v1 `liveCloses`는 최신 종가를 중복 삽입해 RSI 계산에 영향을 준다.
- 스냅샷은 `realtimePrice=null`로 계산하므로 A-v1 `dailyReturn`이 사실상 0이 된다.
- 이 때문에 당일 급등 패널티가 일봉 스냅샷에서 의도대로 작동하지 않을 수 있다.
- 이는 데이터 출처 오류라기보다 입력 시점과 공식 인터페이스 의미 불일치다.

## 7. 미래정보 누출 검사

| 위험 | 판정 | 근거 |
|---|---|---|
| T+1 가격이 신호 계산에 포함 | 차단됨 | `endBasDt`와 최신 `basDt` 일치 검사 |
| 누락 거래일을 이후 파일로 대체 | 차단됨 | `unchecked/collectionFailed`에서 중단 |
| 최신 Universe를 과거 날짜에 적용 | 가능성 있음 | 현재 마스터와 과거 가격 결합 |
| 현재 시총으로 과거 필터 | 가능성 있음 | exact date 없을 때 `rows[0]` fallback |
| 사후 정정 재무제표 사용 | 가능성 있음 | 공시가용시점 미보존 |
| 생존편향 | 가능성 있음 | 현재 마스터 기반 Universe |
| Universe 탈락 종목의 미래 가격 누락 | 구조상 실제 위험 | 가격 원장은 현재 Universe만 포함 |
| 파일 생성시각과 신호일 혼동 | 메타데이터로 구분됨 | `computedAt`과 `asOfDate` 분리 |
| 브라우저 날짜를 TOP50 기준일로 사용 | 차단됨 | 스냅샷 기준일 사용 |
| 최신 API를 과거 요청일로 대체 | 차단됨 | 날짜 불일치 시 실패 |
| A-v2를 2026-08-13 당시 모델로 취급 | 현재 미발생 | 기존 스냅샷에 A-v2 없음 |
| 일봉 사후 정정 | 확인 불가 | 원시 응답·해시 미보존 |

## 8. 결측·오류·fallback 감사

| 경로 | 동작 | 판정 |
|---|---|---|
| Universe 시총 | exact 기준일 없으면 `rows[0]` | Universe 위험 |
| Universe 거래대금 | 정렬된 첫 20행 | 고유 거래일 검증 전 위험 |
| A/B 입력 결측 | 여러 factor를 0점 처리 | 결측과 약세를 구분 못함 |
| C 거래량 결측 | 중립값 40 | 연구 가정 |
| C RSI/MACD 결측 | 중립값 50 일부 사용 | 연구 가정 |
| 투자자 수급 결측 | 0 | 모델 사용 금지 |
| DART CAPEX 결측 | 0 | FCF 과대평가 가능 |
| `top-stocks.json` | 하드코딩 가격·점수 | REJECTED |
| 기술검증 샘플 | KIS 실패 시 일봉 fallback | 라벨된 연구값 |
| TOP50 API | history 스냅샷 | fixture와 분리돼 안전 |
| 개별 종목 가격 실패 | 이전 가격 state 제거 | 안전 |
| 투자자 응답 지연 | 요청 ID 보호 없음 | stale 화면 가능 |
| 수급 `items[0]` | 정렬·기준일 확인 없음 | 위험 |
| DART 계정 선택 | 같은 이름 첫 행 | 계정 오선택 가능 |

## 9. 2026-08-13 스냅샷 재현성

확인된 상태:

- `schemaVersion`: 2
- `asOfDate`: 2026-08-13
- `computedAt`: 2026-08-16T13:38:15.561Z
- `dataMode`: `official-daily-close`
- Universe 생성시각: 2026-08-16T12:21:09.588Z
- 레코드: 553
- 중복 코드: 0
- 종가 finite: 553
- 시가 저장: 0
- futureReturns finite: 0
- backtestReturns 구조: 없음
- A/B/C/D TOP 목록: available
- Model E: notConfigured

누락된 재현성 정보:

- 원시 260행 OHLCV
- 원시 API 응답 또는 SHA-256
- 종목별 거래 날짜와 중복 검사 결과
- 수정주가·기업행위 정책
- Universe 파일 해시와 마스터 원본
- 데이터 소스 버전
- A/B/C/D formulaHash
- factor 계산에 사용한 전체 원시 입력
- 당시 가격 원장

판정: **RANK_ONLY_REPRODUCIBLE**

저장된 점수와 순위 자체는 검증할 수 있지만 외부 데이터 없이 동일 신호를 독립 재계산할 수 없다.

## 10. 백테스트 적합성

| 대상 | 판정 | 설명 |
|---|---|---|
| A-v1 순위 기반 | RANK_BACKTEST_ONLY | 동일 방식의 연속 축적이 필요 |
| A-v2 순위 기반 | PROSPECTIVE_COLLECTION_ONLY | 과거 스냅샷에 없음 |
| B-v1 순위 기반 | RANK_BACKTEST_ONLY | 공식·데이터 품질 동결 필요 |
| C-v1 순위 기반 | RANK_BACKTEST_ONLY | 동일 |
| D-v1 순위 기반 | RANK_BACKTEST_ONLY | B/C 품질을 상속 |
| 점수 구간 분석 | BLOCKED_PENDING_VALIDATION | 범위·결측·척도 문제 |
| T+1/5/20 예측력 | PROSPECTIVE_COLLECTION_ONLY | 연속 가격 원장 필요 |
| next-open 실매매 | PROSPECTIVE_COLLECTION_ONLY | T+1 공식 시가 필요 |
| 현재 백테스트 JSON | REJECTED | 유효 cohort 0개 |
| 공식 최적화 | BLOCKED_PENDING_VALIDATION | 재현성·point-in-time Universe 미확립 |

현재는 백테스트 집계 엔진보다 데이터 인증과 연속 스냅샷 축적을 먼저 해야 한다.

## 11. E/F 신규 모델 데이터 자격

### E 수급 모델

| 후보 | 현재 상태 |
|---|---|
| 외국인 순매수 | 추정 필드만 존재, 확정성 UNKNOWN |
| 기관 순매수 | 동일 |
| 프로그램 순매수 | 구현 없음 |
| 순매수금액/거래대금 | 확정 수급 금액 없음 |
| 순매수금액/시총 | 동일 |
| 3/5/20일 지속성 | 과거 시계열 없음 |
| 553종목 일괄 수집 | 호출 제한·완료시각 미검증 |
| 당시 시점 재현 | 기준일·원시 응답 저장 구조 없음 |

판정: **E 데이터 추가 검증 필요**. 현재 공식 개발은 보류한다.

### F 평균회귀 모델

공식 OHLCV로 계산 가능한 후보:

- 1/3/5/10일 수익률
- RSI
- 이동평균 이격도
- ATR
- 거래량 변화
- 장중 낙폭
- 갭
- 단기 반전 확인

추가 데이터가 필요한 후보:

- 시장 대비 초과하락: KOSPI/KOSDAQ 지수 일봉 필요

제약:

- 수정주가 여부 미확인
- 기업행위 처리 미검증
- OHLCV 날짜 연속성과 중복 미검증
- 신규상장 종목의 가변 역사 길이
- 시장지수 데이터 없음

판정: **F 데이터 추가 검증 필요**. E보다 준비 수준은 높다.

## 12. 즉시 차단해야 할 경로

다음 데이터는 모델·순위·백테스트 입력으로 사용하면 안 된다.

1. `data/top-stocks.json`의 하드코딩 fixture
2. `investor-trend-estimate`의 `*_fake_ntby_qty`를 확정 수급으로 사용하는 경로
3. 수급 결측을 0으로 바꾼 factor
4. 현재 DART 2025 재무정보를 과거 신호일 재무정보로 사용하는 경로
5. 최신 Universe를 과거 날짜 전체에 소급 적용하는 경로
6. A-v2를 2026-08-13에 사후 산출해 당시 모델처럼 취급하는 경로
7. 가격 원장이 없는 상태의 futureReturns/backtestReturns 집계
8. 수정주가 여부 미확인 일봉의 장기 절대수익률 계산
9. KIS 조회 시세를 기준일·시각 없이 실시간으로 저장하는 경로
10. 샘플 검증 JSON을 전체 Universe 결과로 사용하는 경로

## 13. 추가 검증 대상

1. 공공 일봉의 수정주가·기업행위 반영 정책
2. 동일 요청 반복 결과의 해시 안정성
3. 260행의 고유 거래일 수와 중복 여부
4. OHLC 관계와 거래량 0·거래정지 행 처리
5. 종목별 시총 기준일 exact match
6. KIS 마스터 필드 인덱스와 상품 분류 정확성
7. 리츠·관리종목·거래정지·상장폐지 예정 정책
8. point-in-time Universe 아카이빙
9. KIS 투자자 추정 API의 공식 필드 의미와 확정 시점
10. KIS 토큰 캐시와 호출 제한
11. DART 공시가용일과 정정 이력
12. KOSPI/KOSDAQ 지수 공식 일봉 확보 가능성

## 14. 권장 데이터 품질 메타데이터

아직 구현하지 않았으며 다음 구조를 권장한다.

```json
{
  "dataQuality": {
    "schemaVersion": 1,
    "overallGrade": "PROVISIONAL",
    "asOfDate": "YYYY-MM-DD",
    "computedAt": "ISO-8601",
    "sourceManifest": {
      "version": "v1",
      "universeHash": "sha256",
      "masterSourceHash": "sha256",
      "modelFormulaHashes": {
        "A-v1": "sha256",
        "A-v2": "sha256",
        "B-v1": "sha256",
        "C-v1": "sha256",
        "D-v1": "sha256"
      }
    },
    "coverage": {
      "expected": 553,
      "received": 553,
      "valid": 553,
      "missingCodes": [],
      "unexpectedCodes": []
    },
    "freshness": {
      "requestedDate": "YYYY-MM-DD",
      "minimumBasDt": "YYYY-MM-DD",
      "maximumBasDt": "YYYY-MM-DD",
      "exactMatchCount": 553,
      "staleCount": 0
    },
    "integrity": {
      "duplicateCodes": 0,
      "duplicateCodeDates": 0,
      "invalidOpen": 0,
      "invalidHigh": 0,
      "invalidLow": 0,
      "invalidClose": 0,
      "invalidVolume": 0,
      "invalidOhlcRelationships": 0,
      "insufficientHistory": 0,
      "historyRowDistribution": {
        "260": 553
      }
    },
    "corporateActions": {
      "priceAdjustmentPolicy": "unknown",
      "detectedEvents": [],
      "unresolvedEvents": []
    },
    "universe": {
      "pointInTimeCertified": false,
      "masterAsOfDate": null,
      "marketCapExactDateCount": 553,
      "filterVersion": "v1"
    },
    "certification": {
      "eligibleForDisplay": true,
      "eligibleForRanking": true,
      "eligibleForRankBacktest": false,
      "eligibleForScoreBucketBacktest": false,
      "eligibleForOptimization": false
    },
    "blockingReasons": []
  }
}
```

## 15. 신뢰성 우선 다음 구현 순서

1. 공공 일봉 필드 의미와 수정주가·기업행위 정책 검증
2. OHLCV 정규화 검증기 구축
3. 종목별 원시/정규화 데이터 해시와 source manifest 저장
4. exact-date 시총 필터 적용 및 stale fallback 제거
5. 일별 Universe 버전·해시·필터 결과 아카이빙
6. 신규 스냅샷에 formulaHash와 dataQuality 저장
7. 가격 원장과 거래일 상태를 최소 20거래일 이상 연속 축적
8. 상장폐지·Universe 탈락 종목의 미래 가격 추적 정책 확정
9. rank-only 백테스트 우선 실행
10. 점수 범위와 결측 의미 검증 후 점수 구간 분석
11. next-open 실매매 백테스트
12. F 데이터 검증
13. E 확정 수급 데이터 검증
14. 충분한 out-of-sample 기간 이후 모델 비교·최적화

## 감사 당시 불변성 확인

| 대상 | SHA-256 |
|---|---|
| `data/history/2026-08-13.json` | `5E4D913A832D241C90808583EAEE1EE7C1165535953C7AC1378C8275F8BECDAA` |
| A-v1 | `48CCDEC745C050683A4C994EC308CDDD5A6FA2FFC6640ADB2450A70426CA32A6` |
| A-v2 | `B3578FE7F9452D9CC169F705B0508DE3B6F0F0E1674C5D4E10B7BAC3D358BB2A` |
| B-v1 | `B9A45D38D0398617133CE8C9CE9DD05393BA787C3AD8E032EFC8CB5CEA6052D0` |
| C-v1 | `86F255711483AE949EC913750048461AC3A41B98DC28B2C0E21CA10522B16B8B` |
| D-v1 | `033A5F3E40ADBA3C74360E646B622B95683B1A83805BAEB079227226658E732F` |

감사 과정에서는 코드·스냅샷을 수정하지 않았고 외부 API를 호출하지 않았으며 비밀정보 값을 읽거나 출력하지 않았다.

## 부록: OHLCV·Universe 품질 게이트

`lib/market-data-quality-validator.mjs`는 외부 API나 파일을 직접 다루지 않는 결정론적 순수 함수 검증기다. 입력은 요청 거래일, Universe 레코드, 종목별 일봉 배열, 인증 요구사항이며 결과에는 구조 상태, 보수적 품질 등급, 스냅샷 전달 자격, 전체 이슈, 종목별 이슈와 모델별 계산 자격이 포함된다.

### 등급과 스냅샷 자격

- `REJECTED`: 중복 코드, 필수 종목 누락, 날짜 불일치·미래 날짜·중복 날짜, 잘못된 OHLCV, exact-date 시총 부재 등 구조 오류가 존재한다.
- `PROVISIONAL`: 구조는 통과했지만 수정주가, 기업행위 정책, 원시 응답 manifest, point-in-time 마스터 인증 등이 불완전하다.
- `CERTIFIED`: 구조 검증과 전체 역사 길이를 통과하고 source manifest, 수정주가·기업행위 정책, point-in-time 마스터가 모두 확인된 경우에만 가능하다.
- `eligibleForSnapshot`은 인증 등급과 별개다. 구조 오류가 없고 A-v1/A-v2/B-v1/C-v1/D-v1 전체가 필요한 고유 거래일 수를 충족해야 `true`다.
- `eligibleForOptimization`은 `CERTIFIED`이면서 전체 모델 입력 자격을 충족할 때만 `true`다.

검증기는 결측 factor를 0점이나 중립점으로 대체하지 않는다. 요청일과 최신 `basDt`가 다르거나 exact-date 시총이 없으면 `rows[0]`을 대신 사용하지 않고 실패시킨다.

### 최소 고유 거래일 요구량

| 지표·모델 | 최소 고유 거래일 |
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

A-v2는 A-v1과 동일한 원시 입력 자격을 사용한다. D-v1은 B-v1과 C-v1이 모두 eligible인 종목만 eligible이다. 수정주가 여부와 액면분할·무상증자·합병 등 기업행위 정책은 현재 미해결 상태이므로 실제 데이터가 구조 검증을 통과하더라도 기본 등급은 `PROVISIONAL`이다.
