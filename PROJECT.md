# Project: Tala Financial SPA Modernization

## Architecture
- **Frontend SPA**: React 18 / Vite 5 / TypeScript 5 / Tailwind CSS / PostCSS, hosted on GitHub Pages (`/tala/` base path).
- **Local Persistence & Privacy**: Dexie IndexedDB (`tala-finance`, schema v2, 17 tables). Client-side local-first operations produce zero outbound network calls when in local-only mode.
- **Synchronization Engine**: `navigator.locks` ('tala_sync') serializes multi-tab mutations. Composite per-table cursors prevent cross-table sync starvation. Firestore remote storage structured strictly as `/users/{uid}/{tableName}/{id}` with one-time batch migration for legacy `finance_entities`.
- **Security & Cloud Rules**: Firestore Security Rules strictly isolate data by user UID (`request.auth.uid == uid`), forbid anonymous authentication (`sign_in_provider != 'anonymous'`), and handle document deletions cleanly.
- **Financial Integrity**: Account sub-ledgers partitioned by fiat currency (`Record<Currency, Money>`), integer minor units arithmetic eliminating floating-point errors, unified valuation layer with dated exchange rates and missing-FX exclusion rules, linked cross-currency transfers with zero net income/expense generation.
- **Market Data Gateway**: Firebase Cloud Functions in `functions/` proxying market data from Yahoo Finance v8 and FCS API, restricting CORS to canonical GitHub Pages origin + localhost/preview ports, and caching valid quotes in Firestore to guarantee STALE preservation without returning zero.
- **Client-Side ML Categorization**: Dedicated Web Worker running `onnxruntime-web` with an INT8-quantized model classifying imported statement descriptions locally without data leakage.
- **FIRE Monte Carlo Projections**: Dedicated Web Worker executing 5,000+ stochastic iterations using Student's t-distribution ($\nu=5$), outputting Depletion Year Probability Density Functions (PDF) and percentile fan charts.
- **Design System & A11y**: Standardized Tailwind CSS theme featuring Tala Forest Green (`#173c34`), honest empty states (zero dummy/simulated data), and WCAG AA compliance (4.5:1 contrast, visible focus, color-independent gain/loss indicators).

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Build, Syntax & UTF-8 Encoding Fixes | Fix `engine.ts` unquoted keys, `src/firebase.ts` UTF-8 encoding, and PostCSS `@import` order in `styles.css` | M1 | Survey Obs 1.1 |
| 2 | Complete Supabase Purge | Delete `supabase/` directory, prune `@supabase/*` from package-lock, clean `README.md` | M1 | R1, Survey Obs 1.2 |
| 3 | Firestore Security Rules & Emulator Tests | Strict UID isolation `/users/{uid}/{tableName}/{id}`, deny anonymous users, handle deletion, test suite with `@firebase/rules-unit-testing` | M1 | R1, AC Security |
| 4 | Web Locks & Sync Engine Hardening | Multi-tab serialization via `navigator.locks`, composite per-table cursors, offline mutation queue & merge | M1 | R1, AC Sync |
| 5 | Legacy `finance_entities` Batch Migration | Batch-paginated migration from root `/finance_entities` to user collections with normalization | M1 | R1, Survey Obs 1.3 |
| 6 | Multi-Currency Account Sub-Ledgers | Model accounts with `Record<Currency, Money>` sub-ledgers (PHP, USD, EUR) simultaneously | M2 | R2, Survey Obs 1.4 |
| 7 | Integer Minor Units Arithmetic | Cash amounts stored and calculated as integer minor units (`Money`, `toMinor`, `fromMinor`, zero float error) | M2 | R2, Survey Obs 1.4 |
| 8 | Unified Valuation Layer & Missing FX Handling | Dated exchange rate conversion; missing rate excludes foreign balance from net worth instead of 1:1 fallback | M2 | R2, AC Financial |
| 9 | Linked Cross-Currency Transfers | Linked source/dest postings, separate actual amounts and fees, zero generated income/expense | M2 | R2, AC Financial |
| 10 | Financial Calculation Test Suite Repair & Verification | Repair 13 failing tests in `tests/calculations.test.ts`, verify PHP 10,000 + USD 100 @ 56 -> PHP 15,600 | M2 | AC Financial, Obs 1.4 |
| 11 | Cloud Function Market Data Gateway | Gateway function in `functions/` querying Yahoo Finance v8 and FCS API fallback with normalized schema | M3 | R3, Survey Obs 1.1 |
| 12 | Strict CORS Configuration | Restrict Cloud Function CORS strictly to canonical GitHub Pages origin and localhost:5173/5174 | M3 | R3, Survey Obs 1.1 |
| 13 | Firestore STALE Quote Preservation | Firestore cache `/marketCache/{symbol}`; preserve last valid quote with `isStale: true`, never return zero | M3 | R3, Survey Obs 1.1 |
| 14 | Client-Side ML Categorization Worker | Dedicated Web Worker running `onnxruntime-web` INT8-quantized model for local transaction classification | M4 | R4, Survey Obs 1.2 |
| 15 | Statement Import ML Integration | Integrate ML categorization into `DataPage.tsx` statement import with local IDB rule caching | M4 | R4, Survey Obs 1.2 |
| 16 | Student's t-Distribution Monte Carlo Engine | Stochastic simulation ($\nu=5, N \ge 5000$) in Dedicated Web Worker with fat-tail risk modeling | M5 | R5, Survey Obs 1.3 |
| 17 | Probability Density Function (PDF) FIRE Outputs | Depletion Year PDF distribution and P10-P90 trajectory percentiles in `PlanningPages.tsx` | M5 | R5, Survey Obs 1.3 |
| 18 | Tailwind Design System & Forest Green Palette | Configure `tailwind.config.js` with Tala Forest Green (`#173c34`), consolidate CSS custom properties | M6 | R6, Survey Obs 1.4 |
| 19 | Honest Empty States | Replace dummy/simulated data in empty states with honest onboarding and clear empty illustrations | M6 | R6, Survey Obs 1.4 |
| 20 | WCAG AA Accessibility Remediation | Visual icons + screen-reader text for gain/loss (WCAG 1.4.1), darkened text contrast $\ge 4.5:1$ (WCAG 1.4.3), visible focus rings | M6 | R6, Survey Obs 1.4 |
| 21 | End-to-End Acceptance Test Suite (Tiers 1-4) | Systematic Category-Partition, BVA, Pairwise, Real-World tests verifying all R1-R6 requirements | M7 | Dual Track E2E |
| 22 | Adversarial Coverage Hardening (Tier 5) | White-box stress-testing, edge-case generation, and adversarial verification | M7 | Final Hardening |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Architecture, Sync Engine & Supabase Removal | Features 1, 2, 3, 4, 5 (R1, AC Security, AC Sync) | none | DONE |
| M2 | Multi-Currency Data Modeling & Valuation | Features 6, 7, 8, 9, 10 (R2, AC Financial Integrity) | M1 | DONE |
| M3 | Market Data Gateway Cloud Function | Features 11, 12, 13 (R3) | none | DONE |
| M4 | Client-Side ML Categorization | Features 14, 15 (R4) | M1 | DONE |
| M5 | Advanced FIRE Monte Carlo Simulation | Features 16, 17 (R5) | M2 | DONE |
| M6 | UI/UX & WCAG Accessibility Refactoring | Features 18, 19, 20 (R6) | M1 | DONE |
| M7 | Final Milestone: 100% E2E Pass & Adversarial Hardening | Features 21, 22 (Pass 100% Tiers 1-4, then Tier 5 adversarial) | M1-M6, TEST_READY.md | DONE |

---

## Interface Contracts

### M1 ↔ M2: Storage & Types Interface
- `src/core/types.ts`:
  - `Money`: `number` (integer minor units).
  - `Account`: `openingBalances: Record<Currency, Money>`.
  - `Posting`: `accountId: string; currency: Currency; delta: Money;`.
  - `Transaction`: `currency: Currency; transferCurrency?: Currency; transferAmount?: Money; feeAmount?: Money;`.
- `src/db/schema.ts` / `src/db/repository.ts`:
  - IndexedDB storage preserves multi-currency account structures across sync pulls.

### M3 ↔ M2/M4: Market Data & Exchange Rates Interface
- Cloud Function endpoint: `POST /getMarketQuote` (and `GET /quote/:symbol`)
- Response Schema:
  ```typescript
  export interface NormalizedMarketQuote {
    symbol: string;
    price: number; // Decimal price
    currency: string;
    timestamp: number;
    asOf: string; // ISO 8601
    provider: 'yahoo' | 'fcs' | 'cache';
    freshness: 'realtime' | 'delayed' | 'stale';
    isStale: boolean;
    change?: number;
    changePercent?: number;
  }
  ```

### M4 ↔ M1/M6: ML Categorizer Web Worker Interface
- Worker Path: `src/workers/categorizer.worker.ts`
- Messages:
  - Input: `{ type: 'CATEGORIZE_TRANSACTIONS', payload: { transactions: Array<{ id: string; description: string; amount: number }> } }`
  - Output: `{ type: 'CATEGORIZE_SUCCESS', payload: { results: Array<{ id: string; categoryId: string; confidence: number }> } }`

### M5 ↔ M2/M6: FIRE Simulation Web Worker Interface
- Worker Path: `src/workers/monteCarlo.worker.ts`
- Messages:
  - Input: `{ type: 'START_SIMULATION', payload: { initialAssets: number; annualContribution: number; annualExpenses: number; inflationMean: number; inflationStd: number; equityMean: number; equityStd: number; equityDegreesOfFreedom: number; iterations: number; years: number } }`
  - Output: `{ type: 'SIMULATION_RESULT', payload: { successRate: number; trajectories: Float64Array[]; percentiles: { p10: number[]; p50: number[]; p90: number[] }; depletionYearPdf: Record<number, number> } }`

---

## Code Layout
- `src/core/`: Financial calculations, minor-unit arithmetic, types, valuation layer (`calculations.ts`, `types.ts`, `valuation.ts`).
- `src/sync/`: Web locks synchronization engine, Firebase remote adapter, offline mutation queue (`engine.ts`, `firebase.ts`, `types.ts`).
- `src/workers/`: Dedicated Web Workers for ML categorization and Monte Carlo simulations (`categorizer.worker.ts`, `monteCarlo.worker.ts`).
- `src/db/`: Dexie IndexedDB schemas, migrations, repository layer (`schema.ts`, `repository.ts`).
- `src/pages/`: React views (`Overview.tsx`, `LedgerPages.tsx`, `PlanningPages.tsx`, `DataPage.tsx`).
- `src/components/`: Reusable accessible components (`Money.tsx`, `TrendIndicator.tsx`, `EmptyState.tsx`).
- `functions/`: Firebase Cloud Functions backend (`src/index.ts`, `package.json`, `tsconfig.json`).
- `tests/`: Unit tests, E2E acceptance tests, security rules tests (`calculations.test.ts`, `repository.test.ts`, `e2e/`, `firestore-rules.test.ts`).
- `public/`: Static assets, model binaries (`models/categorizer-q8.onnx`, `404.html`).
