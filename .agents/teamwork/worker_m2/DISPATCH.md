# Dispatch for Worker M2

## Identity & Role
- Role: Milestone 2 Implementer (Market Data Reliability & Investment Usability)
- Working directory: e:/Visual Studio Code/tala/.agents/teamwork/worker_m2/
- Original Request path: e:/Visual Studio Code/tala/.agents/teamwork/ORIGINAL_REQUEST.md
- Project Scope: e:/Visual Studio Code/tala/PROJECT.md
- Project Root: e:/Visual Studio Code/tala

## Mandatory Integrity Warning
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Milestone 2 Implementation Scope
You exclusively own and modify the following files:
- `src/market/providers.ts`
- `src/pages/InvestmentPages.tsx`
- `tests/market-gateway.test.ts`
- `tests/investments-ui.test.ts` (new test suite if needed)

### Explorer Reports to Read & Apply
1. `e:/Visual Studio Code/tala/.agents/teamwork/explorer_m2_1/report.md` and `e:/Visual Studio Code/tala/.agents/teamwork/explorer_m2_1/proposed_providers.ts`
2. `e:/Visual Studio Code/tala/.agents/teamwork/explorer_m2_2/report.md`
3. `e:/Visual Studio Code/tala/.agents/teamwork/explorer_m2_3/report.md`

### Requirements to Implement (R2: Features 7, 8, 9, 10)
1. **Quote Normalization & Schema Reconciliation (`src/market/providers.ts`)**:
   - Normalize Cloud Function gateway response: map `{ price, provider, freshness, isStale }` to `{ value, source, freshness }`. Support both `price` and `value`.
   - Prevent 0-price false positive errors; preserve valid prices.
   - Suffix tolerance: support `.PS` stripping / fallback for Philippine stock tickers.
2. **Dexie Stale Quote Fallback (`src/market/providers.ts`)**:
   - In `latestPrice(symbol)`: on network drop or fetch rejection, query Dexie table `financeDb.prices` (and `instruments`) for the latest known price. If found, return as a stale quote (`freshness: 'stale'`) rather than throwing an unhandled error.
3. **MarketsPage UI Error Isolation & Success State (`src/pages/InvestmentPages.tsx`)**:
   - In `MarketsPage`: Use `Promise.allSettled` to fetch quotes in parallel. Isolate errors per ticker (`quoteErrors`), rendering an "Unavailable / Stale" badge in the table and a graceful detail card for unquoted symbols.
   - Eliminate the red error banner when successfully saving an instrument: introduce a proper `successMessage` green banner.
   - Prevent duplicate additions ("In Investments" button state).
4. **InvestmentsPage Workflow & Visuals (`src/pages/InvestmentPages.tsx`)**:
   - **Portfolio Overview Header**: Render total portfolio market value converted to base currency, open cost basis, aggregate unrealized return with `TrendIndicator`, and a multi-segment Asset Allocation progress bar across asset classes (PSE_STOCK, UITF, PAGIBIG_MP2, CRYPTO, etc.).
   - **Holdings Performance Visuals**: Embed responsive Recharts `<HoldingSparkline />` on holding cards with green/red gradients, and add an interactive `<HoldingHistoryModal />` for viewing price history.
   - **Friction-Free TradeForm**: Support "By Units" and "By Total Cash" entry modes; pre-fill unit price with latest quote; display available units for sales with "Sell All" action; align integer cents.
   - **Live-Impact PriceForm**: Display prior NAV/price and as-of date; show real-time delta preview and holding value impact; seamlessly handle date updates and display valuation history.

### Verification Commands
Run and document results in your handoff:
- `npx vitest run tests/market-gateway.test.ts`
- `npx vitest run tests/calculations.test.ts`
- `npx vitest run tests/e2e-overhaul.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm test`

Deliver your changes, write a self-contained `handoff.md` in your working directory, and message the orchestrator when finished.
