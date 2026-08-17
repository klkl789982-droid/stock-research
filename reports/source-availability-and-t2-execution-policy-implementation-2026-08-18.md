# Source availability 및 T+2 실행정책 구현 보고서

## 결과

- 1단계 감사 보고서 커밋: `1e2f6293c115f94c1b43a6c6a1fcb643c310ff9a`
- 신규 기본 실행정책: `public-eod-t2-open-v1`
- 기존 `futureReturns`, `backtestReturns` 공식·값·필드 유지
- 기존 schema 2/3/4/5 읽기 호환, 신규 생성 버전 6
- 외부 API·production 생성·실제 resolver·실제 backtest 미실행

## schema v6

최상위에 market date, 정책 게시 근거, 실제 수집 관측시각, 계산 완료시각,
commit-intent 시각 및 timing evidence를 분리 저장한다. 실제 레코드 게시시각을
원천이 제공하지 않으므로 `sourcePublishedAt`은 null이다. `generatedAt`을 대신 쓰지
않는다. 각 레코드는 정책별 실행수익률 envelope와 legacy 분류 메타데이터를 가진다.

## 원자성과 결정론

atomic commit 직전 하나의 availability timestamp를 고정해 모든 신규 snapshot
메타데이터에 사용한다. 파일 저장 후 timestamp를 넣기 위한 재작성은 하지 않는다.
이 값은 commit-intent 시각이며 실제 rename 완료시각은 향후 immutable run manifest의
책임으로 분리했다. 정책 hash는 키 정렬 canonical JSON으로 결정론적으로 계산한다.

## T+2/H1/H5/H20

T+2는 신호일 이후 두 번째 검증 거래일이며 진입가는 09:00 KST 공식 시가다. H1은
진입일 종가, H5/H20은 진입일 포함 5/20번째 검증 거래일 종가다. timing은
`signalAvailableAt < entryTimestamp`만 유효하다. 결과는 소수점 6자리 gross return이며
비용·슬리피지는 없다.

## Resolver와 집계

신규 resolver는 schema v6만 처리하며 legacy resolver 뒤의 독립 adapter다. 불변 view는
`futureReturns`, `backtestReturns`, `executionReturnsByPolicy` 외 필드를 보호한다. 집계 CLI는
`--execution-policy`를 지원하며 기본값은 신규 정책이다. legacy는 명시 요청과 경고가
필요하다. POLICY_ESTIMATED와 VERIFIED timing metrics는 별도 출력한다.

## 적용 전 차단 조건과 위험

- 실제 schema-v6 snapshot과 가격 원장 연속성이 아직 없음
- 거래정지/상장폐지/합병/코드 변경을 완전 판별할 공식 point-in-time 자료가 없음
- source publishedAt은 정책 추정이며 개별 레코드 관측값이 아님
- 실제 atomic commit 완료시각 run manifest는 아직 production 실행으로 검증되지 않음
- 거래비용·슬리피지 미반영
- 최적화 및 모델 승격에는 별도 사용자 승인 필요

## 생성·수정 파일

신규 파일은 실행정책 config, source availability 모듈, 정책별 resolver, 두 합성
테스트, 정책 문서와 이 보고서다. 기존 수정 파일은 model-history schema,
future-return 불변 view, snapshot 생성기, history resolver adapter, rank backtest
engine/runner/API 계약 테스트, dry-run v6 표기, 관련 회귀 fixture, package scripts와
기존 backtest 문서다. A-v1/A-v2/B-v1/C-v1/D-v1 및 market-analysis-v1 공식 파일은
수정하지 않았다.

## 검증 결과

- source availability 정책 hash·결정론: 통과
- T+2, 휴장일 제외, unchecked/collectionFailed 차단: 통과
- H1/H5/H20, timing 경계, 누락 시가, 멱등성: 통과
- predictive/legacy 불변 및 기존 calendar resolver: 통과
- 신규 정책 rank 집계, timing evidence 분리, legacy 명시 사용: 통과
- schema 2/3/4/5/6 읽기 호환: 통과
- data quality 24개, snapshot quality 15개, dry-run safety 5개: 통과
- market/company/intraday/KIS 관련 회귀: 통과
- TypeScript `tsc --noEmit`: 통과
- 변경 코드 ESLint: 통과
- `npm run build`: 통과
- `git diff --check`: 통과

보호 데이터 Git diff는 0건이다. `data/history/2026-08-13.json` SHA-256은
`5e4d913a832d241c90808583eaee1ee7c1165535953c7ac1378c8275f8becdaa`로 유지됐다.
production data, 외부 API, 실제 dry-run/snapshot/resolver/backtest output은 생성하지
않았다.

## 실제 첫 적용 조건과 추가 승인

실제 적용에는 공공 일봉 게시 완료 후 schema-v6 snapshot 생성 승인, daily-run
manifest의 실제 commit 완료시각 저장 정책 확정, 연속 거래일 가격 원장 확보,
거래정지/기업행위 point-in-time 처리 정책 확정이 필요하다. 거래비용·슬리피지 모델,
POLICY_ESTIMATED 결과의 executable 결론 사용, 모델 최적화·승격은 각각 별도 승인이
필요하다.
