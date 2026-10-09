# Market data gateway

This dependency-free ES-module Cloudflare Worker exposes the dashboard API. EODHD supplies the complete supported PHP stock/ETF catalog for its PSE exchange, delayed quotes, and daily history. Quote/history requests must use symbols verified against that catalog; there is no fixed 20-instrument coverage limit. Each quote request accepts at most 20 symbols, so the client can split a larger watchlist across requests. Licensed operator-supplied KV data supplies the PSEi, its history, mutual funds, and optional ETF NAV. The gateway returns actual provider or operator data and never manufactures prices.

## Configuration and deployment

1. Obtain written rights for public display, caching, historical charts, and distribution to unauthenticated visitors for each dataset. An API key alone does not establish those rights.
2. Edit `worker/wrangler.toml`. Set `ALLOWED_ORIGINS` to the comma-separated exact origins of the deployed site, such as `https://ACCOUNT.github.io,https://markets.example.com`. Do not include the repository path, a trailing slash, or a wildcard. Add `http://localhost:PORT` explicitly for local development only.
3. From this directory, use the Cloudflare Wrangler CLI to authenticate and set the provider secret:

   ```sh
   npx wrangler login
   npx wrangler secret put EODHD_TOKEN
   ```

   Enter the token at the prompt. Keep it out of `wrangler.toml`, the static site, GitHub Pages build variables, and committed JSON. If local Wrangler secrets are needed, keep an untracked `.dev.vars` containing only server-side values and ensure the repository ignores it.

4. If approved datasets are available, create a KV namespace and uncomment the `MARKET_DATA` binding with its actual namespace ID:

   ```sh
   npx wrangler kv namespace create MARKET_DATA
   ```

   Upload validated, permissioned records using the keys below. A binding is optional for the EODHD catalog, equity quotes, and history; absent licensed index/fund records return `503`. Missing optional ETF NAV returns `nav: null` alongside the delayed market quote.

5. Set `PUBLIC_DISPLAY_LICENSED = "true"` only after the operator confirms all configured public-display rights. The default is `"false"`; every data route then returns `503` with `license_required`, including cached requests. Deploy with:

   ```sh
   npx wrangler deploy
   ```

6. Set the static site's API base URL to the deployed Worker HTTPS URL and select its live mode. Smoke-test each configured route from the allowed site origin. A command-line client can omit `Origin`; CORS is a browser boundary, not API authentication.

The optional `RATE_LIMITER` binding can enforce per-client limits. Replace the placeholder namespace ID before enabling it. Apply Cloudflare platform abuse protection and provider quotas appropriate to the deployment. The shared Cache API is local to each edge data center. Catalog requests within one Worker instance share an in-flight fetch; requests across instances can still have concurrent cache misses.

## Private local use

The default exported/deployed Worker always enforces `PUBLIC_DISPLAY_LICENSED`. A local Node adapter may instead instantiate `createWorker({privateLocalUse:true})`. It bypasses that gate only when `PRIVATE_LOCAL_USE_CONFIRMED` is exactly the string `"true"` and the request URL hostname is `localhost`, `127.0.0.1`, or `[::1]`. This allows an explicitly acknowledged personal local session to use its own EODHD key without claiming public redistribution rights. The environment flag alone cannot enable the bypass on the deployed/default Worker, and a non-loopback request is denied.

The adapter must obtain the user's acknowledgment, retain the key server-side as `EODHD_TOKEN`, restrict its listener to loopback, and pass a loopback request URL after removing its `/api` prefix. CORS, token validation, request bounds, catalog verification, provider errors, and timeouts continue to apply. This option does not establish vendor entitlement, verify a personal subscription, or grant any public-display rights.

## Public API

| Request | Response |
| --- | --- |
| `GET /catalog` | `{instruments:[{symbol,name,assetType,currency,sector?}],source,asOf}`; complete supported catalog |
| `GET /catalog?q=company` | Same envelope; up to 30 symbol/name matches |
| `GET /quotes?symbols=AC,BDO` | `{quotes, generatedAt}` |
| `GET /index/PSEI` | `{quote, generatedAt}` |
| `GET /history/AC?range=1m` | `{symbol, points:[{date, close}], source, freshness:"eod"}` |
| `GET /history/PSEI?range=1m` | Same history envelope, licensed KV source |
| `GET /funds` | `{funds, generatedAt}` |
| `GET /funds/approved-fund-id/history?range=1m` | Same history envelope, `symbol` is the fund ID |
| `GET /etf/FMETF` | `{quote, nav}`; `nav` can be `null` |

Catalog symbols/names come from the fixed authenticated upstream endpoint `https://eodhd.com/api/exchange-symbol-list/PSE?api_token=SERVER_SECRET&fmt=json`, or from approved normalized `catalog:PSE` KV data. Provider rows are restricted to PHP stock/ETF records and mapped from `Code`, `Name`, `Currency`, and `Type`; a supplied `Sector` is preserved. Other currencies and unsupported instrument types are excluded. No user search query is sent upstream. Provider catalog `asOf` records the retrieval time, because the exchange-list response does not supply a per-record quote timestamp. KV catalogs preserve their actual supplied `asOf` and source.

Search matches symbols/names case-insensitively, ranks an exact symbol first, and returns at most 30 results. `q` is optional; a supplied value must be a nonblank symbol/company-name search of at most 80 characters. Without `q`, the endpoint returns all catalog instruments. Catalog membership identifies supported instruments, not guaranteed quote/history entitlement on the subscriber's plan.

Quote/history symbols must match `^[A-Z0-9][A-Z0-9.-]{0,14}$`, without a `.PSE` suffix, and exist in the verified catalog. Digits, hyphens, and dots are permitted only when the actual exchange catalog contains that symbol. `PSEI` is reserved for the independent licensed index routes. Up to 20 unique symbols per quote request are accepted; excess items are rejected rather than truncated. Symbols are sorted in the response for a canonical shared cache key. History ranges are `1w`, `1m` (default), `3m`, and `1y`, using bounded calendar-day windows and daily closes. Unknown/duplicate parameters, arbitrary upstream URLs, alternate provider tokens, and unsupported methods are rejected.

During a catalog service outage, the original reference names for `AC, BDO, SM, SMPH, ALI, BPI, MBT, JFC, TEL, GLO, ICT, URC, AEV, AP, MER, CNVRG, MONDE, DMC, LTG, FMETF` permit quote/history requests for those known instruments. Their prices still come exclusively from the upstream provider. Other symbols return `catalog_unavailable` until verification resumes. `/catalog` itself returns the upstream error and never substitutes or labels that reference list as an actual EODHD catalog. Authentication, entitlement, and quota failures propagate without this fallback.

Quotes contain `symbol`, `name`, `assetType`, `currency:"PHP"`, `value`, `valueType:"last_trade"`, `previousClose`, `change`, `changePercent`, `volume`, `asOf`, `marketDate`, `freshness:"delayed"`, `delayMinutes:20`, and `source:"EODHD"`. Missing prices, timestamps, and other numeric values remain `null`. Genuine zero volume is retained. `asOf` comes from the provider timestamp; `marketDate` uses Asia/Manila. EODHD values are indicative aggregated prices; they should not be presented as official exchange trades or used for execution.

Supplied quote/source timestamps must parse correctly and cannot be more than five minutes ahead of the gateway clock. Invalid/future timestamps fail closed; absent optional timestamps remain null. Source market/valuation dates must be valid calendar dates and cannot be after the current Philippine date.

Errors have `{error:{code,message}}`. Provider authentication/entitlement failures return `503` / `service_configuration`; clients should stop rapid retries. Upstream `429` becomes `429` with a sanitized `Retry-After` of 1–300 seconds. Timeouts become `504`, malformed/upstream failures become `502`, and absent licensed data becomes `503` / `data_unavailable`. No upstream response body, authentication header, or URL is returned.

## Licensed KV contracts

These are normalized JSON objects, not provider payloads. Only use real records from an approved ingestion process. Every record must preserve an actual source name and source valuation date/time. Source metadata is never replaced with a guessed provider name. Envelopes/records with `mode:"demo"`, `approvedForPublicDisplay:false`, or `provenance.approvedForPublicDisplay:false` are rejected. Omitted approval metadata is accepted only behind the operator's global license gate, to support normalized ingestion sources that do not expose that metadata.

`catalog:PSE` optionally contains `{instruments, source, asOf}`. `instruments` must contain 1-5,000 unique normalized records with `symbol`, `name`, `assetType:"stock"|"etf"`, `currency:"PHP"`, and optional `sector`. `source` is the actual approved catalog publisher (for example, `PSE` for a contracted exchange catalog); `asOf` is its valid ISO timestamp. Missing source/time/schema fields and explicit demo/unapproved records are rejected. Optional approval metadata follows the envelope rules above. A valid KV catalog can be served without an EODHD token, while EODHD price/history calls still require the server secret.

`index:PSEI` contains a quote object:

```text
symbol: "PSEI"
name: actual index name (optional; default PSE Composite Index)
value: nonnegative index level
valueType: "index_level"
previousClose, change, changePercent, volume: number or null
asOf: ISO timestamp with explicit timezone, or null
marketDate: YYYY-MM-DD, or null (one of asOf/marketDate must be valid)
freshness: "delayed" | "eod" | "real_time"
delayMinutes: nonnegative number required for delayed data
source: actual licensed provider/source name
```

`funds:list` contains `{generatedAt, funds:[...]}`. `generatedAt` must be an ISO timestamp with an explicit timezone. Each fund contains:

```text
id: unique lowercase letters/digits/hyphens, length 1–64
name: actual fund name
category: "Equity" | "Balanced" | "Bond" | "Money market"
currency: "PHP"
value: positive number (missing/null/zero NAV is rejected)
valueType: "NAVPS" | "NAVPU"
previousClose, change, changePercent: number or null
valuationDate: actual YYYY-MM-DD NAV valuation date
asOf: independently recorded ISO timestamp, or null
source: approved fund manager/vendor/PIFA source label
```

The gateway returns `freshness:"daily_nav"`. It preserves the actual `valuationDate`, which may precede `generatedAt`; it does not infer a banking calendar or relabel previous-day NAV as current. Currency is restricted to PHP to match the dashboard/importer. The list accepts at most 500 funds and rejects duplicate IDs or invalid schema rather than publishing malformed records.

`history:PSEI` and `history:<fund-id>` contain `{symbol, points:[{date,close}], source, freshness:"eod"}`. `symbol` must match `PSEI` or the fund ID respectively; `id` may be used instead of `symbol` for a fund. Dates must be real `YYYY-MM-DD` calendar dates and unique. Closes must be numbers or null; nulls remain gaps, never zeroes. Fund IDs must also exist in `funds:list`. History is sorted and filtered to the requested window; unavailable or invalid records return `503`.

`etf:FMETF:nav` contains `{value, valueType, asOf, valuationDate, source}`. `value` must be positive; `valueType` is `NAVPS`, `NAVPU`, or `iNAV`. The valuation date is required; an independent ISO `asOf` timestamp may be null. ETF NAV is never inferred from its market trading price. A malformed supplied NAV fails closed with `503`.

## Cache and verification

Origin-neutral normalized JSON is stored for 24 hours for the catalog, 60 seconds for quotes/index/ETF, and 3,600 seconds for history/funds. Search requests filter the same full catalog rather than creating separate upstream requests/cache entries. The in-memory catalog cache retains the original edge entry's expiry and cannot extend it past 24 hours. Catalog `429` sets a bounded per-instance cooldown honoring `Retry-After`, so quote/history verification does not immediately spend more upstream quota.

Canonical cache keys include only route, validated range, and sorted symbols. Every request rechecks public-license/private-local authorization, relevant binding/secret configuration, and Origin before serving cache. Quote/history requests recheck catalog membership, including cache hits. CORS is computed from the current visitor's Origin after retrieval; one allowed origin cannot inherit another's headers. Public responses are `Cache-Control:no-store`, while the internal edge copies have a bounded TTL. Failure responses are never stored in the shared response cache.

If licensing is revoked, set the gate false and redeploy. After replacing a licensed source or attribution contract, purge its edge records or increment `CACHE_VERSION` in `index.mjs` before deployment so previous-source values do not persist for the remaining TTL. This gateway does not perform business-license verification, PIFA extraction, provider failover, freshness monitoring, or actual exchange-calendar calculation; those remain operational integrations.

Run the dependency-free mocked tests from the repository root:

```sh
node --test tests/worker.test.mjs
```

Tests cover dynamic catalog coverage/search, membership checks, catalog expiry/cooldown, numeric null handling, source timestamps, input bounds, hostile requests, cache/CORS isolation, public/private-local gates, sanitized errors, timeout/body bounds, provider rate limits, licensed KV schemas, separate NAV/trading values, and missing sources. They use isolated mocked data; they do not contact a live vendor or establish that the subscribed account is entitled to a particular instrument.

Implementation references: [EODHD exchange catalog documentation](https://eodhd.com/financial-apis/exchanges-api-list-of-tickers-and-trading-hours), [EODHD delayed quote documentation](https://eodhd.com/financial-apis/live-ohlcv-stocks-api), [EODHD daily history documentation](https://eodhd.com/financial-apis/api-for-historical-data-and-volumes), [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/), and [Cloudflare CORS example](https://developers.cloudflare.com/workers/examples/cors-header-proxy/).
