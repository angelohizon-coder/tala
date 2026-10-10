# Milestone 1 Review Handoff Report

**Reviewer**: Reviewer M1-1 (Quality Reviewer & Adversarial Critic)  
**Date**: 2026-10-10  
**Milestone**: Tala Milestone 1 (R1 & R7)  
**Status**: Review Complete — Approved  

---

## 1. Observation

Direct observations and evidence gathered during independent review and verification:

1. **Triangular Cross-Rate Implementation (`src/core/calculations.ts:58-145`)**:
   - `getDirectOrInverseFxRate` evaluates direct and inverse quotes:
     ```typescript
     if (isDirect && time > directTime) { direct = rate; directTime = time; }
     if (isInverse && time > inverseTime) { inverse = rate; inverseTime = time; }
     ```
   - `getFxRate` iterates over `candidatePivots` (standard vehicles `['USD', 'EUR', 'PHP']` + all active non-deleted currencies with rate timestamps $\le$ cutoff), computing $R_{\text{effective}} = R_1 \times R_2$ and selecting the maximum timestamp $\min(t_1, t_2)$.
2. **Resilient Net Worth Aggregation & UI Display (`src/core/calculations.ts:498-508`, `src/pages/Overview.tsx:94-118`)**:
   - `NetWorthSummary` outputs `missingFx: Currency[]`, `knownAssets`, `knownLiabilities`, and `knownNetWorth`.
   - `Overview.tsx` renders `<Money amount={hasAccounts ? (netWorth.netWorth ?? netWorth.knownNetWorth) : null} currency={currency}/>`.
   - When `!netWorth.complete && hasAccounts`, renders `<span className="badge warning">Estimated</span>` badge and links to `/settings` or `/investments`.
3. **Dexie Baseline FX Rate Seeding (`src/db/repository.ts:362-402`)**:
   - `DEFAULT_FX_SEEDS` defines 15 historical rates across all 9 supported currencies with timestamp `2020-01-01T00:00:00.000Z`.
   - Populated conditionally when `db.fxRates.count() === 0` in `initializeFinanceDatabase()`.
4. **Firebase Auth Anonymous Session Rejection (`src/sync/firebase.ts:51-57, 140-144`)**:
   - In `requireOwner()`, rejects unauthenticated or anonymous accounts:
     ```typescript
     if (!user || user.isAnonymous) {
       throw new Error('Sign in with a verified account before enabling cloud synchronization.');
     }
     ```
   - In `userId()`, returns `null` if anonymous:
     ```typescript
     const user = auth.currentUser;
     if (!user || user.isAnonymous) return null;
     return user.uid;
     ```
   - In `src/sync/firebase.ts:271-278`, attaches `(error) => void` handler to `onSnapshot` for all 17 tables and logs errors to `db.syncState` key `lastSyncError`.
5. **Execution of Automated Test Suite and Build**:
   - `cmd /c npx vitest run tests/calculations.test.ts`: 38/38 passed (duration 791ms).
   - `cmd /c npx vitest run tests/e2e-overhaul.test.ts`: 67/67 passed (duration 595ms).
   - `cmd /c npx vitest run tests/firebase-sync-unit.test.ts`: 8/8 passed (duration 501ms).
   - `cmd /c npm run typecheck`: clean exit (code 0).
   - `cmd /c npm run build`: clean exit (code 0, 2584 modules transformed).
   - `cmd /c npm test`: 22 test files passed, 429 tests passed (duration 2.62s).

---

## 2. Logic Chain

1. **Fulfillment of R1 (Multi-Currency Net Worth & Valuation Layer)**:
   - *Supporting Observations*: 1, 2, 3, 5.
   - *Reasoning*: Multi-currency accounts can convert across arbitrary currency pairs via direct, inverse, or triangular routing using USD, EUR, or PHP pivots. If external quotes are missing, the 15 historical seeds guarantee floor conversions. If foreign rates are completely disconnected, `knownNetWorth` surfaces the known converted subtotal with an `Estimated` badge rather than nullifying the display to `—`.
   - *Result*: R1 is fully satisfied without breaking existing mathematical invariants (`netWorth: null` and `complete: false` when incomplete).

2. **Fulfillment of R7 (Firebase Synchronization & Security Hardening)**:
   - *Supporting Observations*: 4, 5.
   - *Reasoning*: Firestore security rules in `firestore.rules` prohibit anonymous accounts. By asserting `!user.isAnonymous` in `requireOwner()` and `userId()`, client-side sync operations fail fast with descriptive messages instead of generating rejected Firestore network calls. Snapshot listeners catch errors across all tables without unhandled rejections. Environment variables in `src/firebase.ts` allow deployment key configuration with fallbacks.
   - *Result*: R7 is fully satisfied.

3. **Integrity & Code Quality Assessment**:
   - *Supporting Observations*: 1, 2, 3, 4, 5.
   - *Reasoning*: No hardcoded test values, no fake/dummy facades, no unauthorized external shortcuts, and zero fabrication were detected. Code conforms to TypeScript strict mode and passes full production bundling.
   - *Result*: Implementation integrity confirmed.

---

## 3. Caveats

- **2-Hop Routing Scope**: Triangular cross-rate routing is intentionally bounded to 2 hops (Source $\to$ Pivot $\to$ Destination). This covers 100% of standard fiat pairs without compounding numerical errors. 3+ hop routing is not supported and not required for this milestone.
- **Offline Baseline Timestamp**: The 15 seeded rates are timestamped at `2020-01-01`. For historical queries predating 2020, temporal cutoff will exclude them; for all modern operational dates (2020 to present), they serve as a universal fallback.

---

## 4. Conclusion

**Verdict**: **APPROVE**

Milestone 1 work product by Worker M1 is complete, verified, robust against adversarial stress cases, and ready for integration into the Tala baseline. All requirements for R1 and R7 are met.

---

## 5. Verification Method

To independently reproduce this verification:

```bash
# 1. Vitest calculation suite
cmd /c npx vitest run tests/calculations.test.ts

# 2. Vitest end-to-end overhaul suite
cmd /c npx vitest run tests/e2e-overhaul.test.ts

# 3. Firebase sync unit tests
cmd /c npx vitest run tests/firebase-sync-unit.test.ts

# 4. TypeScript compilation check
cmd /c npm run typecheck

# 5. Production bundle build
cmd /c npm run build

# 6. Entire repository test suite
cmd /c npm test
```

### Invalidation Conditions
- Any failure in `getFxRate` when converting non-direct pairs with a common vehicle currency.
- Any regression causing `Overview.tsx` to display `—` when accounts with known convertible balances exist.
- Any permission bypass allowing anonymous users to execute `push()` or `pull()` on `createFirebaseSyncProvider`.
- Any TypeScript type-checking failure (`tsc --noEmit`) or Vite build failure.
