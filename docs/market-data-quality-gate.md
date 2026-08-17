# Market Data Quality Gate

신규 일별 스냅샷은 공식 일봉을 전부 메모리에 수집한 뒤 데이터 품질 검증을 통과해야만 모델 계산을 시작한다. 기존 `data/history/2026-08-13.json`에는 이 정책을 사후 적용하지 않는다.

## 실행 순서

1. 거래일과 Universe 확인
2. 관찰 Universe 전체 일봉 수집
3. 날짜·코드·OHLCV·시총·거래대금 구조 검증
4. fatal 이슈가 있으면 산출물 없이 중단
5. 모델별 고유 거래일 자격 결정
6. 적격 모델만 계산하고 모델별 Universe 안에서 순위 부여
7. source manifest, dataQuality, Universe 요약, 제외 목록 생성
8. history, 가격 원장, 날짜별 Universe 아카이브를 임시 파일로 검증
9. 세 산출물을 확정하고 마지막에 거래일 상태를 성공으로 갱신
10. `history:resolve` 실행

## 이슈 심각도

- `fatal`: 날짜 불일치, 필수 history 누락, 코드·날짜 중복, 미래 날짜, invalid OHLCV, exact-date 시총 누락. 스냅샷과 가격 원장을 생성하지 않는다.
- `ineligible`: 모델별 역사 길이 부족. 관찰 Universe에는 남기되 해당 모델의 점수와 순위를 `null`로 유지한다.
- `warning`: 거래량 0, 수정주가·기업행위·point-in-time 마스터·종목 상태 미인증, 원시 응답 미보존. 생성은 허용하지만 품질은 `PROVISIONAL`이다.

## Universe 구분

- `observedUniverse`: 시총·거래대금 필터를 통과해 당일 관찰한 전체 종목
- `modelEligibleUniverse`: 각 모델이 계산 가능한 종목
- `commonComparisonUniverse`: `config/snapshot-quality-policy.json`에 등록된 비교 모델들의 교집합

현재 비교 정책은 B-v1과 C-v1이다. A-v2는 challenger 상태를 유지하며 자동 승격하지 않는다.

## 순위 백분위

모델별 순위는 해당 모델의 적격 Universe에서 1부터 N까지 부여한다.

```text
rankPercentile = rank / rankingUniverseCount
```

기존 A-v1/B-v1/C-v1/D-v1 동점 정렬은 점수 내림차순 뒤 입력 순서를 유지한다. A-v2는 finalScore, rawScore, code 순서를 유지한다. 공식과 가중치는 이 연결 작업에서 변경하지 않았다.

## 해시와 재현성

- canonical JSON은 객체 키를 정렬한다.
- Universe와 종목은 code 오름차순이다.
- 일봉은 종목별 `basDt` 내림차순이다.
- 인증키, 토큰, 인증 파라미터는 manifest와 해시 입력에 포함하지 않는다.
- 원시 응답을 저장하지 않으므로 `rawResponseStored=false`이며, normalized hash만으로 완전 재현 가능하다고 간주하지 않는다.

## 날짜별 Universe 아카이브

신규 성공 실행부터 `data/universe-history/YYYY-MM-DD.json`에 기록한다. 동일 날짜·동일 content hash는 멱등으로 인정하며 다른 hash는 충돌로 중단한다. 기존 2026-08-13 Universe는 사후 생성하지 않는다.

## 가격 추적 Universe

가격 원장은 오늘 관찰 Universe와 과거 스냅샷에서 T+20까지 미확정인 종목의 합집합을 추적한다. 과거 종목이 오늘 Universe 밖이면 기존 공공 일봉 조회 경로로만 추가 조회한다. 조회 불가 항목은 `trackingPriceUnavailable`에 기록하며 가격이나 수익률을 0으로 대체하지 않는다.

## 스키마 호환성

신규 history schema는 version 5다. 읽기 호환 버전은 2, 3, 4, 5다. resolver의 불변 view는 `futureReturns`와 `backtestReturns`만 변경 허용 대상으로 제거하므로 source manifest, dataQuality, Universe 요약, 제외 목록과 순위 메타데이터는 자동으로 불변 보호된다.
