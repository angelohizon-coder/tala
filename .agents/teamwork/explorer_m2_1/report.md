# Technical Investigation & Design Report: Market Data Reliability & Normalization (R2)

**Explorer**: Explorer M2-1  
**Milestone**: M2 (Market Data Reliability & Investments)  
**Date**: 2026-10-10  
**Working Directory**: `e:/Visual Studio Code/tala/.agents/teamwork/explorer_m2_1/`  
**Target Source Files**: `src/market/providers.ts`, `tests/market-provider.test.ts` (new)  
**Reference Documents**: `ORIGINAL_REQUEST.md`, `PROJECT.md`, `functions/src/index.ts`, `tools/free-global-mirror.mjs`  

---

## 1. Executive Summary

This investigation resolves the critical market data failures identified in Milestone 2 (R2) of the Tala personal finance SPA.

Currently, **all Philippine market quotes fetched via the Cloud Function gateway fail silently or throw validation errors**, crashing the watchlist and preventing users from tracking PSE securities. This occurs due to an acute property schema mismatch: the Cloud Function gateway (`functions/src/index.ts`) returns `{ price, provider, freshness, isStale }`, whereas `src/market/providers.ts:18` strictly validates `quote.value` and `quote.source`. Because `quote.value` and `quote.source` are `undefined`, `!Number.isFinite(quote.value)` immediately triggers, rejecting every single successful gateway response.

Furthermore, `marketProvider.latestPrice` offers **zero client-side fallback to cached Dexie prices** when network connectivity is lost or upstream providers fail, causing runtime errors rather than gracefully displaying the last saved valuation flagged with a `stale` badge.

This report establishes:
1. **Bidirectional Quote Normalization** (`normalizeQuote`): Unifies gateway schemas, Crible Parquet mirror schemas, local Dexie prices, and user inputs into standard `MarketQuote` objects with finite positive `value` and valid `source` strings, while enforcing the Critical Zero-Price Defense.
2. **Three-Tier Resilient Resolution Architecture**:
   - Tier 1: Live provider (Cloud Function gateway for PSE, Crible mirror for international).
   - Tier 2: Firestore STALE cache (served transparently by the gateway).
   - Tier 3: Local Dexie IndexedDB STALE cache (`financeDb.prices` & `financeDb.instruments`).
3. **Symbol Matching & Colon Sanitation**: Handles PSE suffix variations (e.g. `BDO.PS` vs `BDO`) and guards dev server proxy calls against international colon formats (`US:AAPL`), eliminating spurious 400 Bad Request errors.
4. **Complete Unit Test Specification**: Comprehensive tests covering property mapping, zero-price defenses, Dexie fallback, and ticker resolution.

---

## 2. Root Cause & Architectural Audit

### 2.1 Bug R2.1: Gateway vs Client Property Schema Mismatch

- **Location**: `src/market/providers.ts:18` vs `functions/src/index.ts:177-191, 374-389`
- **Observed Behavior**:
  The Cloud Function `getMarketQuote` resolves quotes and formats them as `NormalizedMarketQuote`:
  ```json
  {
    "quotes": [
      {
        "symbol": "BDO.PS",
        "price": 155.0,
        "currency": "PHP",
        "provider": "yahoo",
        "freshness": "delayed",
        "isStale": false,
        "asOf": "2026-10-10T13:00:00.000Z",
        "name": "BDO Unibank, Inc.",
        "change": 0.5,
        "changePercent": 0.32
      }
    ]
  }
  ```
  In `src/market/providers.ts:18`:
  ```ts
  const quote = data.quotes?.find((q: MarketQuote) => q.symbol === symbol);
  if (!quote || !Number.isFinite(quote.value) || quote.value <= 0 || ... || typeof quote.source !== 'string' || !quote.source.trim())
    throw new Error(data.issues?.[0]?.message || 'No recent verified quote is available for this ticker.');
  ```
- **Mechanism of Failure**:
  1. The Cloud Function sets `price` (not `value`), so `quote.value === undefined`.
  2. The Cloud Function sets `provider` (not `source`), so `quote.source === undefined`.
  3. `!Number.isFinite(quote.value)` evaluates to `true`, causing every valid quote to be rejected with:
     `"No recent verified quote is available for this ticker."`
  4. Suffix mismatch: The gateway returns `"BDO.PS"` while the user queried `"BDO"`. `q.symbol === symbol` returns `false`, causing `quote === undefined`.

### 2.2 Bug R2.2: Absence of Local Dexie Stale Cache Fallback

- **Location**: `src/market/providers.ts:18`
- **Observed Behavior**:
  When offline, in airplane mode, or when upstream providers (Yahoo Finance / FCS API) return HTTP 503 / 500 / timeouts:
  - `externalResponse` throws: `"The market source could not return this data. Your last saved prices are kept."`
  - Neither `latestPrice` nor the UI queries Dexie's `financeDb.prices` or `financeDb.instruments`.
  - The unhandled rejection propagates to `InvestmentPages.tsx`, triggering global page error banners and showing empty balances.

### 2.3 Bug R2.3: International Ticker Colon Mismatch in Dev Proxy

- **Location**: `src/market/providers.ts:15` vs `functions/src/index.ts:57`
- **Observed Behavior**:
  In `globalResponse(path)`:
  ```ts
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    try { return await externalResponse(path); } catch { /* Public daily data also works without a local gateway. */ }
  }
  ```
  When fetching international tickers like `US:AAPL`, `externalResponse('/quotes?symbols=US%3AAAPL')` hits the local Cloud Function proxy `/api/getMarketQuote`.
  However, `functions/src/index.ts:57` validates symbols with `/^[A-Za-z0-9._-]+$/` which rejects colons `:`.
  The Cloud Function returns HTTP 400 (`"Invalid symbol parameter"`). Although `catch` falls back to the Crible mirror, an unnecessary network failure is logged in DevTools for every international quote.

---

## 3. Technical Design & Architecture

### 3.1 Normalization Layer: `normalizeQuote`

The quote normalizer bridges backend gateway responses, client mirror data, Dexie cache rows, and manual valuations into the canonical `MarketQuote` contract:

```ts
export interface MarketQuote extends MarketInstrument {
  value: number;
  asOf: string;
  marketDate?: string;
  timestampPrecision?: string;
  source: string;
  sourceUrl?: string;
  freshness: string;
  changePercent?: number;
  isStale?: boolean;
  change?: number;
  staleReason?: string;
}
```

#### Property Mapping Rules
| Input Field (Gateway / Mirror / Cache) | Normalized Field (`MarketQuote`) | Logic / Fallback |
| :--- | :--- | :--- |
| `raw.value ?? raw.price` | `value` | Validated: must be finite and $> 0$. Rejects zero/negative values. |
| `raw.source ?? raw.provider` | `source` | If `raw.source` exists, keep. Else if `provider === 'cache'`, map to `'Gateway Cache (Stale)'`. Else `'Gateway (${provider})'`. Fallback to `'Market Gateway'`. |
| `raw.freshness` | `freshness` | Uses `raw.freshness` or `'stale'` if `raw.isStale`, otherwise `'delayed'`. |
| `raw.isStale` | `isStale` | Boolean: `Boolean(raw.isStale || freshness === 'stale')`. |
| `raw.currency` | `currency` | Uppercased 3-letter ISO code (`/^[A-Z]{3}$/`). Defaults to `'PHP'`. |
| `raw.asOf ?? raw.timestamp` | `asOf` | ISO 8601 string. Clock-skew defense: clamped to current time if $> \text{now} + 5\text{ min}$. |
| `raw.name ?? raw.symbol` | `name` | Non-empty string. Defaults to ticker symbol if name omitted. |
| `raw.assetType` | `assetType` | Lowercase string. Defaults to `'stock'`. |
| `raw.changePercent` | `changePercent` | Finite number or `undefined`. |
| `raw.change` | `change` | Finite number or `undefined`. |

#### Critical Invariants
- **Critical Zero-Price Defense**: Never returns a quote with `value <= 0`, `NaN`, or non-finite numbers.
- **Strict Currency Integrity**: Rejects invalid currency lengths or malformed symbols.
- **Clock Skew Defense**: Prevents future timestamps beyond 5 minutes ahead of client time.

### 3.2 Local Dexie Cache Fallback: `getStalePriceFromDb`

When remote fetching fails, `latestPrice` queries the local database:
1. **Instrument Discovery**:
   Scans `financeDb.instruments` for non-deleted records matching `symbol`, `sourceSymbol`, or instrument `id`, handling case-insensitivity and `.PS` suffix equivalence.
2. **Price Retrieval**:
   Queries `financeDb.prices` for matching `instrumentId` or `sourceSymbol`.
   Filters out soft-deleted (`deletedAt`) records and invalid non-positive values.
3. **Recency Ordering**:
   Sorts candidates descending by `asOf` (or `fetchedAt`) timestamp.
4. **Stale Decorator**:
   Wraps the most recent price into a `MarketQuote`:
   - `freshness: 'stale'`
   - `isStale: true`
   - `source: "${baseSource} (Stale cache)"`

### 3.3 Enhanced `marketProvider.latestPrice` Call Chain

```
                   ┌───────────────────────────────┐
                   │ latestPrice(symbol: string)   │
                   └──────────────┬────────────────┘
                                  │
                  symbol.includes(':') ?
                  /               \
            [Yes]                   [No]
              /                       \
 ┌────────────────────────┐  ┌────────────────────────┐
 │ globalResponse(path)   │  │ externalResponse(path) │
 │ (Crible daily mirror)  │  │ (Cloud Function gw)    │
 └────────────┬───────────┘  └────────────┬───────────┘
              │                           │
              └─────────────┬─────────────┘
                            │
               Network success & quote found?
                            │
                   /                 \
             [Yes]                     [No / Error thrown]
               /                         \
 ┌───────────────────────────┐    ┌───────────────────────────┐
 │ normalizeQuote(rawQuote)  │    │ getStalePriceFromDb(sym)  │
 └─────────────┬─────────────┘    └─────────────┬─────────────┘
               │                                │
      Returns fresh quote             Found cached price in Dexie?
                                                │
                                       /                 \
                                 [Yes]                     [No]
                                   /                         \
                     Returns stale quote        Rethrows fetch error
                     (freshness: 'stale')       ("No verified quote")
```

---

## 4. Implementation Specification

### 4.1 Changes in `src/market/providers.ts`

The proposed implementation replaces lines 8–20 of `src/market/providers.ts` with:
- Extended `MarketQuote` interface (`isStale?: boolean; change?: number; staleReason?: string;`)
- Exported `normalizeQuote(raw: any, fallbackSymbol?: string): MarketQuote`
- Exported `getStalePriceFromDb(symbol: string): Promise<MarketQuote | null>`
- Fixed `globalResponse`: guards localhost external check with `!path.includes(':') && !path.includes('%3A')`
- Resilient `marketProvider.latestPrice`: wraps live fetch in `try/catch`, uses `normalizeQuote` with flexible symbol/suffix matching, and falls back to `getStalePriceFromDb`.

A fully prepared drop-in replacement is stored at:
`e:/Visual Studio Code/tala/.agents/teamwork/explorer_m2_1/proposed_providers.ts`
and as a git diff patch at:
`e:/Visual Studio Code/tala/.agents/teamwork/explorer_m2_1/providers.patch`

### 4.2 Downstream Milestone 2 Impact

- **Feature 9 (Markets UI Error Isolation)**:
  `MarketsPage` in `src/pages/InvestmentPages.tsx` can now display inline "Stale" badges when `quote.isStale` is true, without failing the entire page.
- **Feature 10 (Investment Tracking & Usability)**:
  `refreshInstrumentPrice` now reliably refreshes Philippine securities without throwing validation errors. Holdings valuations will not drop to zero when offline.

---

## 5. Test Plan & Acceptance Criteria

### 5.1 Test Suite Structure (`tests/market-provider.test.ts`)

| # | Test Case | Target Function | Assertion |
|---|---|---|---|
| 1 | Map gateway `{ price, provider }` to `{ value, source }` | `normalizeQuote` | `quote.value === 155`, `quote.source === 'Gateway (yahoo)'` |
| 2 | Gateway Firestore cache stale quote mapping | `normalizeQuote` | `quote.isStale === true`, `quote.freshness === 'stale'`, `quote.source === 'Gateway Cache (Stale)'` |
| 3 | Preserve native client `{ value, source }` | `normalizeQuote` | Retains native value and Crible mirror source unchanged |
| 4 | Critical Zero-Price Defense | `normalizeQuote` | Rejects price $\le 0$, negative, or NaN with descriptive error |
| 5 | Currency format validation | `normalizeQuote` | Rejects non-3-letter ISO currency codes |
| 6 | Clock skew future date defense | `normalizeQuote` | Dates $> \text{now} + 5\text{m}$ clamped to current timestamp |
| 7 | Retrieve latest price from Dexie | `getStalePriceFromDb` | Returns latest price with `freshness: 'stale'` and `(Stale cache)` source |
| 8 | Suffix equivalence (`BDO` vs `BDO.PS`) | `getStalePriceFromDb` | Correctly resolves `BDO` when Dexie record has `BDO.PS` |
| 9 | Ignore soft-deleted prices | `getStalePriceFromDb` | Returns `null` when candidate price has `deletedAt` set |
| 10 | Live gateway fetch with property mapping | `latestPrice` | Resolves live quote with mapped `value` and `source` |
| 11 | Fallback to Dexie on network failure | `latestPrice` | Returns stale quote when network throws |
| 12 | Throw error when both live and Dexie fail | `latestPrice` | Throws clear rejection when symbol is completely unknown |
| 13 | End-to-end `refreshInstrumentPrice` | `refreshInstrumentPrice` | Persists normalized price into Dexie without validation failure |

A complete test file is prepared at:
`e:/Visual Studio Code/tala/.agents/teamwork/explorer_m2_1/proposed_market_provider.test.ts`

---

## 6. Artifact Index

1. `report.md`: This comprehensive analysis and technical design document.
2. `handoff.md`: 5-component handoff report for the implementer agent.
3. `proposed_providers.ts`: Production-ready TypeScript code for `src/market/providers.ts`.
4. `providers.patch`: Unified diff patch applicable via `git apply`.
5. `proposed_market_provider.test.ts`: Complete Vitest test suite for `tests/market-provider.test.ts`.
6. `progress.md`: Liveness heartbeat and status checklist.
7. `BRIEFING.md`: Persistent situational memory.
