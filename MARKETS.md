# Tala — original market dashboard

This document describes the retained `site/` market module. The main app is now the finance PWA described in [README.md](README.md). Run this original module with `npm run market:dev` on port 5180, its contract tests with `npm run test:market`, and its browser checks with `npm run test:market:browser`. The main Pages workflow publishes the production `dist/` build, which includes this module under `legacy-market/`.

A static dashboard with dynamic stock discovery, quote refresh, saved stock additions, PSEi, mutual-fund NAVs and ETF views. Choose Philippines, United States, Hong Kong, Japan, United Kingdom, Canada or Australia, or compare saved stocks across markets. The interface uses vanilla JavaScript and SVG charts; provider credentials stay in a local server or separate Cloudflare Worker. The local international fallback uses two small Parquet-reader packages; the static site needs no generated bundle.

When running locally, the default is the **free public connection**: no subscription or API key is required. Philippine prices come from PSE EDGE and its explicitly named fallback. International quotes and histories use Yahoo Finance, with a free [Crible daily dataset](https://github.com/maxgfr/crible) when direct access fails. Each price retains its source currency and original timestamp or market date. Older mirror records and uncertain price units are rejected as current quotes. A static GitHub Pages deployment still needs a separately configured gateway. The separately selectable **sample mode** contains fictional data for interface testing only.

No paid vendor credential, public display license, GitHub repository, or Cloudflare account has been configured by this project. Automated tests use recorded contract shapes and mocked provider responses; they do not prove that an external source is reachable from a particular network.

## Run locally

Use Node.js 24 or newer. From this directory:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5180**. Use a local HTTP server rather than opening the HTML through `file://`, because the app loads JSON and JavaScript modules.

The local server exposes the keyless adapter at `/api/public`. New local visitors and previously unconfigured profiles select it automatically. Choose the free public connection in **Connect data** to switch an existing connection. Explicit sample mode, a previously configured provider, and a newly saved disconnect remain your choices. Public PSE pages are permitted for personal, non-commercial access; this local adapter does not publish those prices to third parties.

The free adapter reads the [PSE EDGE directory](https://edge.pse.com.ph/companyDirectory/form.do), [stock pages](https://edge.pse.com.ph/companyPage/stockData.do?cmpy_id=260), [index summary](https://edge.pse.com.ph/index/form.do), and daily chart endpoint. It validates full directory pagination, numeric company/security identities, source dates, and nullable financial fields. The issuer directory lists default stock symbols; additional preferred and B share classes are not advertised as covered. Prices are **published snapshots**, with no guaranteed refresh delay or real-time claim. Quotes are cached for five minutes, directory/history for one day, and source rate limits stop further upstream calls during their retry interval. Mutual fund NAVs, ETF NAV and PSEi history remain unavailable through this source.

If direct PSE access fails, the local adapter uses the fixed public [ph-stocks snapshot](https://github.com/zhameersheraz/ph-stocks) as a fallback. This community mirror publishes PSE EDGE data for **21 stocks plus the index** and documents a 30-minute collection schedule. The dashboard names the mirror, displays its limited coverage, and retains each original PSE timestamp instead of using the mirror's download time as the trade time. Stocks outside the mirror and historical charts remain unavailable while direct access is down. Invalid identities, malformed values and future source timestamps are rejected. The fallback requires no API key and never receives your private provider token.

To load actual delayed PSE stock quotes locally, select **Connect data → EODHD on this computer (personal use)**, enter your own key, and confirm the intended personal use. The local server stores it in the ignored `.local-market.json` outside `site/`; browser storage and public assets contain no provider token. Setup is exposed only through the loopback server and accepts same-origin requests. A configured local account is reused after server restart.

Use the **+** button in the top bar or **Add stock** above the table. Choose a market, then search a company or enter its ticker. International IDs include the market (`US:AAPL`, `HK:0700`, `JP:7203`, `GB:VOD`, `CA:SHOP`, `AU:BHP`); existing Philippine IDs remain unchanged. Newly added international stocks need a real source quote before connected-mode save. Starter lists contain names only, never prices. Unknown symbols do not create prices. Up to 100 instruments can be tracked; requests are split into sequential batches of at most 20 symbols.

International sources are snapshots or daily closes, not a guaranteed live feed. Yahoo may time out or rate-limit requests. The fallback reads selected columns and matching rows from Crible's published Parquet files, preserving each ticker's own last date and upstream source. Daily closes have **date precision**, with no invented intraday clock. Potentially unfinished collection-day bars are omitted; the export time is separate from the market date. Currency and exchange metadata are validated. Unsupported or older records stay unavailable, and one failed market cannot discard healthy quotes from another. Historical series can be older than the current quote window; their original dates remain visible. Cross-market comparisons use change percentages and retain original currencies without foreign-exchange conversion. The PSEi summary remains explicitly Philippine.

```sh
npm test           # Financial-data, ingestion, browser-client and Worker contracts
npm run check      # Static references, JSON and credential scan
npm run check:source # Live read-only check of free-source coverage and prices
npm run test:browser
```

The browser test requires Google Chrome and the local server running. It uses Chrome DevTools Protocol and Node built-ins. Set `CHROME_PATH` if Chrome is not installed at the default Windows path. The test saves `artifacts/desktop.png`, `artifacts/mobile.png`, and a failure screenshot when needed. It creates and cleans up its own isolated browser profile.

## What works

- Overview, Stocks, Mutual funds, ETFs and My watchlist views, with responsive navigation.
- Provider-wide symbol/name search, a dedicated Add stock dialog, and persistent additions beyond the reference list. Autocomplete supports Arrow Up/Down, Enter, Escape and `/`; the table has local filters and sortable financial columns.
- Stock/ETF watchlist add/remove with browser persistence and an explicitly defined equal-weight average daily change.
- PSEi, stock, ETF and fund charts with 1W, 1M, 3M and 1Y ranges, hover values and a matching accessible historical table.
- Daily NAVPS/NAVPU with valuation dates; ETF traded price and NAV/iNAV with separate source timestamps.
- CSV export of the displayed table, including source, value type, freshness and original timestamps; spreadsheet formula prefixes are escaped.
- Source settings and a plain-language data guide; visible keyboard focus, semantic tables, dialog keyboard behavior and restrained live status messages.
- Namespaced browser caches, offline/provider-error fallback, explicit stale/cached labels, 429 backoff and stopped automatic retries for configuration errors.
- A fixed-endpoint, cached Worker with verified catalog membership; normalized nullable financial values; server-side secrets; exact-origin CORS; safe upstream errors; optional platform rate limiting. Its remote public-display gate stays enabled; private local access requires a separate explicit loopback-only constructor option and user confirmation.

The “market direction” summary counts only tracked stocks with available quotes. It is not an exchange-wide breadth statistic. Watchlist averages are not portfolio returns. An offline cache is available within the loaded dashboard; this is not an offline-installable PWA.

## Publish to GitHub Pages

Create a repository with **this directory's contents at its root**. The workflow is `.github/workflows/pages.yml`; its upload path is `./site`. If you instead put this project inside a larger repository, adjust the workflow working directory and upload path accordingly.

1. Push the project to the repository's `main` branch.
2. In **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. Run the Pages workflow or push another change. Checks and browser journeys run before deployment.
4. The workflow uploads only `site/`. It does not publish Worker source, tests, input files, or secrets.

All app assets use relative paths, so `/repository-name/` project URLs work. There are no client-side routing rewrites to configure. The workflow follows [GitHub's custom Pages deployment documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

This project is prepared for deployment; it has not been pushed or published to an external account.

## Connect licensed data

The app owns a normalized contract, rather than embedding a provider API key in the browser. The included Worker has an EODHD adapter for **PSE symbol discovery, delayed equity/ETF quotations and EOD history**. PSEi, fund NAV/history and ETF NAV/iNAV use optional approved, operator-supplied normalized data in KV. The app reports unavailable fields when these sources are missing. Actual returned prices retain their provider source, original timestamp and delay label; they are not represented as official real-time exchange data.

Follow [worker/README.md](worker/README.md) to deploy the gateway, configure its exact allowed origin, set its server-side secret, and populate optional licensed sources. The license flag defaults to false; turn it on only when the intended public display is actually permitted. A configuration flag records the operator's decision and does not grant a license.

For an externally deployed connection, use the settings icon and select **Licensed market-data gateway**. To make the deployed site use the gateway for new visitors, edit `site/src/config.js`:

```js
export const DEFAULT_CONNECTION = Object.freeze({
  mode: 'gateway',
  apiBase: 'https://your-market-gateway.workers.dev',
});
```

This is a public base URL, not a vendor credential. A saved connection in a visitor's browser overrides this default. The browser's gateway setting accepts HTTPS; HTTP is allowed only for localhost development. Credentials, query parameters and fragments are rejected.

When changing a data connection, the app clears the previous connection's table, chart/history, summary values and ETF NAV before fetching. Gateway errors never fall back to the sample dataset or another gateway's cached quotes.

Public redistribution entitlement and symbol coverage still need verification with the provider. This build intentionally does not invent an EODHD PSEi ticker, promise PSE access through Twelve Data, scrape PSE EDGE/PIFA, or infer the exchange's open/closed state from a hard-coded schedule. EODHD documents its [delayed quotation API](https://eodhd.com/financial-apis/live-ohlcv-stocks-api), [PSE symbol catalog](https://eodhd.com/financial-apis/exchanges-api-list-of-tickers-and-trading-hours) and [historical EOD API](https://eodhd.com/financial-apis/api-for-historical-data-and-volumes). Worker tokens are intended for [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/). Local personal-use setup does not grant rights to publish those quotes publicly.

## Import approved fund valuations

The fund importer reads an operator-supplied local CSV/JSON file. It validates the entire import before an atomic write, preserves valuation dates, and requires a source URL, permission reference, public-display acknowledgment and verified row count. It does not fetch or scrape websites. Bundled sample files cannot be overwritten.

```sh
node scripts/import-funds.mjs --help
```

Required row fields:

```text
id,name,category,currency,value,valueType,valuationDate,asOf
```

Optional `previousClose` may be absent or null; that produces an unavailable comparison, rather than a zero price. Categories are Equity, Balanced, Bond and Money market; currency is PHP; NAV type is NAVPS or NAVPU. Dates must be explicit and `asOf` must include a timezone. Unknown columns, duplicate IDs, missing/invalid NAVs, future timestamps and row-count mismatches reject the whole import.

Example command (replace the paths and provenance with your approved source):

```sh
node scripts/import-funds.mjs --input operator-input/funds.csv --output operator-output/approved-funds.json --source-name "Approved fund manager" --source-url "https://your-approved-source.example/nav" --permission-reference "Your public-display agreement reference" --approved-for-public-display --expected-count 8
```

Upload that output to the Worker's `funds:list` KV key. Keep operator inputs outside the published `site/` directory. This manual pipeline can be placed behind an authorized scheduled ingestion task once an actual source and its publishing rules are known; no speculative scraper or unattended ingestion has been enabled.

Regenerate the fictional snapshot, if needed, with `npm run generate:demo`. The generator is deterministic and needs no network.

## Project structure

```text
site/                 Static Pages artifact
  src/app.js          UI, local watchlist, refresh scheduling
  src/api.js          Gateway contract and source-isolated cache fallback
  src/format.js       Money, freshness, Manila dates, CSV safety
  src/chart.js        Native SVG chart and sparklines
  src/config.js       Public default connection
  data/               Explicitly fictional demonstration data
worker/               Deploy separately; never put tokens in site/
scripts/              Deterministic demo generator and manual fund importer
tests/                Data/client/gateway regression contracts
tools/                Local server, keyless PSE adapter, source check, browser journeys
.github/workflows/    Check-before-deploy GitHub Pages workflow
```

Google Fonts improves the typography when reachable; local system font fallbacks keep the interface usable without that request. Charts, icons and interactions do not require a CDN library.

## Production boundaries

The Worker verifies symbols against a provider or approved-source catalog, enforces at most 20 unique symbols per request, and bounds history ranges. The catalog is cached for up to 24 hours. Its edge cache is local to Cloudflare data centers, so it reduces repeated upstream requests without guaranteeing one global request per refresh. Configure the optional platform rate limiter and monitor provider quotas, latency, response failures and original data timestamps before operating a public service at scale.

The current tests exercise mocked vendor responses and a real local browser. They do not prove an unconfigured vendor entitlement or a remote deployment. Licensed feed procurement, actual source ingestion, live account testing and freshness monitoring remain deployment-specific work.
