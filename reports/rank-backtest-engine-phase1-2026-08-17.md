# 순위 기반 백테스트 집계 엔진 1단계 보고서

## 1. 선행 체크포인트

- 장중 세션 정책 커밋: `a84ee0db464ca1cc7089544e14df66359d46dbb3`
- 메시지: `feat: add inferred intraday session policy`
- 커밋 직후 작업 트리 clean 확인
- push 및 배포 미실행

## 2. 실제 입력 현황

| 파일 | schema | 종목 | predictive T1/T5/T20 | executable T1 |
|---|---:|---:|---:|---:|
| `data/history/2026-08-13.json` | 2 | 553 | 0 / 0 / 0 | 0 |

- history 파일은 총 1개이다.
- SHA-256: `5E4D913A832D241C90808583EAEE1EE7C1165535953C7AC1378C8275F8BECDAA`
- A-v1/B-v1/C-v1/D-v1 점수와 순위는 저장되어 있다.
- A-v2 저장 점수·순위는 없으므로 A-v1으로 fallback하지 않는다.
- schema v2에는 executable `backtestReturns`가 없으므로 해당 값은 unavailable이다.
- 확정 수익률이 없으므로 실제 성과 통계는 만들 수 없다.

실제 입력 dry-run 상태:

- A-v1/B-v1/C-v1/D-v1: `NO_RESOLVED_RETURNS`
- A-v2: `VERSION_DATA_NOT_AVAILABLE`
- native metrics: 180개 예상
- common metrics: 180개 예상
- 결과 파일 쓰기: 0건

## 3. 생성·수정 파일

신규:

- `config/rank-backtest.json`
- `lib/rank-backtest-engine.mjs`
- `lib/rank-backtest-storage.mjs`
- `scripts/run-rank-backtest.mjs`
- `scripts/test-rank-backtest.mjs`
- `scripts/test-rank-backtest-api.mjs`
- `app/api/backtests/rank/route.ts`
- `reports/rank-backtest-engine-phase1-2026-08-17.md`

수정:

- `package.json`: `backtest:rank`, `backtest:rank-test` 명령 추가

2단계 변경은 커밋하지 않았다.

## 4. 평가 스키마

모델 버전은 A-v1, A-v2, B-v1, C-v1, D-v1을 독립 평가한다. 저장된 해당 버전이 없으면 fallback하지 않는다.

평가 종류:

- predictive: `future1dReturn`, `future5dReturn`, `future20dReturn`
- executable: `nextOpenToT1CloseReturn`, `nextOpenToT5CloseReturn`, `nextOpenToT20CloseReturn`

구간:

- TOP10, TOP20, TOP50
- 상위 10%, 상위 20%
- 전체 eligible Universe

백분위는 저장 `rankPercentile`을 우선 사용하고, 없으면 저장 rank / `rankingUniverseCount`로만 산출한다. 두 정보가 모두 없으면 백분위 구간에서 제외하며 값을 추정하지 않는다.

각 조합에는 signal date/observation/eligible/pending/unavailable 수, 평균·중앙값·표준편차·최소·최대, 양수·음수·0 비율, 일별 동일가중 누적수익률, 조건부 연율 수익률·변동성·Sharpe-like, MDD, 동일 날짜 Universe benchmark, excess return과 cross-sectional spread가 저장된다. 모두 거래비용 차감 전 `grossReturn`이다.

연율 지표는 기본 60 signal dates 이상일 때만 계산한다. 무위험 수익률은 0 가정이다.

## 5. native와 common Universe

- `nativeUniverse`: 각 모델에 실제 저장 점수·순위가 있는 자체 eligible Universe에서 평가한다.
- `commonComparisonUniverse`: 비교 요청된 모든 모델 버전에 저장 점수·순위가 있고, 해당 evaluation/horizon 수익률도 확정된 종목의 날짜별 교집합이다.

두 결과는 별도 배열에 저장하며 혼합하지 않는다. common 결과에는 날짜별 종목 수와 정렬된 종목코드의 `codesHash`를 기록한다.

## 6. 상태 및 품질 정책

지원 상태:

- `READY`
- `PARTIAL`
- `INSUFFICIENT_DATA`
- `NO_RESOLVED_RETURNS`
- `VERSION_DATA_NOT_AVAILABLE`
- `DATA_QUALITY_BLOCKED`

schema 2/3/4/5만 읽고, records 부재·빈 배열·코드 중복 등 구조 오류는 제외한다. `eligibleForRankBacktest: false`는 품질 차단한다. PROVISIONAL은 기본 포함하지만 설정 및 CLI로 구분한다. null/pending/unavailable은 절대 0으로 변환하지 않는다.

## 7. 저장과 실행

실행:

```text
npm run backtest:rank -- --from=YYYY-MM-DD --to=YYYY-MM-DD --models=A-v1,B-v1,C-v1,D-v1 --evaluation=both --include-provisional
npm run backtest:rank -- --dry-run
```

일반 실행은 다음에 저장한다.

- `data/backtests/rank-evaluation/latest.json`
- `data/backtests/rank-evaluation/runs/{generatedAt-safe}.json`

latest 교체는 lock, tmp, backup, atomic rename을 사용한다. 실패 시 기존 latest를 복구한다. 동일 입력과 설정의 `contentHash`는 `generatedAt`을 제외해 결정론적으로 유지한다.

이번 작업에서는 dry-run만 실행했으며 `latest.json`은 생성되지 않았다.

## 8. 조회 API

- `GET /api/backtests/rank`
- `GET /api/backtests/rank?model=B-v1&horizon=T5&evaluation=predictive`

API는 `latest.json`만 읽고 집계나 모델 계산을 실행하지 않는다. 결과가 없으면 HTTP 404와 `BACKTEST_RESULT_NOT_AVAILABLE`을 반환한다.

## 9. 합성 및 회귀 테스트

합성 테스트 통과 항목:

- predictive/executable 완전 분리
- pending/null 비제로 처리
- TOP10/20/50 및 백분위 정확성
- native/common Universe 분리와 codesHash
- 날짜별 동일 Universe benchmark와 excess return
- 평균·중앙값·표준편차·양수 비율
- 동일가중 누적수익률 및 MDD
- 모델 버전 fallback 금지
- 데이터 부족·무확정 수익률 상태
- 결정론적 hash
- atomic 저장 실패 시 기존 latest 보존
- lock/tmp/backup 정리
- intraday import/사용 금지
- API 조회 전용 구조

전체 기존 장중/시장/기업/KIS/data quality/snapshot/dry-run/TOP/A-v2/history/calendar 테스트도 통과했다. TypeScript, 변경 코드 ESLint, `git diff --check`, Next.js production build도 통과했다.

## 10. 불변성과 제한

- A-v1/A-v2/B-v1/C-v1/D-v1 공식 변경 없음
- market/company/intraday 분석 공식 변경 없음
- history, Universe, TOP cache, 가격 원장, trading calendar, model registry 변경 없음
- 외부 API, snapshot, seed, history resolver, push, 배포 미실행
- 실제 백테스트 결과 파일 미생성

실제 집계를 위해서는 여러 거래일의 snapshot과 각 horizon별 확정 `futureReturns` 또는 `backtestReturns`가 필요하다. 최소 60 signal dates 전에는 연율 지표를 제공하지 않으며, 현재 한 날짜·0개 확정 수익률 상태에서는 모델 성능을 판정할 수 없다.
