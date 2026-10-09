# KIS 당일 잠정 EOD — 검증 범위와 운영 차단 조건

## 결론 / 현재 상태

KIS 날짜 지정 일봉과 기존 A-v1/A-v2/B-v1/C-v1/D-v1 엔진을 연결하는 **별도 잠정 계층**을 구현했다. 현재 **운영 수집·공개 게시 모두 비활성**이다. 15:40 데이터의 정규장 완료 여부와 공개 서비스 이용권한을 아직 증명하지 못했으므로, 이를 공식 EOD라고 부르거나 당일 게시가 완료됐다고 보고하지 않는다.

### 실제 읽기 전용 검증 (2026-10-09 KST)

- 005930 삼성전자, 000660 SK하이닉스, 064290 인텍플러스: KIS 일봉 요청 HTTP 200 / business success, 응답 ticker 일치.
- 2026-10-08 지정 요청: 정확한 거래일 존재, OHLCV·거래대금 및 조정 관련 응답 필드 존재. 이 응답은 다음 날 관측이며 **장 마감 직후 가용성을 증명하지 않는다**.
- 2026-10-07 지정 요청: 각 260행 / 3페이지 확보, 5개 모델 출력 존재, 동일 입력 재계산 deterministic.
- 저장된 공공데이터포털 10/07 market seed와 3종목 모두 시가·고가·저가·종가·거래량 일치. 직접 공공 API의 `basDt=20261007` 조회에서도 3종목 모두 OHLCV 및 **거래대금까지 일치(차이 0%)**했다. 최초 진단 스크립트의 기간 필터 조합에서 빈 결과를 받은 것은 exact `basDt` 필터로 재검증·수정했으며 공급처 데이터 부재로 분류하지 않는다. 기존 공식 수집 코드에는 변경 없음.
- 최근 5개 일봉의 수정주가/원주가 OHLC는 3종목 모두 동일했다. 기업행사·전체 이력의 수정주가 정합성을 일반화할 수 없다.
- 실제 553종목 수집, 실제 신규상장/거래정지 사례, 15:40/16:30 가용성과 이후 수정 여부는 미검증. 553개 처리·결측·halt·신규상장 이력 부족은 synthetic fixture로만 검증했다.
- 인증정보·원천 가격은 진단 로그에 출력하지 않았고 실제 후보/공식 데이터도 생성하지 않았다.

## 공급처 근거와 아직 없는 계약

[KIS 공식 일봉 샘플](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_daily_itemchartprice/inquire_daily_itemchartprice.py): `inquire-daily-itemchartprice` / `FHKST03010100`, `J`, `D`, 최대 100행/요청. 이 endpoint는 `FID_ORG_ADJ_PRC=0` 수정주가, `1` 원주가이며 다른 endpoint의 flag 의미를 복사하지 않는다.

[KIS 응답 필드 샘플](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_daily_itemchartprice/chk_inquire_daily_itemchartprice.py): 날짜는 `stck_bsop_date`, OHLC는 `stck_oprc/stck_hgpr/stck_lwpr/stck_clpr`, 거래량/대금은 `acml_vol/acml_tr_pbmn`. **날짜 일치와 HTTP 성공은 일봉 확정 timestamp가 아니다**. source exchange time / finality는 임의 생성하지 않는다. output1 현재가 요약을 과거 날짜 값으로 사용하지 않는다.

[KIS 2026-09-09 공지](https://apiportal.koreainvestment.com/community/10000000-0000-0011-0000-000000000001/post/26dfe350-eb72-48e5-8175-34eb27970f3e)는 9/14부터 KRX 애프터마켓 16:00–20:00 도입을 안내한다. REST `J` 일봉이 정규장만 집계하는지, 후장 합산/수정되는지는 이 공지만으로 확정할 수 없다. 따라서 15:30 또는 15:40이 됐다는 이유로 source finality를 승인하지 않는다.

[KIS 제휴 안내](https://apiportal.koreainvestment.com/provider)는 개인 본인 투자 목적과 제3자 서비스/시세 표시 계약을 구분한다. 공개 GitHub/Vercel 환경에서 두 사람이 이용하는 프로젝트의 저장·원천 시세 재배포·파생 점수 제공 권리는 KIS/KRX의 확인이 필요하다. 현재 원천 시세 공개 경로를 추가하지 않았으며 **파생 점수도 권리 승인 전 게시 차단**한다.

## 구현 흐름과 저장

`run-kis-eod` → HEAD 동결 공식/553 universe/공식 quarantine 검증 → KST 15:30/주말 gate → KIS exact 휴장일 증거 → bounded/throttled KIS 단일 가격 기준 260행 수집 → 기존 OHLC 분류·이력 요구량 → 기존 score engine/rank → private immutable 후보.

- 기본 `npm run kis:eod`: network 0, write 0인 dry-run.
- 명시적 private 수집: `KIS_EOD_COLLECTION_ENABLED=true`와 `--collect-private` 모두 필요. 현재 자동 운영 승인 전에는 활성화하지 않는다.
- `.runtime/kis-eod/calendar`: KIS `chk-holiday` 1일 1회 권고에 맞춘 날짜별 재사용. GitHub cache는 calendar만, 원천 가격/후보/Secret을 저장하지 않는다.
- `.runtime/kis-eod/raw/<date>/<hash>.json`: private 재현용 이력.
- `.runtime/kis-eod/candidates/<hash>/<date>.json`: 입력별 immutable score/eligibility/provenance 후보. 실패·변경된 후속 관측이 앞선 정상 관측을 덮어쓰지 않는다.
- `.runtime/kis-eod/status/latest.json`: 마지막 private 수집 결과와 안전한 실패 코드. `.gitignore` 및 모든 Vercel server trace에서 private namespace 제외.
- `data/kis-eod-published/<date>.json`: **승인된 publisher만** 생성할 수 있는 score-only projection. 원천 OHLCV/가격/거래대금 포함 금지, exact whitelist + 독립 hash 검증, 당일 파일 immutable. 실제 파일 생성 없음.

상태는 `PENDING / COLLECTED / VALIDATED / FAILED / PUBLISHED`를 구분한다. `VALIDATED`는 모델 입력 검증이며 공식 공급처 확정이나 게시 성공을 의미하지 않는다. 첫 미확정 수집을 완성본으로 고정하지 않고 후속 slot에서 다시 관측할 수 있다. 동일 입력은 동일 hash, 달라진 입력은 별도 hash에 보존한다.

공식 snapshot에 있는 quarantine은 새 KIS 시세로 자동 복권하지 않는다. 260거래일이 필요한 A-v1/A-v2/B/D, 34일이 필요한 C는 기존 기준 그대로 적용한다. 필요한 거래대금/입력은 missing이면 실패 또는 제외, 0/시장가치 추정/공식 seed와 혼합하지 않는다. 일간 등락률을 전일 KIS 종가로 파생한 경우 그 basis를 남기며 기업행사일 해석은 추가 검증 대상이다.

공식 hash는 수정하지 않는다. 신규 계층 hash scope는 `currentHEADFormulaSourceFilesLfNormalized`: 현재 5개 공식 파일과 HEAD blob의 CRLF/LF 정규화 후 일치 검증이다. 과거 sourceManifest hash는 그 생성 scope/byte profile과 함께 별도로 보존한다. 과거 hash를 새 hash로 소급 교체하지 않는다.

## API / UI / 성과 격리

- 기존 `/api/top-stocks`, Daily/LIVE workflow, score/rank 계산, outcome/performance 파일은 변경 없음.
- 새 `/api/kis-eod-top-stocks?model=B&limit=5` (`model=A&version=A-v2` 지원), `no-store`.
- `KIS_EOD_PUBLISH_ENABLED=true` + 유효한 승인 projection이 모두 있어야 응답 `available=true`. 현재는 승인 전 상태와 공식 기준일만 반환한다.
- 게시에는 실제 LIVE_COLLECTION, 완전한 비quarantine 수집, ticker/receipt/수정주가 증거, 확인된 session/finality 계약·문서 hash, 파생 게시 권리, 자동화 승인 모두 필요하다. boolean 또는 `"VERIFIED"` 문자열만으로 승격할 수 없다.
- UI는 승인된 **더 새로운 날짜**만 별도 잠정 EOD label로 표시, 공식 기준일도 함께 표시한다. 원천 기준 가격은 null이고 가격 열은 숨긴다. 기존 realtime overlay 정책은 변경하지 않는다.
- **같은 날짜 14:30 LIVE 우선 표시는 보존**한다. 이를 장 마감 잠정 EOD로 자동 대체하는 정책은 이번 범위 검토에서 차단됐고 사용자 승인 대상이다. 새 API에서는 독립 조회 가능하다.
- 잠정 후보/score projection은 official ranking eligibility / backtest / optimization 모두 false. Daily/LIVE 성과 resolver에 입력하지 않는다.

## 비활성 자동화 및 승인 이후 필요한 연결

새 `kis-provisional-eod.yml`은 UTC 평일 06:40, 07:10/40 … 11:10/40 = KST 15:40–20:40, 30분 간격. 현재 코드의 `false` unarmed gate로 승인 변수 값과 무관하게 예약 수집이 차단된다. 운영 승인 후 코드 arm과 repository 변수 exact `true`가 모두 필요하다. 수동 default도 무수집 dry-run이다. 전용 concurrency로 중복 private batch를 직렬화한다. 기존 Cloudflare/공식 Daily/LIVE 운영은 건드리지 않았다.

현재 job은 `contents:read`, private 수집 검증까지만 준비됐다. **공개 stage/commit/push/Vercel 게시 자동화는 아직 연결·활성화하지 않았다**. 공급처 finality/권리/가격 기준을 승인받은 뒤 그 증거 adapter와 score-only allowlist publisher를 연결하고, 기존 non-force Git 충돌 대응 및 전용 API deployment verification을 적용해야 한다. 기존 Daily 배포 검증기의 성과 날짜를 잠정 날짜로 바꾸면 안 된다.

GitHub cron만으로 정확한 시각/무누락 실행을 보장하지 않는다. 신규 KIS 경로의 외부 Cloudflare dispatch는 기존 official Cron과 별도로 승인·검증해야 한다. 정상 16:00–16:30 게시 가능 시각은 공급처 실제 확정시간 + 약 1,659회 기본 history 요청/553종목 수집시간에 의해 결정되며 현재 보장하지 않는다.

## 다음 승인 / 운영 검증

1. KIS `J` daily bar의 정규장/후장 포함 범위 및 완료 시각·기업행사 수정 기준을 공식 확인.
2. private 수집·보관, 파생 score의 공개 GitHub/Vercel 표시 권리 확인. 원천 시세 공개는 별도 승인 없이 금지.
3. 실제 장 마감일 15:40/16:10/16:40의 소수 표본을 후속 공식 EOD와 비교한 뒤 553종목 private batch 검증.
4. 같은 날짜 LIVE와 잠정 EOD의 사용자 표시 우선순위 승인.
5. 위 조건 충족 후 수집/게시 자동화 및 독립 dispatch를 승인하고 GitHub→Vercel→새 API를 실제 검증.

## 추가 실증: 553종목 비공개 감사 (2026-10-09)

이번 승인은 **비공개 수집/검증과 비활성 관측 코드 준비만** 포함한다. 게시·Cron 활성화·Daily/LIVE 변경 승인이 아니다. 로컬 collection/publish flag는 false/미설정으로 유지했고, 기존 Cloudflare Worker `c550f6de-9fc2-44ae-aa35-d044d8096101`의 `DISPATCH_ENABLED=true` 및 `GITHUB_TOKEN` binding 존재를 읽기 전용으로 재확인했다. 기존 Worker/공식 Daily/LIVE 파일은 수정하지 않았다.

### 실제 수집 결과와 해석

- **2026-10-08 이력을 10/09 14:43:01–14:53:55 KST에 조회**했다. 과거 날짜 조회를 장 마감 당시 LIVE 관측으로 위장하지 않았다. 새 `audit-kis-eod-private` CLI는 과거 날짜만 허용하며, 기본 dry-run은 network/write 0이다.
- 요청/처리 553, parser 통과 523, 검증 실패 30, 미처리 0. 실패 30종목은 공식 quarantine 30종목과 정확히 같은 집합이다. 새 KIS 입력으로 복권하지 않았다. 이 batch는 PARTIAL이며 “553종목 검증 성공”이라고 보고하지 않는다.
- 최초 전체 수집 **653.754초(10분53.754초)**. 1,610개 client 요청 시도 모두 HTTP/business 성공, 429/5xx/business failure/retry 0. 요청당 평균45ms/최대287ms, 확보 종목당 평균1,204ms/최대1,355ms. 요청 시간에는 첫 token roundtrip이 포함되며 내부 인증 재발급 HTTP 횟수는 별도 계측하지 않는다. 일반적인 운영 소요시간 보장이 아니라 이 PC에서 실제 측정한 값이다.
- 정상 523종목 모두 날짜 일치, OHLCV·거래대금 존재, ticker/date 중복 0, 원주가 flag1의 KIS 단일 기준. 최종 **보존된** 이력 134,472개이며 API가 각 페이지에서 반환한 전체 행 수와 혼동하지 않는다. 정상 이력/모델/telemetry의 success 저장 약46.06MB(거부 응답/attempt 보고서 용량 별도), Git 미추적 및 Vercel trace 제외.
- 이력이 260거래일 이상인 종목508, 짧은 이력15(67–228행). 이력 부족만으로 신규상장 사실을 단정하지 않는다. A-v1/A-v2/B-v1/D-v1은508개, C-v1은523개 계산 가능했고 같은 입력으로 두 번 계산한 결과 모두 일치했다. 필요한 이력을 임의 생성하지 않는다.
- 실패30개만 한 차례 재조회(523개는 cached raw hash 확인+현재 evaluator로 재검증): 54개 client 요청 모두 성공, 24.573초, 회수0. 비공개 거부 응답30개에서 **거래량0인데 실행 가능한 OHLC가 있는 과거 행211개**를 확인했다. 기존 `zeroVolumeWithExecutableOhlc`/provider `KIS_EOD_OHLCV_INVALID` 정의 그대로 제외했다. 일반 거래정지로 임의 정상화하거나 carry 가격을 만들지 않는다. 검증 통과 자료에는 당일 정상 비거래 관측0개였다.
- 10/07 저장 공식 seed와 공통 날짜를 비교 가능한508개 모두 O/H/L/C/volume 일치. 저장 seed에는 거래대금이 없어 전체 거래대금 비교는 불가능했다. 10/08 표본3개를 실제 공공 API의 exact basDt로 확인한 결과 해당 날짜 item이 없었으므로 **10/08 공식 비교는 미확정**이다. 최근5개 KIS adjusted/unadjusted OHLC는3개 모두 일치하지만 기업행사 전체 이력의 정합성 증명은 아니다.

원천 가격과 후보는 `.runtime/kis-eod/audits/<date>/<manifestHash>/success` 및 `attempts/<actualTime+uuid>`에만 기록한다. raw/validation/telemetry/report는 immutable hash로 보존하며 실패 응답도 private `rejected-responses` 아래 whitelist 필드만 저장한다. 성공 캐시 재검증과 실패만 재요청하므로 재실행이 정상 수집 데이터를 덮어쓰지 않는다. 같은 manifest의 lock은 병렬 batch를 차단하며 중단되어 남은 lock은 확인 후 수동 복구 대상으로, 자동 강제 삭제하지 않는다. 공개 로그는 count/status/hash/timing/code만 포함한다.

```sh
# 기본: API나 private 파일을 만들지 않음
npm run kis:eod-audit -- --date=YYYY-MM-DD --dry-run
# 별도 승인된 과거 날짜의 비공개 실증만 (운영 flag는 활성화하지 않음)
npm run kis:eod-audit -- --date=YYYY-MM-DD --collect-private
```

### 다음 정상 거래일의 세 시점 관측 준비

새 `kis-eod-observation.yml`은 **UTC06:25 = KST15:25 평일 prewarm 후보**이며 static `false` gate로 scheduled/manual collection 모두 비활성이다. 변수만 true로 바꿔도 실행되지 않는다. 수동 default는 network/write 없는 dry-run이다. 기존 별도 전체 수집 workflow 역시 그대로 비활성이다.

- 실제 clock으로15:40/16:10/16:40까지30초 이하 단위 대기, 각 slot의 시작 허용창은 `[slot, slot+5분)`이다. 지연·누락 시 PENDING/지연량을 남기고 과거 시각을 만들어 채우지 않는다.
- 각 slot에 005930/000660/064290를 요청하고 실제 KIS exact calendar, 요청/수신 시각, 반환 거래일, field completeness, adjustment, retry/http telemetry, data hash와 이전 slot 대비 변경을 기록한다. provider 호출시각과 실제 HTTP 시각은 별도로 구분한다.
- `.runtime/kis-eod/observations/<date>/<slot>/<actualTime+hash>.json`은 독립 immutable journal이다. 완료 slot 중복은 skip, 부분 실패는 허용창 내 새 attempt로 재시도, 이전 관측은 보존한다. 후보 data hash가 같아도 실제 receipt 시각은 journal에 따로 남는다.
- 같은 job(90분 한도) 안에서 세 slot을 비교하여 ephemeral runner 간 원천 cache/upload를 만들지 않는다. **GitHub-hosted runner 종료 후 원천 증거는 사라지므로 장기 증거 보관은 아직 미완료**다. 로컬/승인된 private self-hosted 저장소 등 지속 보관 정책은 별도 결정이 필요하다. 공개 GitHub artifact에 raw 데이터를 업로드하는 것으로 해결하지 않는다.
- 실제 관측·예약 활성화는 이번 작업에서 실행하지 않았다. next normal day/slot 결과 및 확정 시점은 미래 실증 대상이다. 안정된 hash만으로 source finality를 인증하지 않는다.

```sh
npm run kis:eod-observe
# 승인 뒤 실제 clock에서만 사용할 준비 명령 (지금 자동 활성화하지 않음)
KIS_EOD_OBSERVATION_ENABLED=true node --env-file=.env.local scripts/observe-kis-eod.mjs --collect-private --wait-for-slots
```

### 증분 수집 연구와 권장 방향

`kis-eod-incremental-research-v1`은 pure research module이며 collector·Production·publisher와 연결하지 않았다. 기존 KIS provider의 최근100행과 동일 source/ticker/unadjusted cache만 병합 후보로 사용한다. 연구용 최소 overlap20행과 실제 공유 전체 구간의 가격/조정/등락 metadata를 정확 비교한다. 수정·기업행사/알 수 없는 공급처 코드·gap·이력 부족·거래정지 경계 이상은 full revalidation으로 전환한다. `0/00/N`을 중립 code로 추측하지 않아 실제 데이터에서 그대로 append를 승인할 수 없으며, 겹침 밖 과거 수정은 단일 page로 탐지할 수 없다.

실제 확보한523개 private history에 planner를 network/write 없이 적용한 결과, **523개 모두 미확인 조정 code 때문에 full revalidation**으로 분류됐고, 이 중15개는 cache 이력 부족도 있었다. 이는523개에 실제 기업행사가 발생했다는 뜻이 아니라, 공급처 중립 code 의미를 아직 검증하지 않아 연구 정책이 보수적으로 차단한 결과다. 현재 이 정책을 운영에 연결해도 요청 절감이 보장되지 않는다.

| 방식 | 성숙한553종목 최소 일봉 요청 | 정합성/비용 |
| --- | ---: | --- |
| A 전체260행 | 1,659/회 | 현재 실측1,610(짧은 이력·중도 거부 포함), 약10분54초. 전체 구간 재확인 가능, 가장 높은 비용 |
| B 최근100행+검증KIS cache | 553/회 | 단순 요청 수는 약1/3. 겹침 밖 수정·기업행사·누락은 보증 불가, 단독 운영 권장하지 않음 |
| C 증분+주기적/이벤트 전체 재검증 | 기본553+fallback | 권장 **후보**. 예시20세션마다 전체로 대체하면 평균최소608.3요청/세션. 20세션은 연구 시나리오이며 승인된 운영 정책이 아님 |

요청 수에서 calendar/token/retry/fallback은 제외한다. 예상 증분 시간은 동일 request latency/throttle만 적용하면약3.6분이지만 **실제 증분553수집은 미실행**이고 source 오류/metadata 차단에 따라 달라진다. cache는 최소260×553=143,780 관측, 현재 확보134,472개의 raw+검증 정보 약46.06MB이다. 주기적 immutable version은 추가 용량을 요구한다. 신규상장은 full backfill/모델별 이력 부족 유지, 원주가/수정주가 혼합 및 공공 seed splice는 금지한다.

fixture에서 증분·전체260행과5개 모델 출력이 일치했지만 실제 corporate metadata code 계약과 외부 구간 수정 대응을 먼저 검증해야 한다. 이번 실증은 **다음날 과거 일봉 확보 가능성**을 증명한 것이며, 당일15:40 가용성·정규장 확정성·게시 이용권한·자동 공개 배포 성공의 증명이 아니다.

### 검증/자체 검토 기록

- KIS EOD suite: Node TAP83개 모두 통과. provider21개/incremental15개의 파일 내 개별 검사를 포함하면 실제 synthetic case117개. 실제 API 수집 결과와 구분한다.
- 추가 기존 회귀: A-v2 source/hash/legacy 결과, Daily production, 14:30 LIVE official signal/API, TOP UI, model performance 모두 통과.
- TypeScript, 변경 JS 관련 ESLint 경고0, Production Build, `git diff --check` 통과. 기존 TOP route의 whole-project tracing 경고는 범위 밖이며 수정하지 않았다. 실제20개 build trace를 확인해 private namespace/.env 참조는0개였다.
- 자체 검토 후 수정: cached verdict 대신 current evaluator 재검증, source operation/date/basis/ticker/receipt 필수 확인, retained/returned row 통계 분리, quarantine과 별개 input/provenance 오류 집계, auth telemetry 정확성, 거부 응답의 private 보존, caller/provider invocation과 실제 HTTP 시각 구분, 미사용 import 제거.
- 새 게시 데이터, 공식 데이터, 기존 immutable artifact, 모델 공식/가중치/순위/성과 정의, 기존 Daily/LIVE/Cloudflare 운영 설정은 변경하지 않았다. 원천 시세/후보/log/환경파일은 커밋하지 않는다.
