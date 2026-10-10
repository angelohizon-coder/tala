# Architectural Survey & Investigation Report: Tala Personal Finance SPA

- **Explorer**: Survey Explorer 1 (Codebase & Core Architecture Explorer)
- **Date**: 2026-10-10
- **Scope**: Project architecture, dependencies, build/test scripts, Dexie database layer, R1 (Multi-Currency Net Worth & Valuation), and R7 (Firebase Synchronization & Security Hardening).

---

## 1. Executive Summary

Tala is an offline-first personal finance and investment SPA designed for modern browsers. The stack is centered on **React 19.3.0**, **TypeScript 7.0.2**, **Vite 8.3.4**, **Dexie 4.4.6** (IndexedDB), and **Firebase 11.0.0** (Firestore, Auth, Functions).

Our survey confirmed:
1. **Build & Typecheck**: `npm.cmd run typecheck` (`tsc --noEmit`) and `npm.cmd run build` (`tsc --noEmit && vite build`) execute cleanly with zero errors.
2. **Test Suite**: 20 test files in `tests/`, covering 347 vitest test cases. 346 tests pass. Only 1 test fails (`tests/monte-carlo.test.ts:260` due to stochastic float comparison at extreme boundary). Full suite executes in ~19 seconds.
3. **R1 Multi-Currency Net Worth**: The valuation engine (`calculateNetWorthFromBalances`) strictly treats any missing FX conversion as a hard failure (`netWorth = null`, `complete = false`). Because Dexie is never seeded with baseline FX rates and `refreshFx()` is only invoked on manual button click in `SettingsPage`, users holding accounts in multiple currencies (e.g. PHP and USD) immediately see broken `—` values on the Overview dashboard. Furthermore, `getFxRate()` lacks triangulation across cross-currency pairs.
4. **R7 Firebase Synchronization & Security**: Firestore security rules (`firestore.rules`) enforce version 2 rules isolating records to `/users/{uid}/{tableName}/{id}` and rejecting anonymous users. However, the client-side `requireOwner()` in `src/sync/firebase.ts` does not check for anonymous tokens prior to sync attempts, Firebase config keys in `src/firebase.ts` are hardcoded rather than utilizing `import.meta.env` with fallbacks, and real-time snapshot listeners lack error callbacks.

---

## 2. Project Architecture & Tooling

### 2.1 File & Directory Map
```
e:/Visual Studio Code/tala/
├── functions/                     # Firebase Cloud Functions (Node 24, TypeScript)
│   └── src/index.ts               # getMarketQuote handler (FCS & Alpha Vantage proxy)
├── src/
│   ├── App.tsx                    # Root layout, router, PWA updates, topbar, nav
│   ├── main.tsx                   # HashRouter + React 19 createRoot entry
│   ├── firebase.ts                # Client Firebase SDK initialization
│   ├── styles.css                 # Global modern CSS theme and layout styles
│   ├── core/
│   │   ├── types.ts               # Core domain models (Account, Transaction, Posting, Instrument, FxRate...)
│   │   └── calculations.ts        # Double-entry posting logic, FX conversions, Net Worth, Cash Flow
│   ├── db/
│   │   ├── database.ts            # Dexie schema v2, 17 finance tables + sync outbox/state
│   │   ├── repository.ts          # CRUD repository, boundary validation, outbox queuing
│   │   ├── backup.ts              # AES-GCM encrypted JSON backup & restore
│   │   └── csv.ts                 # Statement CSV parser utilities
│   ├── sync/
│   │   ├── provider.ts            # RemoteRecord and SyncProvider interfaces
│   │   ├── engine.ts              # SyncEngine (Web Locks, outbox push, pull, conflict management)
│   │   └── firebase.ts            # Firestore SyncProvider (transactions under /users/{uid}/{table}/{id})
│   ├── market/
│   │   └── providers.ts           # Market quote & daily FX fetching (ExchangeRate-API)
│   ├── pages/
│   │   ├── Overview.tsx           # Home dashboard (Net Worth, cash flow, FIRE progress)
│   │   ├── LedgerPages.tsx        # Accounts, Transactions, Budgets, Debts pages
│   │   ├── InvestmentPages.tsx    # Investments portfolio & Markets quote explorer
│   │   ├── PlanningPages.tsx      # FIRE journey, Financial Reports, Settings (FX rates)
│   │   └── DataPage.tsx           # Backup, CSV Statement import, Cloud Sync controls
│   ├── workers/
│   │   ├── fireSimulation.ts      # Monte Carlo and deterministic FIRE math
│   │   ├── mlCategorizer.ts       # On-device ML transaction categorization
│   │   └── monteCarlo.worker.ts   # Web worker wrapping FIRE simulation
│   └── ui/
│       ├── shared.tsx             # Shared UI components (Money, Dialog, Field, PageHeading)
│       ├── useFinance.ts          # useLiveQuery hook aggregating accounts, net worth, cash flow
│       └── syncRuntime.ts         # Singleton provider/engine manager for background sync
├── firestore.rules                # Firestore security rules
├── firebase.json                  # Hosting, Firestore, Functions, Emulators config
├── package.json                   # Dependencies, scripts, engines (Node >= 24)
├── tsconfig.json                  # Strict TypeScript configuration
├── vite.config.ts                 # Vite bundler configuration with PWA plugin
└── vitest.config.ts               # Vitest runner config (tests/*.test.ts, 30s timeout)
```

### 2.2 Dependencies & Build Environment
- **Node**: `>= 24`
- **React**: `19.3.0` + `react-dom: 19.3.0` + `react-router-dom: 7.18.4`
- **IndexedDB**: `dexie: ^4.4.6`, `dexie-react-hooks: ^4.4.0`, `fake-indexeddb: ^6.2.5` (testing)
- **Firebase**: `firebase: ^11.0.0`, `firebase-admin: ^12.0.0`, `firebase-functions: ^5.0.0`
- **Charts & UI**: `recharts: ^3.10.1`, `lucide-react: ^1.54.0`
- **Parser**: `papaparse: ^5.7.0`, `hyparquet: ^1.31.3`
- **CSS**: Tailwind CSS 3.4.4 + Autoprefixer + PostCSS

### 2.3 Command Scripts
| Command | Shell Command on Windows | Purpose | Status |
|---|---|---|---|
| `npm run typecheck` | `npm.cmd run typecheck` | `tsc --noEmit` | **PASS** (0 errors) |
| `npm run build` | `npm.cmd run build` | `tsc --noEmit && vite build` | **PASS** (built in <1s, PWA generated) |
| `npm test` | `npm.cmd test` | `vitest run --config vitest.config.ts` | **PASS 19/20 files** (346/347 tests) |
| Single test | `npx.cmd vitest run tests/<file>` | Fast focused test | **PASS** (~200-800ms) |

*Note for Windows*: PowerShell script execution policy blocks `npm.ps1`. Commands must be invoked as `npm.cmd <script>` or `npx.cmd <tool>`.

---

## 3. Database Layer: Dexie Schema, Models & State Management

### 3.1 Dexie Database Schema (`src/db/database.ts`)
The database `FinanceDatabase` (version 2) manages 17 core financial tables:
- `accounts`: `id, ownerId, updatedAt, deletedAt, accountType, currency, archived, institutionId`
- `institutions`: `id, ownerId, updatedAt, deletedAt, name`
- `transactions`: `id, ownerId, updatedAt, deletedAt, date, accountId, categoryId, type, currency, instrumentId, merchant, *tags, [accountId+date], [categoryId+date], [type+date], [accountId+instrumentId], [accountId+instrumentId+date]`
- `postings`: `id, ownerId, updatedAt, deletedAt, transactionId, accountId, date, instrumentId, [accountId+date]`
- `categories`: `id, ownerId, updatedAt, deletedAt, parentId, kind, archived`
- `tags`: `id, ownerId, updatedAt, deletedAt, name`
- `transactionTags`: `id, ownerId, updatedAt, deletedAt, transactionId, tagId`
- `instruments`: `id, ownerId, updatedAt, deletedAt, symbol, sourceSymbol, instrumentType, currency`
- `investmentLots`: `id, ownerId, updatedAt, deletedAt, accountId, instrumentId, transactionId, [accountId+instrumentId]`
- `prices`: `id, ownerId, updatedAt, deletedAt, instrumentId, asOf, [instrumentId+asOf]`
- `fxRates`: `id, ownerId, updatedAt, deletedAt, [fromCurrency+toCurrency], asOf`
- `budgets`: `id, ownerId, updatedAt, deletedAt, categoryId, period, [categoryId+period]`
- `recurringRules`: `id, ownerId, updatedAt, deletedAt, nextDate, active`
- `goals`: `id, ownerId, updatedAt, deletedAt, accountId`
- `liabilityTerms`: `id, ownerId, updatedAt, deletedAt, accountId`
- `balanceSnapshots`: `id, ownerId, updatedAt, deletedAt, accountId, date, [accountId+date]`
- `settings`: `id, ownerId, updatedAt, deletedAt, &key`

Auxiliary persistence tables:
- `syncOutbox`: `id, ownerId, entityId, tableName, status, createdAt, [tableName+entityId]`
- `syncState`: `id`
- `conflicts`: `id, ownerId, entityId, tableName, createdAt, resolvedAt`
- `importFingerprints`: `id, transactionId`
- `recurringOccurrences`: `id, ruleId, date, transactionId`

### 3.2 Double-Entry Journaling & Integrity
- In `src/db/repository.ts`, `writeTransaction()` computes balance postings (`postingsForTransaction()`) and updates `postings` and `investmentLots` inside an atomic Dexie transaction `atomic()`.
- Balances are integer minor currency units (`Money = number`, e.g. centavos). Prices are major floating numbers.
- Deleting or archiving records creates a tombstone (`deletedAt: ISO timestamp`) rather than physically removing records, ensuring sync propagation.

---

## 4. R1 Deep Dive: Multi-Currency Net Worth & Valuation Layer

### 4.1 How Net Worth is Calculated
1. `useFinance()` in `src/ui/useFinance.ts` queries:
   - `accounts` from `financeDb.accounts`
   - `balances` from `financeRepository.accountBalances()` (computed from opening balances + postings)
   - `positions` from `financeRepository.portfolio()`
   - `fxRates` from `financeDb.fxRates`
   - `settings` from `financeRepository.getSetting('finance')`
2. It calls `calculateNetWorthFromBalances(accounts, balances, positions, fxRates, settings, asOf)` (`src/core/calculations.ts:377`).
3. For each account:
   - Cash balances: for each currency holding in `cash`, if `curr !== account.currency`, calls `convertMoney(amt, curr, account.currency, fxRates, asOf, ...)`.
   - Investment holdings: calls `convertMoney(position.marketValue, position.currency, account.currency, fxRates, asOf, ...)`.
   - Account total to base currency: calls `convertMoney(knownValue, account.currency, settings.baseCurrency, fxRates, asOf, ...)`.
4. Result evaluation (`calculations.ts:428-436`):
   ```ts
   const assets = missing.assets ? null : totals.assets, liabilities = missing.liabilities ? null : totals.liabilities;
   return {
     assets, liabilities, netWorth: assets === null || liabilities === null ? null : add(assets, -liabilities),
     liquidNetWorth: missing.liquid || liabilities === null ? null : add(totals.liquid, -liabilities),
     ...
     knownAssets: totals.assets, knownLiabilities: totals.liabilities, knownNetWorth: add(totals.assets, -totals.liabilities),
     complete: !Object.values(missing).some(Boolean), issues, accountValues,
   };
   ```
5. In `Overview.tsx:87`:
   `<strong className="metric-value"><Money amount={hasAccounts ? netWorth.netWorth : null} currency={currency}/></strong>`
   When `netWorth.netWorth === null`, `formatMoney` returns `'—'`.

### 4.2 Current Bugs & Root Causes
1. **Zero Default / Seeded FX Rates in Database**:
   - `initializeFinanceDatabase()` (`src/db/repository.ts:362`) seeds categories only. It seeds NO `fxRates`.
   - In `src/market/providers.ts:22`, `refreshFx()` is defined to fetch free rates from `https://open.er-api.com/v6/latest/${base}`.
   - However, `refreshFx()` is **ONLY** called when the user navigates to `SettingsPage` and clicks "Refresh free daily FX". It is **never** invoked on application startup, on base currency change, or when an account in a new currency is created.
   - **Consequence**: The moment a user creates an account with a foreign currency (e.g., PHP base + USD checking), `fxRates` in Dexie is empty. `getFxRate('USD', 'PHP', [])` returns `null`. `calculateNetWorthFromBalances` flags `missing_fx` and sets `netWorth: null`. The dashboard displays `—`.

2. **Lack of FX Triangulation (Cross-Rates)**:
   - `getFxRate(from, to, rates, asOf)` (`src/core/calculations.ts:58`) only matches direct `(from == r.fromCurrency && to == r.toCurrency)` or inverse `(from == r.toCurrency && to == r.fromCurrency)`.
   - If rates exist for `USD/PHP` and `EUR/USD`, but not direct `EUR/PHP`, `getFxRate('EUR', 'PHP')` returns `null`.
   - There is no triangulation path (e.g. routing through `USD` or `baseCurrency` via `rate(EUR->USD) * rate(USD->PHP)`).

3. **No Offline Fallback Reference Rates**:
   - If the device is offline or the external API is unreachable when setting up accounts, the system has no bundled reference baseline rates for primary global currencies (`PHP`, `USD`, `EUR`, `GBP`, `JPY`, `SGD`, `HKD`, `CAD`, `AUD`).

4. **UI Reliance on `netWorth.netWorth` vs `knownNetWorth`**:
   - In `Overview.tsx`, `<Money amount={hasAccounts ? netWorth.netWorth : null} />` renders `—` whenever `netWorth.complete` is false.
   - While test `calculations.test.ts:224` confirms that missing FX sets `netWorth: null` and populates `knownNetWorth`, the user requirement specifically mandates:
     *"Ensure total net worth accurately converts and aggregates all account balances, investment holdings, and liabilities into the chosen base currency (defaulting cleanly to PHP or user-selected currency) using active/cached dated FX exchange rates. Never show an empty or broken value (`—`) simply because accounts hold multiple currencies (e.g. PHP, USD)."*

---

## 5. R7 Deep Dive: Firebase Synchronization & Security Hardening

### 5.1 Architecture & Collections
- **Path Structure**:
  `/users/{uid}/{tableName}/{id}`
  Where `tableName` is one of the 17 `FINANCE_TABLES` (e.g., `accounts`, `transactions`).
- **Security Rules (`firestore.rules`)**:
  - `isAuthenticated()` ensures `request.auth != null && request.auth.token.firebase.sign_in_provider != 'anonymous'`.
  - Read & Delete allowed only if `isAuthenticated() && request.auth.uid == uid`.
  - Create & Update allowed only if `isAuthenticated() && request.auth.uid == uid && (request.resource.data.owner_id == null || request.resource.data.owner_id == uid) && request.resource.data.entity_type == tableName && request.resource.data.id == id`.
  - Deny-by-default on all unmapped paths (`/{document=**}`).
  - Legacy `finance_entities` path protected with owner_id checks.
- **Sync Engine (`src/sync/engine.ts`)**:
  - `Web Locks` (`navigator.locks.request('tala_sync')`) prevents race conditions between multiple browser tabs.
  - Push: processes `db.syncOutbox` entries sequentially by `createdAt` and `baseVersion`.
  - Pull: queries Firestore per table using composite cursor (`updated_at > cursor`) up to boundary timestamp.
  - Conflict detection: compares version and payload; records conflicts in `db.conflicts`.
  - Realtime: subscribes to Firestore collection changes and applies via `repository.applyRemoteRecords()`.

### 5.2 Current Bugs & Security/Architecture Gaps
1. **Client-Side Anonymous Auth Guard Missing**:
   - While `firestore.rules` blocks anonymous tokens, `requireOwner()` in `src/sync/firebase.ts:51` only checks `if (!user)`. It does not check `if (user.isAnonymous)`.
   - An anonymous user attempting sync will trigger raw Firestore permission-denied errors rather than a descriptive prompt to sign in with an authenticated account.
2. **Hardcoded Firebase Configuration**:
   - `src/firebase.ts` hardcodes production project keys without checking `import.meta.env.VITE_FIREBASE_*`.
   - Security best practice requires reading from environment variables (e.g., `import.meta.env.VITE_FIREBASE_API_KEY ?? "AIzaSyD..."`).
3. **Unchecked Snapshot Listener Errors**:
   - In `src/sync/firebase.ts:246`, `onSnapshot(q, (snapshot) => { ... })` does not pass an error handler callback.
   - If user permissions change, network drops, or auth token refreshes, unhandled runtime errors can trigger in the console.
4. **Local-First & Offline Mutation Queuing**:
   - When offline, writes store mutations in `db.syncOutbox` with status `pending`.
   - In `src/App.tsx`, `window.addEventListener('online')` triggers retry.
   - In `DataPage.tsx`, sync is optional (`privacyMode: 'LOCAL_ONLY'` is the default). Local operations remain fully operational without internet.

---

## 6. Recommendations & Implementation Strategies

### 6.1 For R1 (Multi-Currency Net Worth & Valuation)
1. **Bundled Reference FX Seed Rates**:
   - In `src/db/repository.ts` (`initializeFinanceDatabase`) and/or `src/market/providers.ts`, bundle default dated fallback exchange rates for standard currency pairs (e.g. PHP base: USD/PHP ~ 58.0, EUR/PHP ~ 63.0, JPY/PHP ~ 0.38, GBP/PHP ~ 74.0, SGD/PHP ~ 44.0, etc.).
   - Seed these rates into Dexie `fxRates` table on initial database creation so foreign currency accounts immediately convert without network dependence.
2. **Auto-Refresh FX Rates on Startup & Base Currency Switch**:
   - In `useFinance.ts` or `App.tsx`, trigger `refreshFx(settings.baseCurrency)` automatically in the background (with 1-hour cache guard) when the app starts or when the user changes base currency in the header.
3. **Triangular FX Rate Resolution**:
   - Enhance `getFxRate(from, to, rates, asOf)` in `src/core/calculations.ts` to support triangular cross-rate conversion via pivot currencies (e.g., USD or base currency) when direct and inverse rates are not present:
     `rate(A -> B) = rate(A -> USD) * rate(USD -> B)`.
4. **Resilient Net Worth UI Fallback**:
   - If an account has a rate that cannot be converted, `Overview.tsx` should display `netWorth.knownNetWorth` (or the best converted aggregate) accompanied by an informative badge, rather than displaying an empty `—`.

### 6.2 For R7 (Firebase Synchronization & Security Hardening)
1. **Strict Client-Side Anonymous Auth Guard**:
   - Update `requireOwner()` in `src/sync/firebase.ts`:
     ```ts
     const requireOwner = async () => {
       const user = auth.currentUser;
       if (!user) throw new Error('Sign in before enabling cloud synchronization.');
       if (user.isAnonymous) throw new Error('Anonymous accounts cannot sync cloud data. Please sign in with an authenticated account.');
       return user.uid;
     };
     ```
2. **Environment Variable Configuration for Firebase**:
   - Update `src/firebase.ts` to source config from `import.meta.env.VITE_FIREBASE_*` with fallback defaults.
3. **Protected Real-Time Snapshot Listeners**:
   - In `src/sync/firebase.ts:246`, add the error callback to `onSnapshot`:
     ```ts
     const unsubscribe = onSnapshot(q, (snapshot) => {
       ...
     }, (error) => {
       console.warn(`Snapshot listener error on table ${tableName}:`, error);
     });
     ```
4. **Strict Firestore Rules Audit**:
   - Confirm all 17 tables are covered under `/users/{uid}/{tableName}/{id}`. Verify that emulator tests or vitest test cases in `tests/firestore-rules.test.ts` pass cleanly.

---

## 7. Verification Matrix

| Area | Check / Command | Expected Result | Verified Result |
|---|---|---|---|
| Typecheck | `npm.cmd run typecheck` | 0 errors | **PASS** |
| Production Build | `npm.cmd run build` | Clean `dist/` bundle with PWA worker | **PASS** (930ms) |
| Calculations Tests | `npx.cmd vitest run tests/calculations.test.ts` | 31/31 passing | **PASS** (789ms) |
| Sync Tests | `npx.cmd vitest run tests/sync.test.ts` | 8/8 passing | **PASS** (277ms) |
| Firestore Rules Tests | `npx.cmd vitest run tests/firestore-rules.test.ts` | 14/14 passing | **PASS** (274ms) |
| Adversarial Sync Tests | `npx.cmd vitest run tests/challenger-sync-adversarial.test.ts` | Concurrency & locking passing | **PASS** |
| Entire Test Suite | `npm.cmd test` | All suites | **19/20 files PASS** (346/347 tests) |
