# 홈 연구 대시보드 계약

- 검색은 공통 header로 통합하고 큰 HOME 배너/미연결 지수 카드는 컴팩트한 상태 strip으로 대체한다. 기존 brand/material CSS, 햄버거, 홈 reset 및 종목 검색 요청 격리/AbortController는 유지한다.
- `/api/home-dashboard?topN=5|10|20`: 저장된 Daily EOD native 순위 변화와 전환 요약을 조회한다. 외부 시세 요청, 모델 재계산, 데이터 쓰기 없음. LIVE와 혼합하지 않는다.
- 실제 직전 거래일은 schema/hash 검증된 동일 출처 공식 seed의 직전 일봉 기준일 합의로 확인한다. 그 날짜 snapshot이 없으면 더 오래된 snapshot으로 대체하지 않는다. 전후 formula provenance hash 일치도 요구한다. hash 불일치는 실제 산식 변경이라고 단정하지 않지만 비교 근거 미확인으로 보류한다.
- 진입: 같은 모델 native TOP N에서 전일 N 초과 → 당일 N 이내. 이탈: 전일 N 이내 → 당일 N 초과. 상승: 당일 TOP N에 포함되고 전일보다 native rank 상승. 양일 native ranking universe 교집합에서만 비교한다. 유니버스 편입/제외 TOP은 별도 기록한다. 재순위·common universe 순위 재계산은 하지 않는다.
- 2026-10-06/07은 A~D `sourceManifest.modelFormulaHashes`가 모두 달라 **현재 순위는 표시하되 변화는 비교 보류**다. 파일 줄바꿈/정규화 차이인지 실제 계산 소스 차이인지 이번 작업에서 추측하거나 immutable metadata를 소급 변경하지 않는다.
- 전환 요약은 기존 seed store 캐시를 재사용한다. 조합·상태별 개수와 최대 3개 간격 순 예시. 예시에 동일 기준일 TOP N 교집합 모델 표시; 점수 합성 없음. 전체 원천 REJECTED/partial ranking과 508개 개별 입력 검증을 별도 고지한다.
- 성과는 기존 `/api/model-performance`의 각 모델/TOP N 최신 **확정 1DAY 날짜 단면**을 선택한다. 기간 누적 평균과 다르다. finite outcome N, 평균, 상승비율, 신호일과 평가 종료일을 표시한다. Daily predictive close→close와 LIVE 기존 execution contract는 분리한다. 데이터가 없으면 축적 중이며 0%가 아니다. 우열·유효성 판정 없음.
- 운영 상태는 `/api/daily-production-status`, 검증된 `/api/intraday-model-top`와 LIVE 최신 status metadata를 재사용한다. Actions 실행 시각/결과와 데이터 게시 성공을 구분한다. 기존 API의 lastSuccessAt은 저장 성공시각으로만 표시하며 자동 게시 성공시각으로 위장하지 않는다. 현재 자동 게시 성공 계보가 없으면 명시적으로 확인 불가다.
- 정상: 거래일 상태가 확인되고 예상 공식 거래일과 사이트 게시 기준일이 충족되며 freshness와 게시 일치가 검증된 경우에만. 당일 거래일은 20:30 이전 미게시를 대기, 이후 지연으로 표시. 확인된 휴장/주말은 알려진 직전 거래일로 판단하고 모르는 평일은 임의로 휴장 처리하지 않는다. 달력 근거가 부족하면 확인 불가다. 마지막 데이터의 날짜 나이만으로 정상/장애 판정하지 않는다.
- 서버 요약은 파일 목록/date/mtime/size/연구 규칙 버전/TOP N 캐시와 single-flight 사용. 파일 변경 무효화; 실패한 부분은 30초 뒤 재시도. calendar 현재 시각은 매 요청 재평가. cold 계산 뒤 반복 HOME에서 553개 지표 재계산 없음. Vercel 인스턴스 메모리는 공유되지 않는다.
- 클라이언트 영역별 독립 조회, AbortController/sequence/요청 URL로 stale 결과 차단. 60초 및 visible 복귀 때 갱신; hidden 주기 요청은 생략. 개별 실패를 다른 영역의 성공으로 숨기지 않는다.
- 시장 KOSPI/KOSDAQ/USD-KRW/국내 전체 거래대금은 검증된 기존 endpoint/재배포 권한 계약이 없어 미연결 유지. 종목 유니버스 거래대금을 시장 전체로 합산해 위장하지 않는다.

승인 검토 후보: 공식 hash 정규화 증빙으로 과거 동일 산식 판별, 거래일 달력/자동 게시 성공 계보 보강, 전환 신호의 미래 실전 관측 저장 및 실행 계약. 이 작업은 이를 구현하거나 기존 데이터·자동화·공식·성과 정의를 변경하지 않는다.
