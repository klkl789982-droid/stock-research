# Market analysis snapshots

`npm run history:daily -- --date=YYYY-MM-DD`가 품질 검증을 통과한 공식 일봉으로 생성하는 조회 전용 산출물 경로입니다.

- 파일명: `YYYY-MM-DD.json`
- 가격 기준: `officialDailyClose`
- 계산기: `market-analysis-v1`
- KIS 현재가와 장중 OHLCV는 입력에 포함하지 않습니다.
- 기존 파일은 덮어쓰지 않습니다.

이 디렉터리의 실제 일별 파일은 운영 명령으로만 생성합니다. 이 구현 작업에서는 production 스냅샷을 생성하지 않았습니다.
