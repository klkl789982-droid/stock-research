# 전환 신호 스크리너 v1

## 운영 계약

- 규칙: `ma-cross-observed-v1`. 5/20, 20/60 조합 모두 **이전 확정 거래일 단기 MA ≤ 장기 MA, 현재 확정 거래일 단기 MA > 장기 MA**일 때만 `교차 발생`.
- 그 외 검증 가능한 관측은 `신호 없음`. 결측은 신호 없음으로 분류하지 않고 제외한다. 매수 추천·상승 확률이 아니다.
- 위 유지 거래일 수와 관측된 교차일은 사실값이다. 교차가 최근 60개 관측 범위 전이라면 교차일은 미확인, 유지 일수는 하한값이다. 교차 후 확인으로 자동 해석하지 않는다.
- 상대 간격: `(단기 MA / 장기 MA - 1) × 100`. 간격 정렬은 절대값 기준.
- RSI14, MACD/Signal, 거래량 및 MA는 기존 `calculateMarketAnalysis`를 재사용한다. MACD 상승/하락은 기존 MACD/Signal 대소 관계다. 거래량 x는 기존 당일 포함 20개 거래일 평균 대비 %를 100으로 나눈 값이다.
- A-v1/B-v1/C-v1/D-v1 점수는 동일 날짜 Daily snapshot에서 조회만 한다. 모델 공식·순위·성과 정의는 수정하지 않는다.

## 데이터·성능·UI

`data/history` 최신 파일 → **동일 날짜** `data/analysis/market-seeds` → 기존 seed schema/전체 hash 검증 → 출처 hash·구조 품질·공식 거래일 확인 → 개별 eligibility·기준일·최신 60개 일봉 정합성 확인 → 기존 지표 계산 → 전환 관측 → AND 조건검색.

- 최신 seed가 없으면 503. 이전 기준일로 조용히 후퇴하지 않는다. 외부 API 요청과 데이터 쓰기 없음.
- 신규 상장·이력 부족·격리·무거래·알려진 휴장일 봉·기준일 불일치·일봉 누락 제외. 260개 기존 seed 기준을 완화하지 않는다. 완전한 과거 거래일 마스터·조정주가·기업행위 인증은 아직 없으며 기존 한계를 고지한다.
- 데이터 부족 / 선택 필터의 입력 결측 / 조건 미충족은 우선순위별 중복 없는 제외 수다. 모델 조건을 켜지 않으면 해당 모델의 결측만으로 제외하지 않는다. 결측 정렬값은 오름/내림 모두 마지막.
- 전체 원천 품질 등급과 부분 ranking을 숨기지 않고 개별 입력 검증 상태와 구분한다.
- 파일 날짜·mtime·size 기반 단일 Node 메모리 캐시, 동일 요청 single-flight. 파일 변경 즉시 무효화. Vercel 인스턴스끼리는 메모리를 공유하지 않는다. 별도 인프라 도입 없음.
- `/api/screener?tab=transition&pair=5-20`의 `state`, `market`, `rsiMin/Max`, `macd`, `volumeMin/Max`, `changeMin/Max`, `scoreA/B/C/D`가 AND로 적용된다. 기존 `tab=models`/모델·기업 필터 계약은 보존한다.
- 신호·절대 간격·거래량·선택 모델 점수·종목명 정렬. 모바일은 카드 형태, 한 번에 30종목 렌더링. AbortController/sequence로 이전 검색·unmount 응답을 차단한다.

## 승인 전 연구 제안 (운영 미적용)

`ma-transition-research-candidate-v1`:

1. 접근 중: 단기선 아래, 최근 3개 확정 관측의 절대 상대 간격 연속 축소, 단기선 기울기 양수 및 개선.
2. 교차 후 확인: 관측된 교차 이후 3개 확정 거래일 연속 단기선 위 유지.

3관측은 단일 일봉 흔들림을 줄이기 위한 **초기 연구 가설**이지 검증된 최적값이 아니다. 발견 지연/표본 감소라는 부작용이 있다. 사용자가 승인하기 전 계산·필터 운영에 적용하지 않는다. UI에서는 비활성 옵션이다. 기존 모델이나 저장 지표의 `crossSignal` 의미를 바꾸지 않는다.

## 미래 성과 준비 계약

순수 `createTransitionObservationSnapshot`은 `transition-signal-observations` / `DAILY_EOD_TRANSITION` 별도 schema와 canonical hash를 제공한다. 날짜·종목·조합·규칙 버전별 observation ID, 당시 가격/지표/저장 점수/품질, seed 및 가격 출처 hash와 공급 가용시각 metadata를 보존할 수 있다.

향후 경로 후보: `data/transition-signals/eod/YYYY-MM-DD/ma-cross-observed-v1.json`, outcome은 별도 `transition-outcomes` 네임스페이스. 현재 조회는 파일을 생성하지 않는다. 1D/5D/20D는 계약상의 추적 대상만 기록하고 미래 수익률을 만들지 않는다. 진입가격 계약은 `null`, 결과는 `NOT_OBSERVED`.

자동 immutable 저장·진입가격 계약·거래일 maturity resolver 연결은 별도 승인 후 진행한다. Daily/LIVE의 기존 signal 또는 outcome은 수정·재계산·혼합하지 않는다. 사후 조회를 당시 이용 가능했던 실전 관측으로 위장하지 않는다.

## 조사 중 발견한 기존 데이터 한계

2026-10-07 저장 `market` snapshot은 기존 `validateMarketAnalysisSnapshot`에서 contentHash 불일치가 확인됐다. 이 작업은 해당 snapshot을 수정하지 않고, hash 검증을 통과한 동일 출처 `market-seeds`와 기존 계산기로 지표를 만든다. hash 불일치 원인과 기존 자료의 재검증/승격 방식은 별도 작업으로 결정해야 한다.
