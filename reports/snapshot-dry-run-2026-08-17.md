# Snapshot Dry-run Report — 2026-08-17

- 시작: 2026-08-17T05:24:14.984Z
- 종료: 2026-08-17T05:32:28.214Z
- 실행시간: 493.230초
- 최종 판정: **NOT_APPROVED**

## 1. 구현 파일

- `scripts/run-history-dry-run.mjs`
- `lib/dry-run-safety.mjs`
- 기존 `scripts/create-daily-model-snapshot.mjs --dry-run` 경로 재사용

## 2. 쓰기 차단

dry-run은 history·가격 원장·Universe 아카이브 디렉터리 생성, lock/tmp/backup, 거래일 상태 갱신, resolver 실행 전에 종료한다. 허용된 이 보고서만 기록했다.

## 3. API 안전 설정

- endpoint: 공공데이터포털 공식 일봉 getStockPriceInfo
- concurrency: 4
- timeout: 15000ms
- 최대 시도: 3
- 429·5xx·timeout·네트워크 오류만 제한 재시도
- 4xx 인증 오류 재시도 금지
- 인증 파라미터·키 로그 금지

## 4. 실제 수집 통계

| 항목 | 값 |
|---|---:|
| observed Universe | 553 |
| API HTTP 요청 | 553 |
| 성공 종목 | 553 |
| 실패 종목 | 0 |
| timeout | 0 |
| retry | 0 |

## 5. 날짜 freshness

| 항목 | 값 |
|---|---:|
| requestedDate | 2026-08-17 |
| latest basDt 최소 | 20260813 |
| latest basDt 최대 | 20260813 |
| exact-date 일치 | 0 |
| stale | 549 |
| 미래 날짜 | 0 |
| 중복 날짜 | 0 |

## 6. OHLCV 검증

| 항목 | 값 |
|---|---:|
| invalid open | 395 |
| invalid high | 395 |
| invalid low | 395 |
| invalid close | 0 |
| invalid OHLC 관계 | 0 |
| 음수 거래량 | 0 |
| 거래량 0 행 | 395 |
| 음수 거래대금 | 0 |
| exact-date 시총 누락 | 549 |
| 20일 거래대금 날짜 오류 | 0 |

## 7. 역사 길이 분포

| 구간 | 종목 수 |
|---|---:|
| 260일 이상 | 535 |
| 120~259일 | 9 |
| 34~119일 | 3 |
| 34일 미만 | 2 |
| 최소/중앙/최대 | 32 / 260 / 260 |

### atLeast260

100090, 100790, 100840, 101160, 101490, 102710, 102940, 103140, 103590, 104830, 105560, 107640, 108320, 108490, 108860, 111770, 112040, 112610, 114810, 115180, 119850, 120110, 121440, 121600, 122640, 122870, 123330, 124500, 125020, 126340, 126640, 126730, 127120, 128940, 131290, 131970, 137400, 138040, 138080, 138360, 138930, 139130, 139480, 140410, 140860, 141080, 144960, 145020, 159010, 160190, 160980, 161390, 161580, 161890, 166090, 170920, 171090, 174900, 175330, 178320, 180640, 181710, 183300, 187660, 187790, 189300, 189330, 192080, 192820, 194480, 194700, 195870, 195940, 196170, 199430, 200470, 200710, 203650, 204270, 204320, 204620, 207940, 213420, 214150, 214370, 214430, 214450, 217730, 218410, 219130, 222040, 222080, 222800, 226950, 229640, 230240, 232140, 232680, 234340, 237690, 240810, 241560, 241710, 247540, 251270, 251970, 252990, 253590, 257720, 259960, 263750, 264850, 267250, 267260, 267270, 270660, 271560, 272110, 272210, 272290, 277810, 278470, 280360, 281740, 281820, 282330, 285130, 290550, 290650, 290690, 293490, 294870, 295310, 298000, 298020, 298040, 298050, 298380, 302440, 304100, 307950, 310210, 316140, 317400, 319400, 319660, 322000, 322310, 323280, 323410, 326030, 327260, 328130, 329180, 330860, 332570, 333430, 336260, 336570, 340570, 347700, 347850, 348210, 348340, 348370, 352820, 353200, 354320, 356680, 356860, 357780, 357880, 358570, 361610, 368770, 373220, 375500, 376300, 376900, 377300, 382800, 383220, 383310, 388720, 388790, 389260, 389500, 396300, 397030, 399720, 402340, 403870, 413630, 417200, 417840, 419530, 420770, 425420, 437730, 439090, 440110, 441270, 443060, 445680, 448900, 450080, 452260, 452280, 454910, 455900, 456010, 456040, 457190, 458870, 459510, 460930, 463020, 466100, 475150, 475400, 475830, 476060, 482630, 483650, 484810, 489460, 489790, 499790, 900290, 950160, 000020, 000100, 000120, 000150, 000210, 000240, 000250, 000270, 000370, 000400, 000490, 000500, 000660, 000720, 000810, 000880, 000990, 001040, 001120, 001200, 001250, 001290, 001430, 001440, 001450, 001510, 001740, 001800, 001820, 002020, 002380, 002790, 002990, 003030, 003160, 003230, 003280, 003350, 003380, 003490, 003530, 003550, 003670, 003690, 003720, 004000, 004020, 004090, 004170, 004310, 004370, 004430, 004710, 004800, 004990, 005070, 005090, 005290, 005380, 005440, 005490, 005690, 005830, 005850, 005880, 005930, 005940, 005950, 006110, 006220, 006260, 006280, 006340, 006360, 006400, 006650, 006730, 006800, 006910, 007070, 007340, 007390, 007660, 007810, 008770, 008930, 009150, 009420, 009450, 009540, 009830, 009970, 010060, 010120, 010130, 010140, 010170, 010690, 010820, 010950, 011070, 011170, 011200, 011210, 011780, 011790, 011930, 012330, 012450, 012750, 014620, 014680, 014940, 015760, 016360, 017510, 017670, 017800, 017900, 017960, 018260, 018290, 018670, 018880, 019210, 020000, 020150, 021240, 022100, 023160, 023530, 024060, 024110, 024840, 024850, 025320, 025560, 025860, 025980, 026960, 027360, 028050, 028260, 028300, 028670, 029780, 030000, 030200, 030530, 031330, 031980, 032350, 032500, 032580, 032640, 032820, 032830, 033100, 033160, 033240, 033640, 033780, 033790, 034020, 034220, 034230, 034730, 035250, 035420, 035720, 035760, 035900, 036460, 036540, 036570, 036810, 036930, 037070, 037460, 037710, 038500, 039030, 039200, 039440, 039490, 039830, 039860, 041020, 041510, 041830, 042520, 042660, 042700, 043260, 044490, 045100, 046890, 046970, 047040, 047050, 047770, 047810, 047920, 048410, 049070, 049720, 050890, 051160, 051600, 051900, 051910, 052690, 052710, 053260, 053610, 053690, 053800, 055550, 056080, 056190, 058470, 058610, 059090, 059120, 060250, 060280, 060370, 060720, 061970, 062040, 064260, 064290, 064350, 064400, 064760, 065350, 066570, 066590, 066970, 067160, 067290, 067310, 068270, 068760, 069540, 069620, 069960, 071050, 071970, 073240, 073490, 074600, 075580, 077360, 077970, 078350, 078600, 078930, 079160, 079550, 079650, 079940, 080220, 080580, 081660, 082270, 082740, 082920, 083450, 083650, 084370, 085620, 085660, 085910, 086280, 086390, 086450, 086520, 086790, 087010, 088350, 088980, 089030, 089860, 089890, 089970, 090360, 090430, 090460, 090710, 092200, 092790, 092870, 093320, 093370, 094170, 095340, 095610, 096530, 096770, 097230, 097950, 098460, 099320, 099440

### from120To259

125490, 217590, 388210, 439260, 456160, 476830, 486990, 490470, 491000

### from34To119

279570, 439960, 477850

### below34

153890, 475040

## 8. 모델별 eligible·excluded

| 모델 | eligible | excluded | TOP50 가능 |
|---|---:|---:|---|
| A-v1 | 0 | 549 | NOT_APPROVED |
| A-v2 | 0 | 549 | NOT_APPROVED |
| B-v1 | 0 | 549 | NOT_APPROVED |
| C-v1 | 0 | 549 | NOT_APPROVED |
| D-v1 | 0 | 549 | NOT_APPROVED |

제외 사유: `{"staleLatestDate":2745}`

## 9. Common B/C Universe

- activeModels: B-v1, C-v1
- count: 0
- codesHash: `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`

## 10. 품질 판정

- fatal: 2285
- ineligible records: 2745
- warning: 400
- structuralStatus: failed
- overallGrade: REJECTED
- eligibleForSnapshot: false
- eligibleForRanking: false
- eligibleForRankBacktest: false
- eligibleForOptimization: false
- blockingReasons: adjustedPricePolicyUnknown, corporateActionPolicyUnknown, invalidHistoryCodes, invalidPrice, invalidUniverseCodes, latestDateMismatch, missingExactDateMarketCap, pointInTimeMasterNotCertified, rawResponseNotStored, securityStatusUnknown, zeroVolume, zeroVolumeRowsPresent

## 11. Source manifest

```json
{
  "schemaVersion": 1,
  "requestedDate": "2026-08-17",
  "generatedAt": "2026-08-17T05:32:26.898Z",
  "sources": {
    "securityMaster": {
      "provider": "KIS",
      "asOfDate": null,
      "pointInTimeCertified": false,
      "contentHash": null
    },
    "officialDailyPrice": {
      "provider": "공공데이터포털",
      "service": "getStockPriceInfo",
      "requestedDate": "2026-08-17",
      "minimumLatestBasDt": "20260813",
      "maximumLatestBasDt": "20260813",
      "rawResponseStored": false,
      "normalizedInputHash": "0b13f72dc39acbdbd697cc87c2fc4a20f477d388bf8e4e57e215ae114800ebdc"
    }
  },
  "universe": {
    "filterVersion": "v1",
    "contentHash": "032857c64b3d087a7aaf67c1eb182eaabc7fab4b38a7eed8f7bcd3e3b54261d4"
  },
  "modelFormulaHashes": {
    "A-v1": "48ccdec745c050683a4c994ec308cddd5a6fa2ffc6640adb2450a70426ca32a6",
    "A-v2": "b3578fe7f9452d9cc169f705b0508de3b6f0f0e1674c5d4e10b7bac3d358bb2a",
    "B-v1": "b9a45d38d0398617133ce8c9ce9dd05393ba787c3ad8e032efc8cb5cea6052d0",
    "C-v1": "86f255711483ae949ec913750048461ac3a41b98dc28b2c0e21ca10522b16b8b",
    "D-v1": "033a5f3e40adba3c74360e646b622b95683b1a83805baeb079227226658e732f"
  }
}
```

## 12. 표본 진단

### Fatal 최대 20

```json
[
  {
    "severity": "fatal",
    "type": "invalidUniverseCodes",
    "codes": [
      "0009K0",
      "0015N0",
      "0039P0",
      "0126Z0"
    ]
  },
  {
    "severity": "fatal",
    "type": "invalidHistoryCodes",
    "codes": [
      "0009K0",
      "0015N0",
      "0039P0",
      "0126Z0"
    ]
  },
  {
    "severity": "fatal",
    "type": "latestDateMismatch",
    "code": "000020",
    "expected": "20260817",
    "actual": "20260813"
  },
  {
    "severity": "fatal",
    "type": "missingExactDateMarketCap",
    "code": "000020",
    "requestedDate": "20260817"
  },
  {
    "severity": "fatal",
    "type": "latestDateMismatch",
    "code": "000100",
    "expected": "20260817",
    "actual": "20260813"
  },
  {
    "severity": "fatal",
    "type": "missingExactDateMarketCap",
    "code": "000100",
    "requestedDate": "20260817"
  },
  {
    "severity": "fatal",
    "type": "latestDateMismatch",
    "code": "000120",
    "expected": "20260817",
    "actual": "20260813"
  },
  {
    "severity": "fatal",
    "type": "missingExactDateMarketCap",
    "code": "000120",
    "requestedDate": "20260817"
  },
  {
    "severity": "fatal",
    "type": "latestDateMismatch",
    "code": "000150",
    "expected": "20260817",
    "actual": "20260813"
  },
  {
    "severity": "fatal",
    "type": "missingExactDateMarketCap",
    "code": "000150",
    "requestedDate": "20260817"
  },
  {
    "severity": "fatal",
    "type": "latestDateMismatch",
    "code": "000210",
    "expected": "20260817",
    "actual": "20260813"
  },
  {
    "severity": "fatal",
    "type": "missingExactDateMarketCap",
    "code": "000210",
    "requestedDate": "20260817"
  },
  {
    "severity": "fatal",
    "type": "latestDateMismatch",
    "code": "000240",
    "expected": "20260817",
    "actual": "20260813"
  },
  {
    "severity": "fatal",
    "type": "missingExactDateMarketCap",
    "code": "000240",
    "requestedDate": "20260817"
  },
  {
    "severity": "fatal",
    "type": "latestDateMismatch",
    "code": "000250",
    "expected": "20260817",
    "actual": "20260813"
  },
  {
    "severity": "fatal",
    "type": "missingExactDateMarketCap",
    "code": "000250",
    "requestedDate": "20260817"
  },
  {
    "severity": "fatal",
    "type": "latestDateMismatch",
    "code": "000270",
    "expected": "20260817",
    "actual": "20260813"
  },
  {
    "severity": "fatal",
    "type": "missingExactDateMarketCap",
    "code": "000270",
    "requestedDate": "20260817"
  },
  {
    "severity": "fatal",
    "type": "latestDateMismatch",
    "code": "000370",
    "expected": "20260817",
    "actual": "20260813"
  },
  {
    "severity": "fatal",
    "type": "missingExactDateMarketCap",
    "code": "000370",
    "requestedDate": "20260817"
  }
]
```

### Insufficient history 최대 50

```json
[]
```

### Zero volume 최대 20

```json
[
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "000500",
    "date": "20260511",
    "rowIndex": 65
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "000500",
    "date": "20260507",
    "rowIndex": 67
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "000880",
    "date": "20260813",
    "rowIndex": 0
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "000880",
    "date": "20260812",
    "rowIndex": 1
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "000880",
    "date": "20260811",
    "rowIndex": 2
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "000880",
    "date": "20260810",
    "rowIndex": 3
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "000880",
    "date": "20260807",
    "rowIndex": 4
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "000880",
    "date": "20260806",
    "rowIndex": 5
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "000880",
    "date": "20260805",
    "rowIndex": 6
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "000880",
    "date": "20260804",
    "rowIndex": 7
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "000880",
    "date": "20260803",
    "rowIndex": 8
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "000880",
    "date": "20260731",
    "rowIndex": 9
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "000880",
    "date": "20260730",
    "rowIndex": 10
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "001510",
    "date": "20260424",
    "rowIndex": 74
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "001510",
    "date": "20260423",
    "rowIndex": 75
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "001510",
    "date": "20260422",
    "rowIndex": 76
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "001510",
    "date": "20260421",
    "rowIndex": 77
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "001510",
    "date": "20260420",
    "rowIndex": 78
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "001510",
    "date": "20260417",
    "rowIndex": 79
  },
  {
    "severity": "warning",
    "type": "zeroVolume",
    "code": "001510",
    "date": "20260416",
    "rowIndex": 80
  }
]
```

## 13. 모델별 예상 TOP10

### A-v1 — NOT_APPROVED

NOT_APPROVED

### A-v2 — NOT_APPROVED

NOT_APPROVED

### B-v1 — NOT_APPROVED

NOT_APPROVED

### C-v1 — NOT_APPROVED

NOT_APPROVED

### D-v1 — NOT_APPROVED

NOT_APPROVED

## 14. Production 데이터 불변

- SHA 및 파일 목록 전후 동일: **true**

```json
{
  "data/history/2026-08-13.json": "5e4d913a832d241c90808583eaee1ee7c1165535953c7ac1378c8275f8becdaa",
  "data/universe.json": "5e750029d14f8b1263157ad5a0982712bc2a2f25dbb34b47f3604c8116a745f8",
  "data/trading-calendar/status.json": "6dae240d99718976aa392724d00fdd61d03d0fffaa604fdc23716b5d6c2c78dd",
  "data/top-stocks.json": "6c124b73fa8e07c91998e5296e81c6d3e8dea29d195dd90f05de4a298f339bb5",
  "data/model-registry.json": "4bcb29d977b7a1e4ea4643dac6a66291c155c9c500d19c523b101548d5fa89b8",
  "lib/technical-strength.mjs": "48ccdec745c050683a4c994ec308cddd5a6fa2ffc6640adb2450a70426ca32a6",
  "lib/technical-strength-v2.mjs": "b3578fe7f9452d9cc169f705b0508de3b6f0f0e1674c5d4e10b7bac3d358bb2a",
  "lib/trend-strength.mjs": "b9a45d38d0398617133ce8c9ce9dd05393ba787c3ad8e032efc8cb5cea6052d0",
  "lib/entry-strength.mjs": "86f255711483ae949ec913750048461ac3a41b98dc28b2c0e21ca10522b16b8b",
  "lib/combined-technical-score.mjs": "033a5f3e40adba3c74360e646b622b95683b1a83805baeb079227226658e732f"
}
```

## 15. 다음 조치

공식 데이터 게시 또는 fatal 원인 해소 전까지 schema v5 스냅샷을 생성하지 않는다.

## 16. 테스트·빌드

| 검사 | 결과 |
|---|---|
| `npm run data:quality-test` | 24개 통과 |
| `npm run snapshot:quality-test` | 15개 통과 |
| `npm run history:dry-run-test` | 5개 통과 |
| `npm run model:a-v2-test` | 통과 |
| `npm run history:test` | 통과 |
| `npm run history:calendar-test` | 통과 |
| TypeScript (`npx tsc --noEmit --incremental false`) | 통과 |
| 신규·변경 코드 ESLint | 통과 |
| `npm run build` | 통과 |

실제 dry-run에서는 KIS 시세·수급, DART, 주문·계좌 API를 호출하지 않았으며 공공데이터포털 공식 일봉 API만 호출했다.
