# Daily EOD 운영 진단과 검증 범위

## 2026-10-09 KST 진단

- GitHub public Actions API에서 Daily workflow 활성/default main을 확인했다. 마지막 실행은 #12, 2026-10-08 02:56:34 KST, source commit `6fc41bb`. 당시 cron은 UTC `37 11 * * 1-5` (20:37 KST) 단일 슬롯이었다. 직전 날짜 슬롯과 비교하면 약 6시간 19분 늦었으나 GitHub의 내부 enqueue 원인은 공개 기록만으로 확정할 수 없다.
- #12는 공공데이터 최신 `basDt=20261006`을 받았고 553종목 파이프라인/승격/push를 완료했다. 10월 8일 저녁 실행 기록은 진단 시점에 없다. 품질 실패나 push 실패 로그가 있는 것이 아니다.
- 하루 5회 예약/260행 누락 복구 개선 `74501c1`은 10월 9일 00:31:28 KST commit, Vercel 성공 상태는 00:32~00:33 KST다. 따라서 개선 코드가 10월 8일 저녁에 이미 운영됐다고 볼 수 없다. 00:17 슬롯은 코드 반영 전에 지났으며, 02:17 슬롯 실행 기록은 아직 없었다. 누락/지연의 내부 원인은 미확정이다.
- 10월 9일 02:55 KST 실조회: canonical unbounded 260행 최신일 10/07, 10/08 정확한 날짜의 전체 시장 totalCount=0, 대표 3종목도 HTTP 200/business success/0건. 공급되지 않은 10/08을 후보로 강제 생성하지 않았다. 이 관측은 현재 공급 상태만 증명하며 10/08 저녁의 모든 API 상태를 소급 증명하지 않는다.
- Git history/model-history 및 배포 API EOD는 10/07, 최신 확정 성과 단면은 10/06→10/07이다. Vercel 성공과 API 기준일 일치를 확인했다. 현재 새로운 EOD가 Git에는 있는데 배포만 늦은 상황은 아니다.

## 최소 수정

`NO_NEW_OFFICIAL_EOD`에서는 이전 workflow가 freshness status stage/commit을 생략했다. probe가 성공해도 사이트의 마지막 점검 시각/사유는 낡은 채 남았다. 이제 상태 파일만 정상 게시하며, 가격·모델·성과 artifact는 계속 `CANDIDATE_VALIDATED`에서만 allowlist로 승격한다. trigger 종류/실제 schedule expression/시작시각도 secret-safe 로그와 job summary에 남긴다. 기존 cron·공식·품질·LIVE·immutable 자료는 변경하지 않는다.

`fresh`는 관측된 공급 최신일과 저장 snapshot 일치라는 기존 의미다. 공급 최신일이 최신 **실제 거래일**이라는 보장은 아니다. 시장 휴장/거래일 근거가 없으면 이를 임의로 추정하지 않는다. NO_NEW 체크는 성공한 새 EOD 게시와 별도이며 마지막 성공시각을 갱신하지 않는다.

## 자동 복구 경로와 한계

- 새 공식 일봉이 공급되면 같은 scheduled command가 260행의 관측 거래일 목록에서 저장일 이후 가장 오래된 누락일을 선택한다. 한 실행에서 한 거래일을 처리하며 이후 슬롯에서 나머지를 순차 처리한다. 공급일이 그대로면 NO_NEW와 체크 상태만 게시한다.
- probe의 일시적 네트워크/timeout/5xx는 기존 최대 3회, 1초/2초 backoff. 공급 자체 지연은 후속 예약 슬롯에서 다시 조회한다. 4xx/business/invalid response를 무조건 반복하지 않는다.
- Git push는 기존 제한된 non-force fetch/rebase 재시도, 새 승격은 기존 Vercel/API 검증기를 통과해야 한다. 일반 unit/fixture는 이것을 미래 실거래일의 무인 성공으로 대체하지 못한다.
- 같은 GitHub 스케줄러의 다중 cron은 공급 지연과 일부 슬롯 누락을 보완하지만 스케줄러 전체 장애나 모든 이벤트 누락을 보장 해결하지 않는다. 공개 GitHub 문서도 schedule 지연/드롭 가능성을 명시한다.
- 공공데이터가 당일 20:30까지 공급되지 않으면 현재 소스로 그 SLA를 달성할 수 없다. KIS 장중 quote를 공식 일봉처럼 대체하거나 API key가 없는 새 source를 임의 추가하지 않는다.

## 독립 실행 경로 (사용자 설정 필요, 미도입)

사용자가 운영 주체를 선택하면 기존 `workflow_dispatch`를 **기계적으로** 호출하는 별도 스케줄러를 구성할 수 있다. 수동 실행을 정상 운영 해법으로 삼는다는 뜻은 아니다.

1. 항상 켜진 사용자 소유 PC의 Task Scheduler/systemd timer, 또는 별도 승인한 외부 scheduler 선택. GitHub cron과 장애 도메인이 분리돼야 한다.
2. 해당 repo 한 곳으로 한정된 GitHub App 또는 fine-grained token의 Actions write 권한을 사용자가 생성/보관. 코드·query·로그에 token을 넣지 않는다. 외부 서비스로 credential을 전송하려면 별도 승인한다.
3. KST 18:47/20:17/22:17/다음날 00:17/02:17에 `POST /repos/klkl789982-droid/stock-research/actions/workflows/daily-production.yml/dispatches`, body `{"ref":"main"}`. 날짜 입력 없이 기존 자동 거래일 선택을 사용한다. 원래 workflow concurrency/idempotence/quality gate를 유지한다.
4. 요청 accepted만으로 완료 처리하지 않는다. run 생성→runner 시작→결과→게시→site API 날짜를 감시한다. GitHub runner 장애까지 독립해야 한다면 별도 self-hosted 실행 환경이 필요하며 설치/권한/운영 승인이 필요하다.
5. 실제 미래 거래일의 예약 실행, 공급 후 누락 회수, 정상 게시/Vercel 반영은 앞으로 관측할 미검증 항목이다. 이 설정을 하지 않고 완전한 독립 복구 경로가 존재한다고 주장하지 않는다.
