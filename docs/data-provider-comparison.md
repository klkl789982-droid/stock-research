# Provider comparison

Checked against primary sources on 2026-10-12. UNKNOWN means no verified answer, not permission. Account API access is not cloud-storage/display permission. No new provider credential or paid contract was created.

| Provider | Data / history / 553 coverage | Delivery and limits | Rights and cost | Integration judgment |
| --- | --- | --- | --- | --- |
| Public portal / FSC-KRX | OHLCV, trading value, cap; current production has 553 histories. Adjustment/corporate-action/session equivalence UNKNOWN. | Guide: next business day after13:00; dev traffic10,000, increase by request. October8 absent at04:08, present in latest/exact/XML at13:22; range begin=end still0. Existing manifest completed11:36. | Free; type4 and explicit unauthorized third-party redistribution restriction. Derived/public display/cloud retention require scope confirmation. | Existing parser/official pipeline reused; cannot guarantee same-day close. |
| KIS | Existing daily chart TR FHKST03010100, OHLCV/value, adjusted flag; pagination reused. 553 attempted, 523 accepted; 508 long histories. Corporate-action metadata preserved; final session/confirmation UNKNOWN. | Historical audit ~10m54s/1,610 client attempts. Existing limiter/retry retained. Current account contractual request quota and close-time finality require confirmation. | Existing account/auth, no new fees introduced. Cloud retention, private shared research, derived sharing/display awaiting written answer. | Existing parser/private store/engine reused; provisional diagnostic adapter only. |
| Kiwoom REST | Domestic prices/chart query APIs; full history depth, trading-value completeness, adjusted semantics and 553 actual coverage untested. | Official introduction: real domestic queries 5/s; demo 1/TR/s; REST supports multiple OS. Exact EOD finality/time UNKNOWN. | Account/HTS ID/registration needed. Cloud retention/display/derived sharing and fees UNKNOWN from reviewed docs. | Plausible second broker; no network adapter enabled without credentials and rights. |
| LS OpenAPI | Official catalog t8410 daily/weekly/monthly/year chart and t8451 integrated chart; master/halt queries exist. Field completeness/history/session/adjustment require TR-specific verification. | TR-specific limits; exact approved account rates and close-time finality UNKNOWN. | Account required; storage/redistribution/cost UNKNOWN. | REST candidate, additional account/provider integration burden; untested. |
| KRX Open API / Data Marketplace | Official exchange data catalogs; depth, price basis, corporate actions and 553 entitlement require product selection. | Authentication/application required; exact delivery SLA and quota UNKNOWN for an unselected product. | Entitlement/contract determines retention/display/derived use and price. No assumed free commercial license. | Best authority for rights and session definitions; not implemented without agreement. |
| FnGuide | DataGuide subscription/Excel research product, not automatically a bulk data ingestion license. Separate API product needs contract. | API limits/EOD SLA/history coverage UNKNOWN for an unselected API plan. | DataGuide published first account 7.2m KRW/year, extra 4.8m excluding VAT; bulk extraction/DB construction and external sharing restricted. These are NOT API plan prices. | Do not use Excel product as automated feed. Request an explicit API license if needed. |

Primary references:

- [FSC stock price endpoint and rights](https://www.data.go.kr/data/15094808/openapi.do)
- [KIS portal](https://apiportal.koreainvestment.com/intro), [official examples](https://github.com/koreainvestment/open-trading-api)
- [Kiwoom introduction](https://openapi.kiwoom.com/intro), [official examples](https://github.com/Kiwoom-Securities/Kiwoom-REST-API)
- [LS API catalog](https://openapi.ls-sec.co.kr/apiservice), [account requirements](https://openapi.ls-sec.co.kr/about-openapi)
- [KRX Open API](https://openapi.krx.co.kr/contents/OPP/USES/service/OPPUSES001_S1.cmd)
- [FnGuide product pricing and usage](https://help-dataguide.fnguide.com/ko/articles/이용-및-요금-안내-48b18a4b), [terms](https://policy.fnguide.com/DataGuide/Terms240728)

All providers must be evaluated separately for speed, history depth, universe coverage, request limits, OHLCV/value completeness, adjustment/corporate actions, accuracy, automation, local/cloud retention, private analysis, website/third-party rights, cost and integration difficulty. Table entries deliberately leave undocumented claims unknown. Existing KIS historical equality is not proof of close-time accuracy or contractual permission. No unofficial scraping alternative was adopted.

Recommendation: maintain the current official source plus a rights-approved fast source, then compare. A third source is justified only by independent evidence or a licensed official contract; identical upstream KRX provenance can leave correlated failures. No provider was automatically substituted.
