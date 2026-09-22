# Schema v6 Full-Universe Dry-run — 2026-08-20

- 체크포인트 커밋: `e4920b47f244623bd35df361b7f0ecf056f929ff`
- 실행 ID: `schema-v6-dry-run-20260821083513`
- 시작: 2026-08-21T08:28:55.810Z
- 종료: 2026-08-21T08:35:13.503Z
- 실행시간: 377.693초
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
| requestedDate | 2026-08-20 |
| latest basDt 최소 | 20260820 |
| latest basDt 최대 | 20260820 |
| exact-date 일치 | 553 |
| stale | 0 |
| 미래 날짜 | 0 |
| 중복 날짜 | 0 |

## 6. OHLCV 검증

| 항목 | 값 |
|---|---:|
| invalid open | 0 |
| invalid high | 0 |
| invalid low | 0 |
| invalid close | 0 |
| invalid OHLC 관계 | 0 |
| 음수 거래량 | 0 |
| 거래량 0 행 | 363 |
| 음수 거래대금 | 0 |
| exact-date 시총 누락 | 0 |
| 20일 거래대금 날짜 오류 | 0 |

## 7. 역사 길이 분포

| 구간 | 종목 수 |
|---|---:|
| 260일 이상 | 506 |
| 120~259일 | 40 |
| 34~119일 | 7 |
| 34일 미만 | 0 |
| 최소/중앙/최대 | 35 / 260 / 260 |

### atLeast260

100090, 100790, 100840, 101160, 101490, 102710, 102940, 103140, 103590, 104830, 105560, 107640, 108320, 108490, 108860, 111770, 112040, 112610, 114810, 115180, 119850, 120110, 121440, 121600, 122640, 122870, 123330, 124500, 125020, 126340, 126640, 126730, 127120, 128940, 131290, 131970, 137400, 138040, 138080, 138930, 139130, 139480, 140410, 140860, 141080, 144960, 145020, 159010, 160190, 160980, 161390, 161580, 161890, 166090, 170920, 171090, 174900, 175330, 178320, 180640, 181710, 187790, 189300, 189330, 192080, 192820, 194480, 194700, 195870, 195940, 196170, 199430, 200470, 200710, 203650, 204270, 204320, 204620, 213420, 214150, 214370, 214430, 214450, 217730, 218410, 219130, 222040, 222080, 222800, 226950, 229640, 230240, 232140, 232680, 234340, 237690, 240810, 241560, 241710, 247540, 251270, 251970, 252990, 253590, 257720, 259960, 263750, 264850, 267250, 267260, 267270, 270660, 271560, 272110, 272210, 272290, 277810, 278470, 280360, 281740, 281820, 282330, 285130, 290550, 290650, 290690, 293490, 294870, 295310, 298020, 298040, 298050, 298380, 302440, 304100, 307950, 310210, 316140, 317400, 319660, 322000, 322310, 323280, 323410, 326030, 327260, 328130, 329180, 330860, 332570, 333430, 336260, 336570, 340570, 347850, 348210, 348370, 352820, 353200, 354320, 356680, 356860, 357780, 357880, 358570, 361610, 368770, 373220, 375500, 376300, 376900, 377300, 382800, 383220, 383310, 388720, 389260, 389500, 396300, 397030, 399720, 402340, 403870, 413630, 417200, 417840, 419530, 420770, 425420, 437730, 439090, 441270, 443060, 445680, 448900, 450080, 452260, 452280, 454910, 455900, 456010, 456040, 457190, 458870, 459510, 460930, 463020, 466100, 475150, 475400, 475830, 476060, 482630, 483650, 484810, 489460, 489790, 499790, 900290, 950160, 000020, 000100, 000120, 000150, 000210, 000240, 000250, 000270, 000370, 000400, 000490, 000660, 000720, 000810, 000990, 001040, 001120, 001200, 001250, 001290, 001430, 001440, 001450, 001740, 001800, 001820, 002020, 002380, 002790, 003030, 003160, 003230, 003280, 003380, 003490, 003530, 003550, 003670, 003690, 003720, 004000, 004020, 004090, 004170, 004310, 004370, 004430, 004800, 004990, 005070, 005090, 005290, 005380, 005440, 005490, 005690, 005830, 005850, 005880, 005930, 005940, 005950, 006110, 006220, 006260, 006280, 006340, 006360, 006400, 006650, 006730, 006800, 006910, 007070, 007340, 007390, 007660, 007810, 008770, 008930, 009150, 009420, 009450, 009540, 009830, 009970, 010060, 010130, 010140, 010170, 010690, 010820, 010950, 011070, 011170, 011200, 011210, 011780, 011790, 012330, 012450, 012750, 014620, 014680, 014940, 015760, 016360, 017510, 017670, 017800, 017960, 018260, 018290, 018670, 018880, 019210, 020000, 020150, 021240, 022100, 023160, 023530, 024060, 024110, 025320, 025860, 025980, 026960, 027360, 028050, 028260, 028300, 028670, 029780, 030000, 030200, 031330, 031980, 032350, 032500, 032640, 032820, 032830, 033100, 033160, 033240, 033640, 033780, 033790, 034020, 034220, 034230, 034730, 035250, 035420, 035720, 035760, 035900, 036460, 036540, 036570, 036810, 036930, 037070, 037460, 037710, 039030, 039200, 039440, 039490, 039830, 039860, 041020, 041510, 041830, 042520, 042660, 042700, 043260, 044490, 045100, 046890, 047040, 047050, 047770, 047810, 047920, 048410, 049070, 049720, 050890, 051160, 051600, 051900, 051910, 052690, 052710, 053260, 053610, 053690, 053800, 055550, 056080, 056190, 058470, 058610, 059090, 059120, 060250, 060280, 060370, 060720, 061970, 062040, 064260, 064290, 064350, 064400, 064760, 065350, 066570, 066590, 066970, 067160, 067290, 067310, 068270, 068760, 069620, 069960, 071050, 071970, 073240, 073490, 074600, 075580, 077360, 077970, 078350, 078600, 078930, 079160, 079550, 079940, 080220, 080580, 081660, 082270, 082740, 082920, 083450, 083650, 084370, 085620, 085660, 085910, 086280, 086390, 086450, 086520, 086790, 087010, 088350, 088980, 089030, 089860, 089890, 089970, 090360, 090430, 090460, 092200, 092790, 092870, 093320, 093370, 094170, 095340, 095610, 096530, 096770, 097230, 097950, 098460, 099320, 099440

### from120To259

125490, 138360, 183300, 187660, 207940, 217590, 319400, 347700, 348340, 388210, 388790, 439260, 440110, 456160, 476830, 486990, 490470, 491000, 000500, 000880, 0009K0, 001510, 0015N0, 002990, 003350, 004710, 010120, 011930, 0126Z0, 017900, 024840, 024850, 025560, 030530, 032580, 038500, 046970, 069540, 079650, 090710

### from34To119

153890, 279570, 298000, 439960, 475040, 477850, 0039P0

### below34

없음

## 8. 모델별 eligible·excluded

| 모델 | eligible | excluded | TOP50 가능 |
|---|---:|---:|---|
| A-v1 | 506 | 47 | NOT_APPROVED |
| A-v2 | 506 | 47 | NOT_APPROVED |
| B-v1 | 506 | 47 | NOT_APPROVED |
| C-v1 | 524 | 29 | NOT_APPROVED |
| D-v1 | 506 | 47 | NOT_APPROVED |

제외 사유: `{"insufficientHistory":72,"invalidHistory":135,"tradingHaltOrNoTrade":10}`

## 9. Common B/C Universe

- activeModels: B-v1, C-v1
- count: 506
- codesHash: `ae8d259a70de66f5c5f885f759dc00b670691f59aa4da7c019d9824e163f6b5f`

## 10. 품질 판정

- fatal: 36
- ineligible records: 217
- warning: 368
- structuralStatus: failed
- overallGrade: REJECTED
- eligibleForSnapshot: false
- eligibleForRanking: false
- eligibleForRankBacktest: false
- eligibleForOptimization: false
- blockingReasons: adjustedPricePolicyUnknown, corporateActionPolicyUnknown, nonTradingObservation, pointInTimeMasterNotCertified, rawResponseNotStored, securityStatusUnknown, zeroVolumePriceChanged, zeroVolumeRowsPresent

## 11. Source manifest

```json
{
  "schemaVersion": 2,
  "requestedDate": "2026-08-20",
  "generatedAt": "2026-08-21T08:35:12.290Z",
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
      "requestedDate": "2026-08-20",
      "minimumLatestBasDt": "20260820",
      "maximumLatestBasDt": "20260820",
      "rawResponseStored": false,
      "normalizedInputHash": "9d16f5aa09b078c9f3602f3d7d1ad76923a3b0b190a3ac2298324781fc957006"
    }
  },
  "universe": {
    "filterVersion": "v1",
    "contentHash": "032857c64b3d087a7aaf67c1eb182eaabc7fab4b38a7eed8f7bcd3e3b54261d4"
  },
  "modelFormulaHashes": {
    "A-v1": "8e63e2bb4c16d962bb79d5ba2a2bf959ef32b93eda4c438b1bcab2ec2c712a87",
    "A-v2": "0b83966f3b2be9b4258d621d8cfa5dbf77fba3f015b0602541c60eabb7fea563",
    "B-v1": "cce71e6b2a9174798d8d2553e7fb63f9b798a82a142582e96998c2b934f2ebc4",
    "C-v1": "e58d70091eaad25fa58136ab455f2130956e5b4885bbe9d8cec2198b30f1433a",
    "D-v1": "91dc84f34eb8de8465a50f75d5685676d3e752a0d4993b29b04fcfa2a9b44888"
  },
  "marketDataNormalizationVersion": "v2"
}
```

## 12. Issue manifest

- manifest: `reports/dry-run-issues/schema-v6-issue-manifest-2026-08-20.json`
- schemaVersion: 2
- contentHash: `a6d774d298237b4636e032184f9056ae4301a9a4fb35a48792182372bc0c92fe`
- fatal/warning/total: 36 / 368 / 404

### Type별 전체 count

```json
{
  "adjustedPricePolicyUnknown": 1,
  "corporateActionPolicyUnknown": 1,
  "nonTradingObservation": 363,
  "pointInTimeMasterNotCertified": 1,
  "securityStatusUnknown": 1,
  "zeroVolumePriceChanged": 36,
  "zeroVolumeRowsPresent": 1
}
```

### Fatal 최대 20

```json
[
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "000500",
    "date": "20260511",
    "rowIndex": 69
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "000500",
    "date": "20260507",
    "rowIndex": 71
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "001510",
    "date": "20260424",
    "rowIndex": 78
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "002990",
    "date": "20260708",
    "rowIndex": 29
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "003350",
    "date": "20260417",
    "rowIndex": 83
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "004710",
    "date": "20250925",
    "rowIndex": 217
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "010120",
    "date": "20260410",
    "rowIndex": 88
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "011930",
    "date": "20260514",
    "rowIndex": 66
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "017900",
    "date": "20260414",
    "rowIndex": 86
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "017900",
    "date": "20260410",
    "rowIndex": 88
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "024840",
    "date": "20260508",
    "rowIndex": 70
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "024850",
    "date": "20260430",
    "rowIndex": 74
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "025560",
    "date": "20260724",
    "rowIndex": 18
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "030530",
    "date": "20251028",
    "rowIndex": 199
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "032580",
    "date": "20260526",
    "rowIndex": 59
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "038500",
    "date": "20260205",
    "rowIndex": 130
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "046970",
    "date": "20260416",
    "rowIndex": 84
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "046970",
    "date": "20260331",
    "rowIndex": 96
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "046970",
    "date": "20260326",
    "rowIndex": 99
  },
  {
    "severity": "fatal",
    "type": "zeroVolumePriceChanged",
    "code": "069540",
    "date": "20260415",
    "rowIndex": 85
  }
]
```

### Insufficient history 최대 50

```json
[
  {
    "code": "0009K0",
    "name": "에임드바이오",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 173
  },
  {
    "code": "0015N0",
    "name": "아로마티카",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 178
  },
  {
    "code": "0039P0",
    "name": "매드업",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 35
  },
  {
    "code": "0126Z0",
    "name": "삼성에피스홀딩스",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 181
  },
  {
    "code": "125490",
    "name": "한라캐스트",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 244
  },
  {
    "code": "153890",
    "name": "져스텍",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 37
  },
  {
    "code": "217590",
    "name": "티엠씨",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 166
  },
  {
    "code": "279570",
    "name": "케이뱅크",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 115
  },
  {
    "code": "388210",
    "name": "씨엠티엑스",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 183
  },
  {
    "code": "439260",
    "name": "대한조선",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 256
  },
  {
    "code": "439960",
    "name": "코스모로보틱스",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 70
  },
  {
    "code": "456160",
    "name": "지투지바이오",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 247
  },
  {
    "code": "475040",
    "name": "스트라드비젼",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 36
  },
  {
    "code": "476830",
    "name": "알지노믹스",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 163
  },
  {
    "code": "477850",
    "name": "마키나락스",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 63
  },
  {
    "code": "486990",
    "name": "노타",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 196
  },
  {
    "code": "490470",
    "name": "세미파이브",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 157
  },
  {
    "code": "491000",
    "name": "리브스메드",
    "modelVersion": "A-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 159
  },
  {
    "code": "0009K0",
    "name": "에임드바이오",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 173
  },
  {
    "code": "0015N0",
    "name": "아로마티카",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 178
  },
  {
    "code": "0039P0",
    "name": "매드업",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 35
  },
  {
    "code": "0126Z0",
    "name": "삼성에피스홀딩스",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 181
  },
  {
    "code": "125490",
    "name": "한라캐스트",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 244
  },
  {
    "code": "153890",
    "name": "져스텍",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 37
  },
  {
    "code": "217590",
    "name": "티엠씨",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 166
  },
  {
    "code": "279570",
    "name": "케이뱅크",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 115
  },
  {
    "code": "388210",
    "name": "씨엠티엑스",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 183
  },
  {
    "code": "439260",
    "name": "대한조선",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 256
  },
  {
    "code": "439960",
    "name": "코스모로보틱스",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 70
  },
  {
    "code": "456160",
    "name": "지투지바이오",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 247
  },
  {
    "code": "475040",
    "name": "스트라드비젼",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 36
  },
  {
    "code": "476830",
    "name": "알지노믹스",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 163
  },
  {
    "code": "477850",
    "name": "마키나락스",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 63
  },
  {
    "code": "486990",
    "name": "노타",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 196
  },
  {
    "code": "490470",
    "name": "세미파이브",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 157
  },
  {
    "code": "491000",
    "name": "리브스메드",
    "modelVersion": "A-v2",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 159
  },
  {
    "code": "0009K0",
    "name": "에임드바이오",
    "modelVersion": "B-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 173
  },
  {
    "code": "0015N0",
    "name": "아로마티카",
    "modelVersion": "B-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 178
  },
  {
    "code": "0039P0",
    "name": "매드업",
    "modelVersion": "B-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 35
  },
  {
    "code": "0126Z0",
    "name": "삼성에피스홀딩스",
    "modelVersion": "B-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 181
  },
  {
    "code": "125490",
    "name": "한라캐스트",
    "modelVersion": "B-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 244
  },
  {
    "code": "153890",
    "name": "져스텍",
    "modelVersion": "B-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 37
  },
  {
    "code": "217590",
    "name": "티엠씨",
    "modelVersion": "B-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 166
  },
  {
    "code": "279570",
    "name": "케이뱅크",
    "modelVersion": "B-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 115
  },
  {
    "code": "388210",
    "name": "씨엠티엑스",
    "modelVersion": "B-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 183
  },
  {
    "code": "439260",
    "name": "대한조선",
    "modelVersion": "B-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 256
  },
  {
    "code": "439960",
    "name": "코스모로보틱스",
    "modelVersion": "B-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 70
  },
  {
    "code": "456160",
    "name": "지투지바이오",
    "modelVersion": "B-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 247
  },
  {
    "code": "475040",
    "name": "스트라드비젼",
    "modelVersion": "B-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 36
  },
  {
    "code": "476830",
    "name": "알지노믹스",
    "modelVersion": "B-v1",
    "reason": "insufficientHistory",
    "requiredTradingDays": 260,
    "availableTradingDays": 163
  }
]
```

### Zero volume 최대 20

```json
[
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260820",
    "rowIndex": 0,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260819",
    "rowIndex": 1,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260818",
    "rowIndex": 2,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260814",
    "rowIndex": 3,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260813",
    "rowIndex": 4,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260812",
    "rowIndex": 5,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260811",
    "rowIndex": 6,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260810",
    "rowIndex": 7,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260807",
    "rowIndex": 8,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260806",
    "rowIndex": 9,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260805",
    "rowIndex": 10,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260804",
    "rowIndex": 11,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260803",
    "rowIndex": 12,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260731",
    "rowIndex": 13,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "000880",
    "date": "20260730",
    "rowIndex": 14,
    "referenceClose": 83800
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "001510",
    "date": "20260423",
    "rowIndex": 79,
    "referenceClose": 1863
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "001510",
    "date": "20260422",
    "rowIndex": 80,
    "referenceClose": 1863
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "001510",
    "date": "20260421",
    "rowIndex": 81,
    "referenceClose": 1863
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "001510",
    "date": "20260420",
    "rowIndex": 82,
    "referenceClose": 1863
  },
  {
    "severity": "warning",
    "type": "nonTradingObservation",
    "code": "001510",
    "date": "20260417",
    "rowIndex": 83,
    "referenceClose": 1863
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
  "data/history/2026-08-13.json": "a4f3dcccaf6b31b3db474b85f3598a7038439b9ce4939f5ba213e48115f13be6",
  "data/universe.json": "928a0ba9ac280193e2fb000a49b39d78d630af13696ec14c04874d83c47e7a1b",
  "data/trading-calendar/status.json": "597d4893cdaaefc717c13ceea5a089bd728acd356095df8a0e7675c56bfdc264",
  "data/top-stocks.json": "4c43d588ce9c07d120bc3120adc5955d83675ba55838d93997f0090fa690b454",
  "data/model-registry.json": "c304b11a1ca97706e6653052d014e7bc4921f5292f43d4167b83c29712ba9415",
  "lib/technical-strength.mjs": "8e63e2bb4c16d962bb79d5ba2a2bf959ef32b93eda4c438b1bcab2ec2c712a87",
  "lib/technical-strength-v2.mjs": "0b83966f3b2be9b4258d621d8cfa5dbf77fba3f015b0602541c60eabb7fea563",
  "lib/trend-strength.mjs": "cce71e6b2a9174798d8d2553e7fb63f9b798a82a142582e96998c2b934f2ebc4",
  "lib/entry-strength.mjs": "e58d70091eaad25fa58136ab455f2130956e5b4885bbe9d8cec2198b30f1433a",
  "lib/combined-technical-score.mjs": "91dc84f34eb8de8465a50f75d5685676d3e752a0d4993b29b04fcfa2a9b44888"
}
```

## 15. 다음 조치

공식 데이터 게시 또는 fatal 원인 해소 전까지 schema v6 스냅샷을 생성하지 않는다.

## 16. 테스트·빌드

이 섹션은 구현 검증 명령 완료 후 최종 보고에서 보완한다.

## 17. 제한 probe 및 기준일

- probe: `{"status":"OFFICIAL_EOD_CANDIDATE_FOUND","observations":[{"code":"005930","market":"KOSPI","latestBasDt":"20260820"},{"code":"000660","market":"KOSPI","latestBasDt":"20260820"},{"code":"247540","market":"KOSDAQ","latestBasDt":"20260820"}],"candidateAsOfDate":"2026-08-20","completedAt":"2026-08-21T08:29:04.554Z"}`
- candidateAsOfDate: 2026-08-20
- 기존 최신 history: 2026-08-13
- 관계: 신규 후보

## 18. Schema v6 메모리 산출물

| 산출물 | schema | records | bytes | hash | validation |
|---|---:|---:|---:|---|---|

## 19. Intraday seed 크기

- recordCount: -
- tupleCount: -
- serializedBytes: -
- maximumRowsPerSymbol: -
- annual250DayEstimatedBytes: -

## 20. Universe 비교

```json
null
```

## 21. 모델별 점수·순위

```json
null
```

## 22. Source availability

```json
{
  "sourceMarketDate": "2026-08-20",
  "sourcePublishedAt": null,
  "sourceCollectedAt": "2026-08-21T08:35:11.901Z",
  "sourceStoredAt": null,
  "signalComputedAt": "2026-08-21T08:35:12.283Z",
  "signalAvailableAt": null,
  "sourceAvailabilityStatus": "OBSERVED_IN_DRY_RUN",
  "sourcePublicationPolicy": {
    "policyId": "nextBusinessDayAfter13KST",
    "description": "기준일 다음 영업일 오후 1시 이후 갱신",
    "evidenceUrl": "https://www.data.go.kr/data/15094808/openapi.do",
    "publishedAtIsRecordSpecific": false
  },
  "sourcePublicationPolicyHash": "cf39acb677668aaaebb29354ee1f9ed06556f4c805e6587a2c490e0ec43c2a6d",
  "timingPolicyVersion": "public-eod-t2-open-v1",
  "timingEvidence": {
    "publication": "POLICY_ESTIMATED",
    "collection": "OBSERVED_IN_DRY_RUN",
    "availability": "NOT_PRODUCTION_AVAILABLE"
  }
}
```

## 23. 수익률 초기 상태

```json
{
  "futureFiniteCount": 0,
  "legacyFiniteCount": 0,
  "executionFiniteCount": 0,
  "timingValidationStatus": "NOT_PRODUCTION_AVAILABLE",
  "eligibleForExecutableAggregation": false
}
```

## 24. 최종 승인 판정

- **DATA_QUALITY_REJECTED**
- eligibleForSnapshotGeneration: false
- eligibleForRanking: false
- eligibleForPredictiveResearch: false
- eligibleForExecutableAggregation: false
- eligibleForOptimization: false
- 이유: production signalAvailableAt 없음, point-in-time Universe 미인증

## 25. 요청 및 재출력

- 실제 외부 HTTP 요청 수: 553
- 대표 probe 3종목은 request cache로 전체 수집에서 재호출하지 않음
- 보고서는 수집된 메모리 결과만 사용했으며 보고서 재출력 외부 요청 0건

