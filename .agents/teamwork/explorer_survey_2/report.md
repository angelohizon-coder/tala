# Survey Explorer 2: Technical Investigation Report
**Domains Covered**: R2 (Market Data & Investments), R3 (Financial Ledger: Expenses & Debts), R4 (Accounts Management)  
**Project Root**: `e:/Visual Studio Code/tala`  
**Date**: 2026-10-10  

---

## 1. Executive Summary

This report delivers a comprehensive code audit and architectural investigation of the Tala personal finance SPA across three critical domains:
1. **R2: Market Data Reliability & Investment Usability Overhaul**
2. **R3: Financial Ledger Structure (Dedicated Expenses & Debt Workflows)**
3. **R4: Accounts Management (Drag-and-Drop Reordering, Multi-Field Sorting, Persistence)**

### Core Discoveries at a Glance
- **R2 Critical Failure**: A property schema mismatch between the Cloud Function gateway (`functions/src/index.ts` returns `price`, `provider`, `freshness`) and the client market provider (`src/market/providers.ts` strictly validates `quote.value` and `quote.source`) causes Philippine quotes fetched via the gateway to fail validation and throw `Error: No recent verified quote is available for this ticker`. Furthermore, neither `marketProvider.latestPrice` nor the UI falls back to locally cached prices in Dexie when the network or upstream providers fail.
- **R3 Structural Gap**: While a `/debts` page exists for liability accounts and loans, there is **no dedicated `/expenses` page** in the application. Expenses are only visible in a raw paginated list in `/transactions` or aggregated in statistical `/reports`. Furthermore, there is an accounting inconsistency: `src/core/calculations.ts` classifies interest on liability accounts as consumption expenses, whereas `src/db/repository.ts:monthlyCashFlow` classifies all `INTEREST` as income.
- **R4 Missing Functionality**: `src/pages/LedgerPages.tsx:AccountsPage` currently displays accounts in static Dexie database order with **zero drag-and-drop capability**, **zero sorting controls**, and **no ordering persistence** in either `localStorage` or IndexedDB.

---

## 2. System Architecture & Inventory

### 2.1 File Map & Responsibilities

| Domain | File Path | Type | Purpose & Current Responsibilities |
| :--- | :--- | :--- | :--- |
| **Gateway** | `functions/src/index.ts` | Cloud Function | `getMarketQuote` HTTP endpoint. Strict CORS, symbol sanitization, multi-tier fallback (Yahoo Finance → FCS API → Firestore stale cache `/marketCache/{symbol}`). Returns `NormalizedMarketQuote`. |
| **Market** | `src/market/providers.ts` | Service Layer | `marketProvider` client service. Dispatches to `globalResponse` (international mirror) or `externalResponse` (Cloud Function gateway). Manages `refreshInstrumentPrice` and `refreshFx`. |
| **Market Mirror** | `tools/free-global-mirror.mjs` | Utility | Parquet-backed client-side mirror (`Crible` dataset) reading daily bars for US, HK, JP, GB, CA, AU stocks via Range requests. |
| **Investments UI** | `src/pages/InvestmentPages.tsx` | UI Pages | `InvestmentsPage` (portfolio cards, manual valuation, trade logging) and `MarketsPage` (search, quote table, date-range quote history). |
| **Ledger UI** | `src/pages/LedgerPages.tsx` | UI Pages | `AccountsPage` (account cards), `TransactionsPage` (filtered list), `BudgetsPage` (category budgets), `DebtsPage` (liability tracking & amortization). |
| **Planning UI** | `src/pages/PlanningPages.tsx` | UI Pages | `FirePage` (Monte Carlo simulation), `ReportsPage` (cash flow, net worth history, category spending), `SettingsPage` (FX rates, categories, preferences). |
| **App Routing** | `src/App.tsx` | App Shell | Topbar, sidebar navigation array, PWA update prompt, React Router route definitions. |
| **Calculations** | `src/core/calculations.ts` | Pure Math | `calculatePositions`, `calculateNetWorthFromBalances`, `calculateCashFlow`, `calculateAmortization`, `calculateBudget`, `calculateSavingsRate`. |
| **Database** | `src/db/database.ts` | Dexie Schema | Schema version 2 for IndexedDB `tala-finance`. Defines tables `accounts`, `transactions`, `postings`, `instruments`, `prices`, `fxRates`, `liabilityTerms`, `settings`. |
| **Repository** | `src/db/repository.ts` | DB Repository | Atomic CRUD operations, `saveTransaction`, `accountBalances`, `monthlyCashFlow`, `portfolio`, settings persistence. |
| **State Hooks** | `src/ui/useFinance.ts` | React Hook | `useLiveQuery` hook subscribing to Dexie tables; computes active net worth, trailing cash flow, FIRE summary, and monthly history. |

### 2.2 Data Schemas Relevant to R2, R3, R4

#### Dexie `accounts` Table
```ts
export interface Account extends Entity {
  name: string;
  institutionId?: string;
  accountType: AccountType; // CASH, SAVINGS, CHECKING, BROKERAGE, CREDIT_CARD, PERSONAL_LOAN, etc.
  currency: Currency;
  openingBalances?: Record<Currency, Money>;
  openingDate: DateOnly;
  includeInNetWorth: boolean;
  includeInLiquidNetWorth: boolean;
  includeInFire: boolean;
  emergency: boolean;
  archived: boolean;
  // NOTE: Currently NO sortOrder, order, or displayIndex field!
}
```

#### Dexie `instruments` and `prices` Tables
```ts
export interface Instrument extends Entity {
  name: string;
  symbol?: string;
  sourceSymbol?: string;
  instrumentType: InstrumentType; // PSE_STOCK, FOREIGN_STOCK, UITF, PAGIBIG_MP2, etc.
  currency: Currency;
  valuationMethod: ValuationMethod; // LIVE_MARKET, DAILY_NAV, MANUAL_PRICE, FIXED_PRINCIPAL, COMPOUNDING, MANUAL_VALUE
  manualValue?: Money;
  manualValueAsOf?: string;
}

export interface Price extends Entity {
  instrumentId: string;
  value: number; // Major units (or total statement value for MANUAL_VALUE)
  currency: Currency;
  asOf: string;
  fetchedAt: string;
  source: string;
  sourceSymbol?: string;
  staleAfter: string;
  status: 'fresh' | 'stale' | 'manual' | 'error';
}
```

#### Cloud Function `NormalizedMarketQuote` vs Client `MarketQuote`
```ts
// Cloud Function (functions/src/index.ts:9)
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

// Client Provider (src/market/providers.ts:9)
export interface MarketQuote {
  symbol: string;
  name: string;
  currency: string;
  value: number; // MISMATCH with backend 'price'
  source: string; // MISMATCH with backend 'provider'
  asOf: string;
  freshness: string;
  changePercent?: number;
}
```

---

## 3. R2 Deep-Dive: Market Data Reliability & Investment Usability Overhaul

### 3.1 Quote Fetching Architecture & Failure Modes

Quote fetching is handled by `marketProvider` (`src/market/providers.ts`). When `latestPrice(symbol)` is invoked:
1. If `symbol.includes(':')` is true (e.g. `US:AAPL`, `HK:0700`), it calls `globalResponse(path)` which reads from the `Crible` Parquet mirror via `tools/free-global-mirror.mjs`.
2. If `symbol` has no colon (e.g. `BDO`, `ALI`, `TEL` - Philippine exchange PSE), it calls `externalResponse(path)` which fetches from the Cloud Function gateway `/api/getMarketQuote?symbols={symbol}`.

### 3.2 Exact Bugs in Market Data Pipeline

#### Bug R2.1: Critical Property Mismatch Between Gateway and Client
- **Location**: `src/market/providers.ts:18` vs `functions/src/index.ts:374-389`
- **Mechanism**: The Cloud Function returns:
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
        "asOf": "2026-10-10T13:00:00.000Z"
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
  Because `quote.price` was sent instead of `quote.value`, `quote.value` is `undefined`.  
  Because `quote.provider` was sent instead of `quote.source`, `quote.source` is `undefined`.  
  `!Number.isFinite(quote.value)` immediately triggers, rejecting every single successful response from the Philippine gateway!
- **Impact**: All Philippine quotes fetched through the gateway fail with a cryptic error.

#### Bug R2.2: Zero Client-Side Fallback to Local Cached/Stale Quotes
- **Location**: `src/market/providers.ts:18`, `src/pages/InvestmentPages.tsx:68-71`
- **Mechanism**: When network connectivity is lost, or an upstream market provider fails (HTTP 503 / timeout), `latestPrice` throws an unhandled exception.
  Neither `marketProvider.latestPrice` nor `MarketsPage` queries the local Dexie `financeDb.prices` table for the last known recorded valuation.
- **Impact**: The UI fails with a hard error rather than cleanly presenting the last saved price flagged with a `STALE` indicator.

#### Bug R2.3: Global Page Error Banner on Single Quote Failure
- **Location**: `src/pages/InvestmentPages.tsx:68-71`
  ```ts
  await Promise.all(visible.slice(0, 8).map(async record => {
    try {
      const quote = await marketProvider.latestPrice(record.symbol);
      if (current()) setQuotes(previous => ({ ...previous, [record.symbol]: quote }));
    } catch (e) {
      if (current()) setError((e as Error).message);
    }
  }));
  ```
- **Mechanism**: Loading 8 watchlist quotes runs concurrently. If just 1 ticker fails (e.g. illiquid stock, missing bar), `setError((e as Error).message)` triggers a global error banner for the entire page, confusing the user even when the other 7 quotes loaded successfully.

#### Bug R2.4: Localhost Colon Mismatch
- **Location**: `src/market/providers.ts:15` vs `functions/src/index.ts:57`
- **Mechanism**: In `globalResponse` on `localhost:5173`, it attempts `await externalResponse(path)` first. But for international tickers like `US:AAPL`, `functions/src/index.ts` validates symbols with `/^[A-Za-z0-9._-]+$/` which rejects colons `:`. This causes an unnecessary HTTP 400 error on every dev request before falling back.

#### Bug R2.5: Anti-Pattern Error Banner for Success Feedback
- **Location**: `src/pages/InvestmentPages.tsx:103`
  ```ts
  if (catalog === catalogVersion.current) setError(`${quote.name} saved in Investments. Record a purchase to create a holding.`);
  ```
- **Mechanism**: Successful addition of a market instrument into user investments uses `setError()`, causing a red `<ErrorMessage message={error}/>` banner to display what is actually a success message!

### 3.3 Usability & Workflow Deficiencies in Investments

1. **Missing Visual Charts for Holdings & Historical Performance**:
   - `InvestmentsPage` provides cards with cost basis, unrealized gain, and dividends, but **no historical performance chart** or NAV timeline.
   - `MarketsPage` only renders historical prices in a plain text HTML table. Recharts (`AreaChart`/`LineChart`) is already installed in `package.json` and used in `Overview.tsx` and `PlanningPages.tsx`, but missing entirely from `InvestmentPages.tsx`.
2. **Account Currency Lock in Trade Recording**:
   - `TradeForm` restricts cash account selection strictly to accounts whose currency exactly matches the instrument's currency (`a.currency === instrument.currency`). If a user holds a USD stock in an account funded by PHP or has a multi-currency broker, recording is completely blocked with an empty state.
3. **Manual NAV / Valuation Friction**:
   - For mutual funds, UITFs, and Pag-IBIG MP2, manual NAV updates require opening a modal with no previous history view or comparison against past statement dates.

### 3.4 Technical Recommendations for R2

1. **Normalize Gateway Quotes in `marketProvider`**:
   In `src/market/providers.ts:14-18`, transform all returned quotes from `NormalizedMarketQuote` to `MarketQuote`:
   ```ts
   const normalizedQuote: MarketQuote = {
     symbol: raw.symbol,
     name: raw.name || raw.symbol,
     currency: raw.currency,
     value: raw.value ?? raw.price,
     source: raw.source ?? (raw.provider ? `Gateway (${raw.provider})` : 'Market Gateway'),
     asOf: raw.asOf,
     freshness: raw.freshness || 'delayed',
     changePercent: raw.changePercent,
     change: raw.change,
     isStale: Boolean(raw.isStale),
   };
   ```
2. **Implement Dexie Fallback in `latestPrice`**:
   When network fetch fails:
   ```ts
   // Fallback to local Dexie prices
   const localPrice = await financeDb.prices
     .where('sourceSymbol')
     .equals(symbol)
     .or('instrumentId')
     .equals(symbol)
     .filter(p => !p.deletedAt && p.value > 0)
     .reverse()
     .sortBy('asOf')
     .then(rows => rows[0]);
   if (localPrice) {
     return {
       symbol,
       name: symbol,
       currency: localPrice.currency,
       value: localPrice.value,
       asOf: localPrice.asOf,
       source: `${localPrice.source} (Offline / Stale cache)`,
       freshness: 'stale',
       isStale: true,
     };
   }
   ```
3. **Isolate Quote Errors in `MarketsPage`**:
   Remove `setError` from the batch quote loading loop. Track per-symbol loading/error status in `quoteErrors: Record<string, string>`, showing inline "Unavailable" or "Stale" badges rather than a whole-page error banner.
4. **Replace Anti-Pattern Banner with Dedicated Feedback Notice**:
   Replace `setError(`${quote.name} saved...`)` with a `successMessage` state styled with a green check badge.
5. **Add Recharts Price History Chart in Markets & Holdings**:
   Integrate an `AreaChart` with 1W, 1M, 3M, 1Y time horizons for selected market quotes and investment instruments.

---

## 4. R3 Deep-Dive: Financial Ledger Structure (Dedicated Expenses & Debt Workflows)

### 4.1 Current Ledger Architecture & Data Model

The financial ledger is double-entry underneath:
- `transactions` records the user event (date, amount, currency, accountId, transferAccountId, principalAmount, categoryId, etc.).
- `postingsForTransaction` generates signed `postings` (`delta: Money`) for asset or liability accounts.
- Transaction types (`TRANSACTION_TYPES`):
  * Consumption: `EXPENSE`, `FEE`, `REFUND`
  * Income: `INCOME`, `INTEREST`, `DIVIDEND`
  * Transfers: `TRANSFER`, `INVESTMENT_CONTRIBUTION`, `INVESTMENT_WITHDRAWAL`
  * Investments: `INVESTMENT_BUY`, `INVESTMENT_SELL`
  * Reconcile: `BALANCE_ADJUSTMENT`

### 4.2 Structural Gaps in Expenses & Debts

#### Gap R3.1: Complete Absence of a Dedicated Expenses View
- In `src/App.tsx:21`, the routes are:
  `/`, `/transactions`, `/accounts`, `/budgets`, `/investments`, `/markets`, `/fire`, `/debts`, `/reports`, `/data`, `/settings`.
- **There is no `/expenses` view.** Users have no dedicated interface to review month-to-month living expenses, examine expense category hierarchies, or inspect discretionary versus essential spending.
- The user request explicitly demands:
  *"Provide a clear, dedicated Expenses tracking experience alongside the existing Debts section."*

#### Gap R3.2: Accounting Confusion Between Living Expenses vs Debt Amortization vs Transfers
- When a user pays off a credit card or loan:
  1. **Credit Card Payments**: A credit card purchase is recorded as `EXPENSE` on the card account. The repayment from checking to credit card is a `TRANSFER`. Counting the repayment as an expense would double-count spending.
  2. **Loan Amortizations (Mortgage, Car, Personal Loan)**: Each monthly payment contains two parts:
     - **Principal reduction**: Pays down the debt liability (a transfer of balance).
     - **Interest charge**: The cost of borrowing (a consumption expense).
  3. **Current Code Vulnerability in `src/core/calculations.ts:504-515`**:
     If a user records a transfer to a non-card loan without an explicit `principalAmount`:
     ```ts
     if (transaction.principalAmount === undefined) {
       missingPrincipal = true;
       issues.push({ code: 'unclassified_principal', transactionId: transaction.id, accountId: destination.id });
       continue;
     }
     ```
     When `missingPrincipal` is true, `debtPrincipal` becomes `null`. If `includeDebtPrincipal` is enabled in settings, the entire cash flow summary and savings rate calculation breaks (`expenses: null`, `rate: null`)!

#### Gap R3.3: Inconsistency Between `repository.monthlyCashFlow` and `core.calculateCashFlow`
- **Location**: `src/db/repository.ts:232` vs `src/core/calculations.ts:486-487`
- In `src/core/calculations.ts`:
  ```ts
  const earned = kind === 'INCOME' || kind === 'DIVIDEND' || (kind === 'INTEREST' && !isLiability(account));
  const consumed = kind === 'EXPENSE' || kind === 'FEE' || kind === 'REFUND' || (kind === 'INTEREST' && isLiability(account));
  ```
  Interest posted to a liability account is correctly treated as an **expense** (interest owed).
- In `src/db/repository.ts:232`:
  ```ts
  if (['INCOME', 'INTEREST', 'DIVIDEND'].includes(row.type)) income = row.amount;
  ```
  `monthlyCashFlow` treats ALL interest as **income**, even if posted to a credit card or mortgage!

### 4.3 Technical Recommendations for R3

1. **Create a Dedicated `ExpensesPage` Component & Route (`/expenses`)**:
   - Add `/expenses` to `src/App.tsx` navigation and routing, positioned next to `/debts`.
   - Key Sections for `ExpensesPage`:
     * **Monthly Overview Header**: Month selector (`<input type="month">`), total living expenses converted to base currency, comparison to prior month (+/- %), and split between essential vs discretionary spending.
     * **Category Summary Breakdown**: Interactive cards/bars showing spending by top-level category and subcategories, with percent of total living expenses.
     * **Debt Amortization & Debt Servicing Summary Card**: Explicit callout of debt interest paid vs principal amortized this month, clearly demarcated as debt servicing rather than living consumption.
     * **Recent Expenses Feed**: Quick table of expense transactions for the month with quick-edit and inline categorize.
     * **Quick Log Expense Modal**: Streamlined form pre-filled with `type: EXPENSE`, remembering the last used account and category.
2. **Harmonize `monthlyCashFlow` in `src/db/repository.ts`**:
   Update line 232 of `src/db/repository.ts` to check account type, matching `calculations.ts`:
   ```ts
   const isLiabilityAccount = liabilityAccounts.has(row.accountId);
   if (['INCOME', 'DIVIDEND'].includes(row.type) || (row.type === 'INTEREST' && !isLiabilityAccount)) income = row.amount;
   else if (['EXPENSE', 'FEE'].includes(row.type) || (row.type === 'INTEREST' && isLiabilityAccount)) expenses = row.amount;
   ```
3. **Graceful Handling of Unsplit Loan Payments**:
   In `calculateCashFlow` and `DebtsPage`, when a loan payment transfer lacks `principalAmount`, instead of returning `null` and halting calculations, provide:
   - Clear UI prompt: *"Unsplit loan payment: specify principal amount to refine savings rate"*.
   - A fallback mode treating 100% of the payment as principal transfer or prompting for split.

---

## 5. R4 Deep-Dive: Accounts Management (Reordering, Sorting & Persistence)

### 5.1 Accounts Page & Card Architecture

In `src/pages/LedgerPages.tsx:111-160`:
- Accounts are loaded via `useAccounts()`: `financeDb.accounts.filter(a => !a.deletedAt).toArray()`.
- Cards are rendered in a CSS grid (`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6`).
- **Current State**:
  * No drag handles.
  * No `draggable` attribute or drag event handlers.
  * No sorting buttons or dropdowns.
  * No storage of sort mode or custom ordering.

### 5.2 Drag-and-Drop Implementation Analysis

To ensure React 19 compatibility and avoid external dependency bloat (no need for heavy packages like `@dnd-kit` or deprecated `react-beautiful-dnd`), **Native HTML5 Drag and Drop** with touch and keyboard accessibility is optimal:
- HTML5 DnD Attributes:
  * `draggable={sortBy === 'custom'}`
  * `onDragStart={(e) => handleDragStart(account.id)}`
  * `onDragOver={(e) => handleDragOver(e, account.id)}`
  * `onDragEnd={handleDragEnd}`
- Mobile & Keyboard Accessibility:
  * On touch devices and for keyboard screen reader users, provide accessible "Move left" / "Move right" (or "Move up" / "Move down") icon buttons on each card when in custom reorder mode.
  * Add `aria-grabbed`, `aria-dropeffect`, and announced position changes (`announcer.ts` is already in `src/components/ui/announcer.tsx`).

### 5.3 Multi-Field Sorting Controls

The user request specifies:
*"Add sorting controls to sort accounts by name, balance, currency, or account type. Maintain this custom ordering and sort preference across app reloads in local storage / IndexedDB."*

Sort Modes to Implement:
1. `custom`: User-defined drag-and-drop order.
2. `name`: Alphabetical A→Z and Z→A.
3. `balance`: Highest balance to lowest balance, or lowest to highest (using calculated balances converted to base currency or native amount).
4. `currency`: Grouped by currency code (PHP, USD, EUR, etc.).
5. `type`: Grouped by account type (`CASH`, `SAVINGS`, `CHECKING`, `BROKERAGE`, `CREDIT_CARD`, etc.).

### 5.4 State Persistence Architecture

Persistence must be resilient and instant:
1. **Dual Persistence Layer**:
   - **IndexedDB `financeDb.settings`**: Save `{ id: 'accounts:ordering', key: 'accounts:ordering', value: { sortBy, sortDirection, customOrder: string[] } }`. This integrates cleanly with Tala's sync engine and Dexie repository without modifying the Dexie table schemas or causing migration issues.
   - **`localStorage` (`tala:accounts:sort_preference`)**: Cache the sort configuration synchronously so that upon page reload or initial render, the account cards immediately appear in the user's preferred order without layout shift before IndexedDB query resolves.
2. **Reordering Logic**:
   When an account is dragged and dropped from index $i$ to index $j$:
   - Reorder the ID array: `customOrder = arrayMove(currentOrder, i, j)`.
   - Automatically switch `sortBy` to `'custom'` if the user was in another sort mode.
   - Save immediately to `localStorage` and asynchronously save via `financeRepository.setSetting('accounts:ordering', { sortBy: 'custom', sortDirection: 'asc', customOrder })`.

---

## 6. Test Strategy & Acceptance Criteria Verification

### 6.1 Existing Test Suite Status
- Running `npm.cmd test` passes 20 test files, 347 tests.
- Running `npm.cmd run typecheck` passes with zero TypeScript errors.

### 6.2 Proposed Test Coverage for New Implementations

| Domain | Target Test File | What to Test |
| :--- | :--- | :--- |
| **R2** | `tests/market-provider.test.ts` (New) | 1. `latestPrice` maps `price` → `value` and `provider` → `source` from Cloud Function responses.<br/>2. `latestPrice` falls back to Dexie stale cache when network throws.<br/>3. `MarketsPage` isolates failures so one failed quote does not set global error.<br/>4. Saving a market quote does not trigger error styling. |
| **R3** | `tests/expenses-ledger.test.ts` (New) | 1. Verify `/expenses` calculations distinguish living expenses from debt payments.<br/>2. Credit card payment transfers do not double-count in monthly expenses.<br/>3. Loan interest on liabilities counts as expenses, while loan principal counts as debt amortization.<br/>4. Unsplit loan transfers gracefully prompt without breaking cash flow. |
| **R4** | `tests/accounts-management.test.ts` (New) | 1. Custom account card reordering updates `customOrder` array.<br/>2. Multi-field sorting by name, balance, currency, type produces correct sort order.<br/>3. Reload simulation preserves sort preference and custom order from localStorage/Dexie settings. |

---

## 7. Implementation Checklist

- [ ] **R2 Market Data**:
  - [ ] Update `src/market/providers.ts` to normalize `NormalizedMarketQuote` (`price` → `value`, `provider` → `source`).
  - [ ] Add Dexie `financeDb.prices` fallback in `marketProvider.latestPrice` on network/API failure.
  - [ ] Fix `src/pages/InvestmentPages.tsx:MarketsPage` to isolate quote errors and fix success banner.
  - [ ] Add Recharts price history visualization for selected quotes and holdings.
- [ ] **R3 Expenses & Debts**:
  - [ ] Create `src/pages/ExpensesPage.tsx` and register route `/expenses` in `src/App.tsx`.
  - [ ] Add monthly living expense breakdown, essential vs discretionary split, and category distribution.
  - [ ] Fix `monthlyCashFlow` in `src/db/repository.ts` for liability interest.
  - [ ] Add debt servicing vs living expenses distinction.
- [ ] **R4 Accounts Management**:
  - [ ] Add HTML5 drag-and-drop attributes and event handlers to `AccountCard` in `src/pages/LedgerPages.tsx`.
  - [ ] Add sorting dropdown (`Custom`, `Name`, `Balance`, `Currency`, `Type`) and direction toggle.
  - [ ] Implement accessible keyboard/touch reorder controls (Move Up/Down).
  - [ ] Persist sort preference and custom order in both `localStorage` and `financeDb.settings`.
