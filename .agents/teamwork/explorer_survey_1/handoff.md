# Handoff Report: Survey Explorer 1

- **Role**: Codebase & Core Architecture Explorer
- **Working Directory**: `e:/Visual Studio Code/tala/.agents/teamwork/explorer_survey_1/`
- **Date**: 2026-10-10
- **Type**: Hard Handoff (Investigation & Survey Complete)

---

## 1. Observation

1. **Build and Typecheck**:
   - Running `npm.cmd run typecheck` returned exit code 0 (`tsc --noEmit`).
   - Running `npm.cmd run build` returned exit code 0 (`tsc --noEmit && vite build`), generating `dist/` with PWA service worker in 930ms.
2. **Test Suite Status**:
   - Running `npm.cmd test` (`vitest run --config vitest.config.ts`) executed 20 test files and 347 tests: 19 test files passed (346 tests), 1 test file failed (1 test).
   - Verbatim failure:
     ```
     FAIL tests/monte-carlo.test.ts > Advanced FIRE Monte Carlo Simulation (R5) > Probability Density Function (PDF) of Depletion Years > yields zero depletion probability across all years for perpetual endowment
     AssertionError: expected 0.0002 to be +0 // Object.is equality
     - Expected
     + Received
     - 0
     + 0.0002
     at tests/monte-carlo.test.ts:260:22
     ```
   - Target tests for R1 and R7 pass cleanly:
     - `npx.cmd vitest run tests/calculations.test.ts`: 31 passed (789ms)
     - `npx.cmd vitest run tests/sync.test.ts`: 8 passed (277ms)
     - `npx.cmd vitest run tests/firestore-rules.test.ts`: 14 passed (274ms)
3. **Multi-Currency Net Worth Calculation (R1)**:
   - In `src/core/calculations.ts:377` (`calculateNetWorthFromBalances`), any account balance or position in a foreign currency without a conversion rate in `fxRates` appends `{ code: 'missing_fx' }`, sets `incomplete = true`, `baseValue = null`, and marks `missing.assets` or `missing.liabilities` as `true`.
   - Lines 428-430: `assets = missing.assets ? null : totals.assets`, `netWorth = assets === null || liabilities === null ? null : add(assets, -liabilities)`.
   - In `src/ui/shared.tsx:8`: `formatMoney(amount)` returns `'—'` when `amount` is null.
   - In `src/pages/Overview.tsx:87`: `<strong className="metric-value"><Money amount={hasAccounts ? netWorth.netWorth : null} currency={currency}/></strong>`.
   - In `src/db/repository.ts:362` (`initializeFinanceDatabase`), only `categories` are seeded. Zero FX rates are inserted.
   - In `src/market/providers.ts:22`, `refreshFx(base)` is implemented but is only called in `src/pages/PlanningPages.tsx:265` via manual button click ("Refresh free daily FX"). It is never invoked automatically on app load, base currency switch, or account creation.
   - In `src/core/calculations.ts:58`, `getFxRate(from, to, rates, asOf)` only matches direct or inverse rates; it lacks triangular cross-rate resolution (e.g. `EUR -> USD -> PHP`).
4. **Firebase Synchronization & Security (R7)**:
   - In `firestore.rules:6-21`, rules version 2 strictly requires non-anonymous authenticated users (`request.auth.token.firebase.sign_in_provider != 'anonymous'`) and isolates records to `/users/{uid}/{tableName}/{id}`.
   - In `src/sync/firebase.ts:51-55`:
     ```ts
     const requireOwner = async () => {
       const user = auth.currentUser;
       if (!user) throw new Error('Sign in before enabling cloud synchronization.');
       return user.uid;
     };
     ```
     Does not check `user.isAnonymous`.
   - In `src/firebase.ts:3-12`, Firebase SDK config keys are hardcoded without referencing `import.meta.env`.
   - In `src/sync/firebase.ts:246`, `onSnapshot(q, (snapshot) => { ... })` does not provide an error handler callback.

---

## 2. Logic Chain

1. **Step 1 (Observation 3)**: When a user creates accounts in multiple currencies (e.g., PHP and USD), the Dexie `fxRates` table starts completely empty because `initializeFinanceDatabase` never seeds FX rates and `refreshFx()` is only invoked manually in Settings.
2. **Step 2 (Observation 3)**: When `calculateNetWorthFromBalances` runs, `convertMoney(amt, 'USD', 'PHP', [])` calls `getFxRate('USD', 'PHP', [])`, which returns `null`.
3. **Step 3 (Observation 3)**: `convertMoney` returning `null` causes `calculateNetWorthFromBalances` to set `netWorth: null` and `complete: false`.
4. **Step 4 (Observation 3)**: `Overview.tsx` renders `<Money amount={netWorth.netWorth} />`. Because `netWorth.netWorth` is `null`, `formatMoney` returns `'—'`.
5. **Step 5 (Observations 3 & 4)**: Therefore, the root cause of the multi-currency Net Worth display bug is the absence of default/seeded FX rates, the lack of automatic FX refresh on startup/currency switch, and the absence of triangular cross-rate conversion.
6. **Step 6 (Observation 4)**: For R7, `firestore.rules` blocks anonymous tokens, but client-side `requireOwner()` does not validate `!user.isAnonymous`. Anonymous users encounter unhandled Firestore permission denials instead of clean client guidance.
7. **Step 7 (Observation 4)**: Hardcoded Firebase config prevents runtime key override, and missing snapshot listener error handlers expose the client to unhandled errors during auth/network transitions.

---

## 3. Caveats

- Investigation is strictly read-only; no application source code modifications were made.
- The 1 failing test in `tests/monte-carlo.test.ts:260` is related to R6 (FIRE Monte Carlo simulation stochastic boundary) and was noted for the respective specialist explorer/implementer.
- Live Firebase emulator or remote Firestore testing was not executed against live cloud endpoints during this turn; validation relied on unit tests and security rules analysis.

---

## 4. Conclusion

1. **R1 Multi-Currency Net Worth**:
   - Seed baseline FX rates in Dexie during initialization (`initializeFinanceDatabase`).
   - Trigger automatic background `refreshFx(settings.baseCurrency)` on app initialization and base currency changes.
   - Implement triangular rate routing in `getFxRate()` (`src/core/calculations.ts`) through USD or the active base currency.
   - Update `Overview.tsx` to resiliently display `netWorth.knownNetWorth` with a clear status indicator rather than a blank `—` if an exotic currency rate is missing.
2. **R7 Firebase Synchronization & Security**:
   - Add `if (user.isAnonymous) throw new Error(...)` to `requireOwner()` in `src/sync/firebase.ts`.
   - Update `src/firebase.ts` to source config from `import.meta.env.VITE_FIREBASE_*` with fallbacks.
   - Add error callbacks to `onSnapshot` listeners in `src/sync/firebase.ts`.
   - Ensure local mutations queue cleanly in `db.syncOutbox` during offline periods and retry on reconnect.

---

## 5. Verification Method

To verify these findings independently:
1. **Typecheck & Build**:
   - `npm.cmd run typecheck`
   - `npm.cmd run build`
2. **Calculations & Valuation**:
   - `npx.cmd vitest run tests/calculations.test.ts`
   - `npx.cmd vitest run tests/financial-integrity.test.ts`
3. **Sync & Rules**:
   - `npx.cmd vitest run tests/sync.test.ts`
   - `npx.cmd vitest run tests/firestore-rules.test.ts`
   - `npx.cmd vitest run tests/challenger-sync-adversarial.test.ts`
4. **Inspect Files**:
   - `src/core/calculations.ts` lines 58-81 (`getFxRate`, `convertMoney`) and 377-436 (`calculateNetWorthFromBalances`)
   - `src/market/providers.ts` lines 22-28 (`refreshFx`)
   - `src/db/repository.ts` lines 362-369 (`initializeFinanceDatabase`)
   - `src/sync/firebase.ts` lines 47-56 (`requireOwner`) and 239-266 (`subscribe`)
   - `firestore.rules` lines 1-38
