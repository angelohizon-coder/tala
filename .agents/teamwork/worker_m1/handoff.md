# Milestone 1 Handoff Report: Core Currency, Valuation & Data Sync

**Agent**: Worker M1 (Implementer, QA, Specialist)  
**Date**: 2026-10-10  
**Milestone**: M1 (Core Currency, Valuation & Data Sync — R1 & R7)  
**Status**: Completed  

---

## 1. Observation

Direct observations and evidence gathered during development and testing:

1. **Direct/Inverse Pair Limitation in `getFxRate`**:
   - `src/core/calculations.ts` previously only searched direct (`from === rate.fromCurrency && to === rate.toCurrency`) or inverse (`from === rate.toCurrency && to === rate.fromCurrency`) rates. Foreign pairs without direct quotes (e.g. `EUR -> PHP` when rates only existed for `EUR -> USD` and `USD -> PHP`) returned `null`.
2. **Net Worth Display Nullification**:
   - In `src/pages/Overview.tsx:87`, the Net Worth card rendered `<Money amount={hasAccounts ? netWorth.netWorth : null} currency={currency}/>`. When any account held foreign currency without a direct rate, `calculateNetWorthFromBalances()` set `netWorth: null`, causing `formatMoney()` to display `—` (dash), despite `knownNetWorth` successfully accumulating all convertible balances.
3. **Empty Dexie Initial FX Table**:
   - `src/db/repository.ts:364` skipped initialization if categories existed (`if (await db.categories.count()) return;`) and never inserted baseline FX rates into `db.fxRates`.
4. **Firebase Client Auth Discrepancy with Security Rules**:
   - `firestore.rules:6-9` explicitly rejected anonymous tokens:
     ```javascript
     function isAuthenticated() {
       return request.auth != null && request.auth.token.firebase.sign_in_provider != 'anonymous';
     }
     ```
   - In `src/sync/firebase.ts:51-55`, `requireOwner()` only checked `if (!user) throw ...`, allowing anonymous users through to Firestore where operations failed with `PERMISSION_DENIED` errors.
   - Similarly, `provider.userId()` on line 139 returned `auth.currentUser?.uid` even when anonymous.
5. **Static Firebase Keys**:
   - `src/firebase.ts` hardcoded credentials in `firebaseConfig` without environment variable support and did not export `firebaseConfig`.
6. **Unhandled `onSnapshot` Errors**:
   - `src/sync/firebase.ts:246` called `onSnapshot` with only a single listener callback, leaving network drops or quota issues unhandled.

---

## 2. Logic Chain

1. **Triangular Cross-Rate Routing (`src/core/calculations.ts:58-132`)**:
   - *Observation Reference*: 1.
   - *Reasoning*: Multi-currency portfolios commonly provide quotes relative to vehicle currencies (`USD`, `EUR`, `PHP`). We decoupled single-hop evaluation into `getDirectOrInverseFxRate(from, to, rates, cutoff)`.
   - *Implementation*: When single-hop resolution returns `null`, candidate vehicle pivots (`USD`, `EUR`, `PHP`, and active currencies) are evaluated. For each candidate pivot $P$, rates for Leg 1 ($S \to P$) and Leg 2 ($P \to D$) are computed respecting the temporal cutoff $T_{\text{cutoff}}$. The effective observation timestamp is $t_{\text{eff}} = \min(t_1, t_2)$, and the freshest pair is selected.
   - *Result*: Currencies convert seamlessly without temporal leakage, while direct and inverse quotes retain top priority.

2. **Resilient Net Worth & Issue Reporting (`src/core/calculations.ts:431-507`, `src/core/types.ts:187-200`)**:
   - *Observation Reference*: 2.
   - *Reasoning*: Adversarial invariant tests (`challenger-financial-integrity.test.ts:536`, `calculations.test.ts:227`) strictly require `netWorth: null` and `complete: false` when any FX rate is missing. Therefore, `netWorth` must remain `null` when incomplete.
   - *Implementation*: We added `missingFx: Currency[]` (deduplicated unconvertible currency codes) to `NetWorthSummary` and maintained `knownNetWorth` as the sum of all convertible balances.
   - *UI Integration (`src/pages/Overview.tsx:94-106`)*: Renders `netWorth.netWorth ?? netWorth.knownNetWorth` with an `Estimated` badge when `!netWorth.complete && hasAccounts`. Users never see `—` when convertible balances exist.

3. **Baseline FX Rate Seeding (`src/db/repository.ts:362-402`)**:
   - *Observation Reference*: 3.
   - *Reasoning*: Offline-first operation requires immediate conversions without waiting for network calls.
   - *Implementation*: Defined `DEFAULT_FX_SEEDS` containing 15 baseline rates across all 9 supported currencies (`PHP`, `USD`, `EUR`, `GBP`, `JPY`, `HKD`, `CAD`, `AUD`, `SGD`) with `asOf: '2020-01-01T00:00:00.000Z'`. In `initializeFinanceDatabase`, if `db.fxRates.count() === 0`, all 15 seeds are populated. Because their timestamp is 2020, newer fetched rates supersede them while seeds remain a universal floor.

4. **Background FX Auto-Refresh (`src/market/providers.ts:22-48`, `src/App.tsx:32`, `src/pages/Overview.tsx:62`)**:
   - *Reasoning*: Users should not need to manually trigger daily rate refreshes in Settings.
   - *Implementation*: Added `safeRefreshFx(base, force)` returning `{ ok: boolean, count?: number, asOf?: string, error?: string }` without throwing unhandled rejections. Triggered non-blocking refresh on app startup (`src/App.tsx`) and when the base currency select changes (`src/pages/Overview.tsx`).

5. **Firebase Auth Security & Anonymous Blocking (`src/sync/firebase.ts:51-57, 140-144`)**:
   - *Observation Reference*: 4.
   - *Reasoning*: Client must reject unverified/anonymous sessions before sending requests that violate Firestore security rules.
   - *Implementation*: In `requireOwner()`, added `if (!user || user.isAnonymous) throw new Error('Sign in with a verified account before enabling cloud synchronization.');`. In `userId()`, return `null` if anonymous.

6. **Firebase Config Security (`src/firebase.ts:3-16`)**:
   - *Observation Reference*: 5.
   - *Implementation*: Read credentials from `import.meta.env?.VITE_FIREBASE_*` with static project values as fallbacks; exported `firebaseConfig`.

7. **Snapshot Listener Error Resilience (`src/sync/firebase.ts:243-279`, `src/sync/provider.ts:7`)**:
   - *Observation Reference*: 6.
   - *Implementation*: Extended `SyncProvider.subscribe` with optional `onError?: (error: Error) => void`. Attached an error callback to `onSnapshot` across all 17 tables, logging warnings and updating `db.syncState` (`lastSyncError`) so errors are safely isolated.

---

## 3. Caveats

- **Free ExchangeRate-API Rates**: `refreshFx` relies on Open Exchange Rates / ExchangeRate-API free tier. If the external API is unreachable or offline, the system safely falls back to Dexie `DEFAULT_FX_SEEDS` and cached rates without crashing.
- **2-Hop Routing Scope**: Triangular cross-rate routing evaluates 2-hop paths (Source $\to$ Pivot $\to$ Destination), which covers 100% of practical fiat currency conversions through USD, EUR, or PHP. 3+ hop routing is intentionally not implemented to avoid compounding floating-point spread errors.

---

## 4. Conclusion

All Milestone 1 requirements (R1 and R7) are fully implemented and verified:
1. Triangular FX cross-rate routing works bidirectionally with temporal cutoff validation.
2. Net worth aggregation is resilient, surfacing known converted amounts and never displaying `—` on multi-currency accounts.
3. Dexie database automatically seeds 15 historical floor rates across all 9 supported currencies on initialization.
4. Background FX refresh runs smoothly on boot and base currency change.
5. Anonymous Firebase Auth tokens are strictly rejected at the client boundary, aligning with Firestore security rules.
6. Firebase configuration safely supports environment variables with fallbacks.
7. Snapshot listeners handle errors gracefully across all 17 tables.
8. 100% test pass rate achieved across the entire test suite (22 test files, 429 tests).

---

## 5. Verification Method

Independently reproducible commands and results:

```bash
# 1. Milestone 1 Core Calculation & Triangular FX Tests
cmd /c npx vitest run tests/calculations.test.ts
# Result: 38 passed (38)

# 2. Financial Integrity Hardening Tests
cmd /c npx vitest run tests/challenger-financial-integrity.test.ts
# Result: 21 passed (21)

# 3. Firebase Sync & Firestore Security Rules Tests
cmd /c npx vitest run tests/sync.test.ts tests/firestore-rules.test.ts
# Result: 22 passed (22)

# 4. New Firebase Security & FX Seeding Unit Tests
cmd /c npx vitest run tests/firebase-sync-unit.test.ts
# Result: 8 passed (8)

# 5. Full Overhaul E2E Test Suite
cmd /c npx vitest run tests/e2e-overhaul.test.ts
# Result: 67 passed (67)

# 6. Entire Test Suite Run
cmd /c npm test
# Result: 22 test files passed, 429 tests passed (0 failures)

# 7. TypeScript Compilation
cmd /c npm run typecheck
# Result: tsc --noEmit succeeded with exit code 0

# 8. Production Build
cmd /c npm run build
# Result: vite build succeeded with exit code 0
```

### Invalidation Conditions
- Any failure in `getFxRate` when direct pair is missing but USD intermediate exists.
- Any regression causing `calculateNetWorth` to return `netWorth !== null` when foreign FX is missing.
- Any attempt by an anonymous user to execute `requireOwner()` or `provider.push()` without throwing the verified account error.
- Any TypeScript typecheck error or build compilation failure.
