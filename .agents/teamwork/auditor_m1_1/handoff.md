# Forensic Audit Handoff Report: Milestone 1

**Agent**: Forensic Auditor M1-1  
**Target**: Tala Milestone 1 (Core Currency, Valuation & Data Sync — R1 & R7)  
**Date**: 2026-10-10  
**Verdict**: CLEAN  

---

## 1. Observation

Direct observations and evidence gathered during the audit:

1. **Triangular Cross-Rate Routing Implementation**:
   - `src/core/calculations.ts:58-145`: Implements `getDirectOrInverseFxRate(from, to, rates, cutoff)` and candidate vehicle pivot evaluation across `STANDARD_PIVOT_CURRENCIES` (`USD`, `EUR`, `PHP`) plus all present `rateCurrencies`. Rates are filtered by `!rate.deletedAt && Number.isFinite(rate.rate) && rate.rate > 0 && time <= cutoff`. Effective observation time is `effectiveTime = Math.min(leg1.time, leg2.time)` and freshest pair is chosen.
2. **Resilient Net Worth Aggregation & UI Display**:
   - `src/core/calculations.ts:501-515`: Calculates `missingFx` as deduplicated unconvertible currency codes. `netWorth` remains `null` when missing FX exists to preserve calculation integrity.
   - `src/pages/Overview.tsx:94-112`: Displays `netWorth.netWorth ?? netWorth.knownNetWorth` with an `Estimated` badge (`<span className="badge warning">Estimated</span>`) and warning notice linking to `/settings` or `/investments`.
3. **Dexie Baseline FX Seeding**:
   - `src/db/repository.ts:362-402`: Defines `DEFAULT_FX_SEEDS` with 15 baseline rates across all 9 supported currencies (`PHP`, `USD`, `EUR`, `GBP`, `JPY`, `HKD`, `CAD`, `AUD`, `SGD`) stamped with historical floor timestamp `2020-01-01T00:00:00.000Z`. In `initializeFinanceDatabase`, seeds are inserted if `db.fxRates.count() === 0`.
4. **Firebase Security Hardening**:
   - `src/sync/firebase.ts:51-57`: `requireOwner()` checks `if (!user || user.isAnonymous) throw new Error('Sign in with a verified account before enabling cloud synchronization.');`.
   - `src/sync/firebase.ts:140-144`: `userId()` returns `null` if anonymous.
   - `src/firebase.ts:3-16`: Config reads `import.meta.env?.VITE_FIREBASE_*` with fallback defaults and exports `firebaseConfig`.
   - `src/sync/firebase.ts:267-275`: `onSnapshot` captures subscription errors across all 17 tables, records `lastSyncError` to `db.syncState`, and invokes `onError?.(error)`.
5. **Absence of Anti-Patterns**:
   - Static grep search across `src/` for test tokens, magic numbers, `NODE_ENV === 'test'`, or `VITEST` bypass branches returned 0 hits.
   - Workspace search for pre-existing `.log` or fake result files returned 0 hits.
6. **Command Execution Results**:
   - `cmd /c npm run typecheck`: exit code 0.
   - `cmd /c npm run build`: exit code 0 (2.00s build duration).
   - `cmd /c npx vitest run tests/calculations.test.ts`: 38 passed (38).
   - `cmd /c npx vitest run tests/firebase-sync-unit.test.ts`: 8 passed (8).
   - `cmd /c npx vitest run tests/challenger-financial-integrity.test.ts`: 21 passed (21).
   - `cmd /c npx vitest run tests/challenger-m1-adversarial.test.ts`: 22 passed (22).
   - `cmd /c npx vitest run tests/challenger-m1-2-adversarial.test.ts`: 20 passed (20).
   - `cmd /c npx vitest run tests/e2e-overhaul.test.ts`: 67 passed (67).
   - `cmd /c npm test`: 24 test files passed, 471 tests passed (0 failures).

---

## 2. Logic Chain

1. **Anti-Cheat Verification**:
   - *Observation References*: 1, 3, 4, 5.
   - *Reasoning*: The implementation code contains genuine algorithmic computation (2-hop graph routing, timestamp filtering, schema validation, Dexie storage, Firebase Auth checks). No output is hardcoded to satisfy specific test values.
   - *Deduction*: Passes Anti-Cheat and Facade Detection checks.

2. **Security & Protocol Alignment**:
   - *Observation References*: 4.
   - *Reasoning*: `firestore.rules:6-9` explicitly denies anonymous requests. By rejecting anonymous sessions in `requireOwner()` and returning `null` in `userId()`, client code prevents invalid Firestore transactions and eliminates silent permission errors.
   - *Deduction*: Firebase sync hardening is genuine and verified.

3. **Behavioral Correctness & Non-Regression**:
   - *Observation References*: 6.
   - *Reasoning*: All 24 test suites across the repository—including adversarial stress tests created independently by challengers—pass with zero errors. Type safety and production build compilation are intact.
   - *Deduction*: The work product meets all milestone criteria without regressions.

---

## 3. Caveats

- **Third-Party FX API Availability**: In production, `safeRefreshFx` connects to `https://open.er-api.com`. If network access is lost, conversions fall back to cached Dexie rates and the 15 baseline seeds without throwing unhandled exceptions.
- **2-Hop Routing Scope**: Triangular cross-rate routing intentionally caps path evaluation at 2 hops (Source $\to$ Pivot $\to$ Target). All standard fiat currencies in Tala route cleanly through USD, EUR, or PHP.

---

## 4. Conclusion

The work product delivered for Milestone 1 by Worker M1 is authentic, robust, and free of integrity violations or dummy facades. All requirements for R1 and R7 have been met and independently validated.

**Verdict: CLEAN**

---

## 5. Verification Method

To independently reproduce the audit results:

```bash
# 1. Typecheck
cmd /c npm run typecheck

# 2. Production Build
cmd /c npm run build

# 3. Core Calculations & Unit Tests
cmd /c npx vitest run tests/calculations.test.ts tests/firebase-sync-unit.test.ts

# 4. Independent Adversarial & Challenger Suites
cmd /c npx vitest run tests/challenger-financial-integrity.test.ts tests/challenger-m1-adversarial.test.ts tests/challenger-m1-2-adversarial.test.ts tests/e2e-overhaul.test.ts

# 5. Full Repository Test Suite
cmd /c npm test
```

### Invalidation Conditions
- Any occurrence of hardcoded test result strings or test environment bypasses in `src/`.
- Any regression where anonymous users can initiate Firestore writes without throwing.
- Any failure in `tsc --noEmit` or `npm test`.
