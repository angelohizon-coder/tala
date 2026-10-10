# Handoff Report: Survey Explorer 2
**Working Directory**: `e:/Visual Studio Code/tala/.agents/teamwork/explorer_survey_2/`  
**Parent Agent ID**: `eda11da7-95b7-4ab4-bbe9-521cf16c63d4`  
**Date**: 2026-10-10  
**Handoff Type**: Hard (Task Complete)  

---

## 1. Observation

1. **Market Quote Gateway Property Mismatch (R2)**:
   - In `functions/src/index.ts:9-24`, the Cloud Function `NormalizedMarketQuote` returns:
     `{ symbol: string, price: number, currency: string, provider: 'yahoo' | 'fcs' | 'cache', freshness: 'realtime' | 'delayed' | 'stale', isStale: boolean, asOf: string, ... }`.
   - In `src/market/providers.ts:8-9`, client `MarketQuote` expects:
     `{ symbol: string, name: string, currency: string, value: number, source: string, asOf: string, freshness: string }`.
   - In `src/market/providers.ts:18`, `latestPrice` strictly checks:
     ```ts
     const quote = data.quotes?.find((q: MarketQuote) => q.symbol === symbol);
     if (!quote || !Number.isFinite(quote.value) || quote.value <= 0 || ... || typeof quote.source !== 'string' || !quote.source.trim())
       throw new Error(data.issues?.[0]?.message || 'No recent verified quote is available for this ticker.');
     ```
     Because the gateway returns `quote.price` and `quote.provider`, `quote.value` and `quote.source` are `undefined`, causing every quote returned by the gateway to fail with `Error: No recent verified quote is available for this ticker.`
2. **Missing Local Stale Quote Fallback (R2)**:
   - In `src/market/providers.ts:18`, on network error or upstream failure, `latestPrice` directly lets the error reject the promise. There is no fallback lookup in Dexie table `financeDb.prices`.
   - In `src/pages/InvestmentPages.tsx:68-71`, `MarketsPage` catches single quote errors in `Promise.all` and directly executes `setError((e as Error).message)`, displaying a red global error banner across the entire page even when other quotes loaded successfully.
   - In `src/pages/InvestmentPages.tsx:103`, saving a quote to Investments calls `if (catalog === catalogVersion.current) setError(`${quote.name} saved in Investments. Record a purchase to create a holding.`);`, which uses `error` state and renders in a red error banner for a success message.
3. **Missing Dedicated Expenses Experience (R3)**:
   - In `src/App.tsx:21`, the registered navigation items and routes are:
     `'/'`, `'/transactions'`, `'/accounts'`, `'/budgets'`, `'/investments'`, `'/markets'`, `'/fire'`, `'/debts'`, `'/reports'`, `'/data'`, `'/settings'`.
     There is **no `/expenses` route or page**.
   - In `src/db/repository.ts:232`, `monthlyCashFlow` treats all `INTEREST` transactions as income (`if (['INCOME', 'INTEREST', 'DIVIDEND'].includes(row.type)) income = row.amount;`), whereas `src/core/calculations.ts:486-487` treats `INTEREST` on liability accounts as consumption expenses.
4. **Missing Accounts Reordering & Sorting (R4)**:
   - In `src/pages/LedgerPages.tsx:111-160`, `AccountsPage` loads accounts with `useAccounts()` and renders cards in `displayed.map(...)`.
   - There are **no drag-and-drop attributes or event handlers** (`draggable`, `onDragStart`, `onDragOver`, `onDrop`).
   - There are **no sorting controls** (no dropdown or buttons to sort by name, balance, currency, or account type).
   - There is **no state persistence** for custom order or sort preference in `financeDb.settings` or `localStorage`.
5. **Existing Verification Suite**:
   - `npm.cmd test`: All 20 test files, 347 tests pass cleanly.
   - `npm.cmd run typecheck`: Passes with 0 TypeScript compilation errors.

---

## 2. Logic Chain

1. **R2 Invalidation Chain**:
   - Observation 1 demonstrates that the gateway output schema (`price`, `provider`) directly contradicts the client validator (`value`, `source`).
   - Therefore, any request to the Philippine market gateway (`externalResponse`) fails client-side validation despite HTTP 200 from the server.
   - Observation 2 demonstrates that neither `marketProvider` nor `MarketsPage` queries IndexedDB `financeDb.prices` upon network failure.
   - Therefore, offline or rate-limited sessions crash or display "Unavailable" instead of cleanly displaying the last known cached quote with a `STALE` badge.
2. **R3 Invalidation Chain**:
   - Observation 3 shows that the application only provides `/debts` and generic `/transactions`, with no dedicated `/expenses` tracking view.
   - Furthermore, the discrepancy between `src/db/repository.ts` and `src/core/calculations.ts` means interest charged to liability accounts (credit cards/mortgages) is inconsistently calculated as income in repository queries but as expense in core calculations.
3. **R4 Invalidation Chain**:
   - Observation 4 shows `AccountsPage` renders cards in database primary key order with zero reordering logic, zero sorting controls, and zero persistence.
   - Therefore, Requirement R4 is completely unimplemented in the current codebase.

---

## 3. Caveats

- **External Gateway Runtime**: Live cloud function testing requires internet connectivity to `us-central1-kotoba-41ab0.cloudfunctions.net` or a local Firebase emulator on port 5001. All analysis was conducted via direct static code inspection and unit tests in `tests/market-gateway.test.ts`.
- **Drag-and-Drop Library Policy**: No third-party drag-and-drop library is installed in `package.json`. Native HTML5 drag-and-drop with keyboard/touch fallback buttons is recommended to avoid bundle bloat and React 19 compatibility issues.
- No caveats on other investigated areas.

---

## 4. Conclusion

The codebase possesses solid underlying foundations (pure calculation engine in `src/core/calculations.ts`, atomic IndexedDB in `src/db/repository.ts`, comprehensive unit test suite). However, requirements R2, R3, and R4 have critical bugs and missing features:
1. **R2**: Fix quote normalization in `src/market/providers.ts` (`price` → `value`, `provider` → `source`), add Dexie `financeDb.prices` stale cache fallback, isolate UI error handling in `MarketsPage`, and add Recharts visual price history.
2. **R3**: Implement a dedicated `ExpensesPage` (`/expenses`) with category summaries and monthly living expense breakdown; reconcile liability interest accounting between `repository.ts` and `calculations.ts`.
3. **R4**: Implement HTML5 drag-and-drop card reordering in `AccountsPage`, add multi-field sorting controls (Name, Balance, Currency, Type, Custom), and persist ordering in both `localStorage` and `financeDb.settings`.

Full detailed analysis, code snippets, and architectural recommendations are documented in:
`e:/Visual Studio Code/tala/.agents/teamwork/explorer_survey_2/report.md`

---

## 5. Verification Method

1. **Verify Existing Tests**:
   ```powershell
   npm.cmd test
   npm.cmd run typecheck
   ```
2. **Inspect Identified File Locations**:
   - `src/market/providers.ts:14-21` (quote mapping & latestPrice)
   - `functions/src/index.ts:9-24,374-389` (NormalizedMarketQuote schema)
   - `src/pages/InvestmentPages.tsx:68-106` (MarketsPage quote fetch loop & error banner)
   - `src/App.tsx:21` (navigation routes list lacking `/expenses`)
   - `src/pages/LedgerPages.tsx:111-160` (AccountsPage lacking drag-and-drop & sorting)
   - `src/db/repository.ts:232` (monthlyCashFlow interest classification)
3. **Invalidation Conditions**:
   - If `src/market/providers.ts:18` already normalizes `quote.price` to `quote.value`, this finding would be invalidated (confirmed absent).
   - If an `/expenses` route exists in `src/App.tsx`, finding R3 would be invalidated (confirmed absent).
   - If `AccountsPage` already handles `onDragStart` or sorts by field, finding R4 would be invalidated (confirmed absent).
