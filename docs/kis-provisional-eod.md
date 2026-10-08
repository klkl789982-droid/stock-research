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
