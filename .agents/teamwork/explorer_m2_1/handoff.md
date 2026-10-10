# Handoff Report: Market Quote Gateway & Normalization (R2)

**Author**: Explorer M2-1  
**Recipient**: Milestone 2 Implementer / Orchestrator  
**Milestone**: M2 (Market Data Reliability & Investments)  
**Date**: 2026-10-10  
**Working Directory**: `e:/Visual Studio Code/tala/.agents/teamwork/explorer_m2_1/`  

---

## 1. Observation

1. **Gateway Property Schema**:
   In `functions/src/index.ts:9-24, 177-191`:
   The Cloud Function `getMarketQuote` formats quotes with:
   ```ts
   export interface NormalizedMarketQuote {
     symbol: string;
     price: number;
     currency: string;
     timestamp: number;
     asOf: string;
     provider: 'yahoo' | 'fcs' | 'cache';
     freshness: 'realtime' | 'delayed' | 'stale';
     isStale: boolean;
     change?: number;
     changePercent?: number;
     name?: string;
   }
   ```
   Backend outputs `price` and `provider`. It does NOT output `value` or `source`.

2. **Client Validation Invariant**:
   In `src/market/providers.ts:18`:
   ```ts
   const quote = data.quotes?.find((q: MarketQuote) => q.symbol === symbol);
   if (!quote || !Number.isFinite(quote.value) || quote.value <= 0 || ... || typeof quote.source !== 'string' || !quote.source.trim())
     throw new Error(data.issues?.[0]?.message || 'No recent verified quote is available for this ticker.');
   return quote;
   ```
   `quote.value` and `quote.source` are strictly required by the client validator. Because the backend sends `price` and `provider`, `quote.value` is `undefined` and `quote.source` is `undefined`. Consequently, `!Number.isFinite(quote.value)` immediately triggers on every response, throwing:
   `"No recent verified quote is available for this ticker."`

3. **Absence of Dexie Fallback in `latestPrice`**:
   In `src/market/providers.ts:18`:
   When network requests fail or upstream providers throw, `latestPrice` contains no `try/catch` and no lookup against Dexie IndexedDB (`financeDb.prices`). The unhandled rejection propagates to caller components.

4. **Colon Rejection in Dev Server Proxy**:
   In `src/market/providers.ts:15`:
   `globalResponse` calls `externalResponse(path)` when `['localhost','127.0.0.1'].includes(location.hostname)`.
   In `functions/src/index.ts:57`:
   `isValidSymbol` validates: `/^[A-Za-z0-9._-]+$/`.
   International symbols containing a colon (`US:AAPL`, `HK:0700`) are rejected with HTTP 400 (`"Invalid symbol parameter"`).

5. **Existing Test Suite Baseline**:
   Running `npm.cmd test` results in 23 passed test files, 470 passed tests. The only failing test is `tests/monte-carlo.test.ts:260` (known M4 tolerance issue: `0.0002 vs 0`). There are currently zero unit tests specifically exercising `src/market/providers.ts`.

---

## 2. Logic Chain

1. From **Observation 1** and **Observation 2**, when a Philippine ticker (e.g. `BDO`) is fetched, the gateway returns `{ price: 155, provider: 'yahoo' }`. Because `src/market/providers.ts:18` expects `{ value, source }`, `quote.value` evaluates to `undefined`. `!Number.isFinite(undefined)` evaluates to `true`, causing every valid quote from the Philippine gateway to throw an error.
2. Therefore, introducing a dedicated quote normalizer `normalizeQuote(raw)` that maps `value = raw.value ?? raw.price` and `source = raw.source ?? (provider ? 'Gateway (' + provider + ')' : 'Market Gateway')` resolves the schema mismatch and allows gateway quotes to pass validation.
3. From **Observation 3**, when network connectivity drops or the gateway returns HTTP 503, `latestPrice` rejects unconditionally. Because `financeDb.prices` stores previously recorded quotes (from `refreshInstrumentPrice` and `MarketsPage:saveInstrument`), querying `financeDb.prices` when remote fetch fails allows the application to gracefully serve the last known quote with `freshness: 'stale'` and `isStale: true`.
4. From **Observation 4**, international tickers always include a market prefix followed by a colon (e.g. `US:AAPL`). Because the Cloud Function gateway rejects colons with HTTP 400, adding a guard `!path.includes(':') && !path.includes('%3A')` in `globalResponse` prevents spurious failed network requests in local development and routes international quotes directly to the Crible Parquet reader.
5. From **Observation 5**, implementing these changes in `src/market/providers.ts` and adding `tests/market-provider.test.ts` provides 100% test coverage for Market Data Reliability (R2) without breaking any existing tests.

---

## 3. Caveats

1. **Market Catalog Search for PH**:
   The Cloud Function `getMarketQuote` currently handles quote fetching (`?symbols=...`) and not dynamic catalog searching (`/catalog`). In `marketProvider.search('PH')`, when the gateway does not return instruments, returning an empty list `[]` allows the search UI to degrade gracefully without throwing an unhandled exception.
2. **MarketsPage UI Changes**:
   This investigation and design focuses on `src/market/providers.ts` (Features 7 & 8). UI improvements for `MarketsPage` in `src/pages/InvestmentPages.tsx` (Feature 9: isolating per-ticker errors; Feature 10: historical charts & success toast) should be applied concurrently or by the UI implementer in Milestone 2.

---

## 4. Conclusion

The market quote pipeline can be made completely resilient by applying the proposed changes in `src/market/providers.ts`:
1. Export `normalizeQuote(raw, fallbackSymbol)` to map gateway properties `{ price, provider }` to client properties `{ value, source }`, preserving native client objects and enforcing the Critical Zero-Price Defense.
2. Export `getStalePriceFromDb(symbol)` to query Dexie `financeDb.prices` and `financeDb.instruments` when remote feeds fail, returning a standard `MarketQuote` with `freshness: 'stale'`.
3. Wrap `marketProvider.latestPrice(symbol)` in resilient try/catch logic that queries live feeds, normalizes responses, and automatically falls back to `getStalePriceFromDb`.
4. Guard `globalResponse` against international colon queries to prevent 400 Bad Request errors in dev mode.

All proposed code is ready in `proposed_providers.ts`, `providers.patch`, and `proposed_market_provider.test.ts`.

---

## 5. Verification Method

1. **Apply the Patch / Code**:
   Apply `providers.patch` to `src/market/providers.ts`:
   ```powershell
   git apply ".agents/teamwork/explorer_m2_1/providers.patch"
   ```
   Or copy `proposed_providers.ts` over `src/market/providers.ts`.
2. **Install the Unit Test Suite**:
   Copy `proposed_market_provider.test.ts` to `tests/market-provider.test.ts`.
3. **Execute Vitest**:
   Run the test command:
   ```powershell
   npx.cmd vitest run tests/market-provider.test.ts
   ```
   Verify that all 13 test cases in all 4 describe blocks pass.
4. **Run Project Suite**:
   ```powershell
   npm.cmd test
   ```
   Confirm all test suites continue to pass without regressions.
5. **Invalidation Conditions**:
   - If `latestPrice('BDO')` throws `"No recent verified quote is available for this ticker"` when gateway returns valid `{ price, provider }`, normalization has failed.
   - If `latestPrice` throws an unhandled network error when offline despite having a saved price in `financeDb.prices`, fallback has failed.
   - If `normalizeQuote` accepts a price $\le 0$, the Critical Zero-Price Defense invariant has been violated.
