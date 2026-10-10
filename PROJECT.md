# Project: Tala Personal Finance SPA Overhaul

## Architecture
Tala is a modern offline-first personal finance single-page application built with React, TypeScript, Vite, Dexie (IndexedDB), and Firestore.
- **Client Core (`src/core/`)**: Pure calculation engines for currency formatting, FX rate conversions, double-entry lot balancing, and net worth calculations.
- **Data Layer (`src/db/`)**: Dexie IndexedDB (`FinanceDatabase` v2) maintaining 17 tables, atomic journal transactions, outbox queue for sync (`syncOutbox`), and offline persistence.
- **Sync Layer (`src/sync/`, `src/firebase.ts`, `firestore.rules`)**: Two-way synchronization between Dexie and Firestore under `/users/{uid}/{tableName}/{id}`.
- **Market Layer (`src/market/`)**: Quote providers fetching pricing with local cache fallbacks.
- **UI & Views (`src/pages/`, `src/ui/`, `src/styles.css`)**: Modular pages for Overview, Accounts, Transactions, Budgets, Investments, Markets, FIRE, Debts, Reports, Settings, plus new dedicated Expenses.
- **Web Workers (`src/workers/`)**: Heavy background computation for FIRE Monte Carlo simulations.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Seeded FX & Fallbacks | Seed baseline FX rates in Dexie; background auto-refresh on startup and currency switch | M1 | Survey E1 (R1) |
| 2 | Triangular Cross-Rates | Support multi-hop FX conversion (e.g. EUR->USD->PHP) in `getFxRate` | M1 | Survey E1 (R1) |
| 3 | Resilient Net Worth Aggregation | Never show empty `—` on multi-currency accounts; calculate `knownNetWorth` gracefully | M1 | Survey E1 (R1) |
| 4 | Firebase Auth Validation | Block anonymous tokens in client sync (`requireOwner()`), matching Firestore rules | M1 | Survey E1 (R7) |
| 5 | Firebase Config Key Security | Source Firebase keys from `import.meta.env` with fallback | M1 | Survey E1 (R7) |
| 6 | Snapshot Listener Resilience | Attach error handlers to Firestore snapshot listeners to prevent crash on network drops | M1 | Survey E1 (R7) |
| 7 | Market Quote Property Mapping | Map gateway `{ price, provider }` to client `{ value, source }` in quote normalizer | M2 | Survey E2 (R2) |
| 8 | Stale Quote Dexie Fallback | Fallback to `financeDb.prices` when quote gateway fails or is offline | M2 | Survey E2 (R2) |
| 9 | Markets UI Error Isolation | Isolate quote fetch errors per ticker in `MarketsPage`; fix success banner state | M2 | Survey E2 (R2) |
| 10 | Investment Tracking & Visuals | Intuitive activity recording, holding tracking, manual NAV/price adjustments, historical charts | M2 | Survey E2 (R2) |
| 11 | Dedicated Expenses View | Add `/expenses` route and dedicated `ExpensesPage` with category & monthly summaries | M3 | Survey E2 (R3) |
| 12 | Interest & Debt Accounting Reconciliation | Reconcile liability interest accounting between `repository.ts` and `calculations.ts` | M3 | Survey E2 (R3) |
| 13 | Accounts Drag-and-Drop Reordering | Drag-and-drop card reordering for accounts in `AccountsPage` | M3 | Survey E2 (R4) |
| 14 | Accounts Sorting Controls | Multi-field sorting dropdown (Name, Balance, Currency, Type, Custom) | M3 | Survey E2 (R4) |
| 15 | Accounts Order Persistence | Persist custom order and sort preference in localStorage & Dexie settings | M3 | Survey E2 (R4) |
| 16 | Bi-Weekly Recurring Frequency | Add `bi-weekly` (14-day cadence) to `RecurringRule` in DB and repository | M4 | Survey E3 (R5) |
| 17 | Recurring Due Banner & Prompts | Overdue and due-today confirmation banner on Overview and Budgets | M4 | Survey E3 (R5) |
| 18 | Recurring Transaction Origin Link | Visual badge and link in `TransactionsPage` showing recurring rule origin | M4 | Survey E3 (R5) |
| 19 | Budget Visual Progress & Alert States | Amber (>=85%) and red (>100%) alert states for category budget progress bars | M4 | Survey E3 (R5) |
| 20 | Safe FIRE Trajectory Mapping | Guard `fromMinor` against non-safe integers and NaN to prevent FIRE page crash | M4 | Survey E3 (R6) |
| 21 | Stable Inflation Compounding | Accumulate inflation compounding year-by-year in `fireSimulation.ts` worker | M4 | Survey E3 (R6) |
| 22 | Deterministic FIRE Trajectory | Closed-form deterministic retirement projection alongside Monte Carlo percentiles | M4 | Survey E3 (R6) |
| 23 | Multi-Currency FIRE Handling | Resilient FIRE asset valuation when foreign assets lack direct FX rates | M4 | Survey E3 (R6) |
| 24 | Monte Carlo Test Float Tolerance | Fix `tests/monte-carlo.test.ts:260` float assertion tolerance (0.0002 vs 0) | M4 | Survey E3 (R6) |
| 25 | Pinned Footer Flex Layout | Set `.workspace` and `#page-main` flex column with `margin-top: auto` on footer | M5 | Survey E3 (R8) |
| 26 | Mobile Touch Target Sizing | Ensure all interactive targets meet 44px touch target guidelines | M5 | Survey E3 (R8) |
| 27 | 390px Mobile Viewport Responsiveness | Horizontal scroll prevention on tables, responsive drawers, cards, and modals | M5 | Survey E3 (R8) |
| 28 | Comprehensive E2E & Unit Test Pass | 100% pass on `npm test`, `npm run build`, and `npm run typecheck` | M6 | Survey All |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Core Currency, Valuation & Data Sync | Features 1, 2, 3, 4, 5, 6 (R1, R7) | none | DONE |
| M2 | Market Data Reliability & Investments | Features 7, 8, 9, 10 (R2) | M1 | PLANNED |
| M3 | Financial Ledger, Expenses & Accounts | Features 11, 12, 13, 14, 15 (R3, R4) | M1 | PLANNED |
| M4 | Budgets, Recurring Rules & FIRE Engine | Features 16, 17, 18, 19, 20, 21, 22, 23, 24 (R5, R6) | M1 | PLANNED |
| M5 | Modern UI Shell, Pinned Footer & Mobile | Features 25, 26, 27 (R8) | M3, M4 | PLANNED |
| M6 | Final Acceptance, E2E Pass & Coverage Hardening | Feature 28 (All acceptance criteria) | M1, M2, M3, M4, M5 | PLANNED |

## Interface Contracts
### `src/core/calculations.ts` ↔ `src/pages/Overview.tsx`
- `calculateNetWorthFromBalances(accounts, positions, liabilities, fxRates, baseCurrency)`:
  Returns `{ netWorth: Money | null, knownNetWorth: Money, complete: boolean, missingFx: Currency[] }`.
  Overview displays `knownNetWorth` formatted with warning pill when `complete` is false, instead of returning `'—'`.
- `getFxRate(from, to, rates, asOf)`:
  Supports direct, inverse, and triangular routing (via USD or active base currency).

### `src/market/providers.ts` ↔ `src/pages/InvestmentPages.tsx`
- Quote normalizer accepts `{ symbol, price?, value?, provider?, source?, currency?, asOf?, freshness? }` and normalizes to standard `MarketQuote` with finite `value` and string `source`.
- `latestPrice(symbol)` checks live gateway, on failure queries `financeDb.prices` for latest known price marked as `stale`.

### `src/db/repository.ts` ↔ `src/pages/LedgerPages.tsx` / `ExpensesPage.tsx`
- `confirmRecurring(ruleId, date)` supports `'bi-weekly'` adding 14 days to `nextDueDate`.
- `getRecurringRules()` queried by Overview and Budgets to render `RecurringDueBanner`.
- `monthlyCashFlow()` properly categorizes interest expenses according to liability account classification.

### `src/workers/fireSimulation.ts` ↔ `src/pages/PlanningPages.tsx`
- Simulation worker returns `{ percentiles: TrajectoryPoint[], deterministic: TrajectoryPoint[], successRate: number }`.
- Trajectory points are safely converted from minor units clamping overflow beyond safe integers and safeguarding `NaN`.

## Code Layout
- `src/core/calculations.ts` — Core financial mathematical functions and conversions
- `src/db/database.ts` — Dexie database schema and TypeScript interfaces
- `src/db/repository.ts` — Repository query and mutation methods
- `src/sync/firebase.ts` — Firestore cloud synchronization provider
- `src/firebase.ts` — Firebase client configuration and initialization
- `src/market/providers.ts` — Market quote fetching and caching
- `src/pages/Overview.tsx` — Dashboard view with Net Worth and recurring banners
- `src/pages/InvestmentPages.tsx` — Investments and Markets views
- `src/pages/LedgerPages.tsx` — Accounts, Transactions, Budgets, Debts views
- `src/pages/ExpensesPage.tsx` — Dedicated Expenses tracking view
- `src/pages/PlanningPages.tsx` — FIRE Journey page
- `src/workers/fireSimulation.ts` — FIRE Monte Carlo Web Worker
- `src/styles.css` — Global styles, app shell, responsive layout, footer
- `tests/` — Test suites
