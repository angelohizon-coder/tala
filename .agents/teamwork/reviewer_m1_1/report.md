# Review Report: Milestone 1 (Core Currency, Valuation & Data Sync)

**Reviewer**: Reviewer M1-1 (Quality Reviewer & Adversarial Critic)  
**Target Milestone**: Milestone 1 (R1 & R7)  
**Date**: 2026-10-10  
**Verdict**: **APPROVE**  

---

## 1. Executive Summary

Milestone 1 addresses two fundamental pillars of the Tala application:
1. **R1: Multi-Currency Net Worth & Valuation Layer**: Multi-currency aggregation in Net Worth, triangular cross-rate routing, resilient fallback to known converted balances with an "Estimated" badge, and automatic seeding of 15 historical reference rates.
2. **R7: Firebase Synchronization & Security Hardening**: Strict rejection of anonymous Firebase Auth sessions matching `firestore.rules`, environment variable configuration fallback, and resilient snapshot subscription error handlers across all 17 database tables.

The implementation was independently reviewed and subjected to rigorous adversarial stress testing. All core algorithms, mathematical conversions, database seeding hooks, and authentication guards operate correctly and conform strictly to specifications.

---

## 2. Independent Verification & Test Execution

All verification commands specified in the dispatch were independently run from a clean terminal session:

| Command | Status | Result Details |
|---|---|---|
| `cmd /c npx vitest run tests/calculations.test.ts` | **PASS** | 38 passed / 38 tests (791ms) |
| `cmd /c npx vitest run tests/e2e-overhaul.test.ts` | **PASS** | 67 passed / 67 tests (595ms) |
| `cmd /c npx vitest run tests/firebase-sync-unit.test.ts` | **PASS** | 8 passed / 8 tests (501ms) |
| `cmd /c npm run typecheck` (`tsc --noEmit`) | **PASS** | Exit code 0, clean type check without warnings |
| `cmd /c npm run build` (`vite build`) | **PASS** | Exit code 0, 2584 modules transformed, client bundle + PWA SW generated |
| `cmd /c npm test` (Full Repository Suite) | **PASS** | 22 test files passed / 429 tests passed (2.62s) |

---

## 3. Review Dimensions

### 3.1 Correctness & Implementation Fidelity
- **Triangular Cross-Rate Routing (`src/core/calculations.ts:58-145`)**:
  - Decouples single-hop evaluation via `getDirectOrInverseFxRate` from multi-hop evaluation.
  - Implements 2-hop graph routing across candidate pivots (`USD`, `EUR`, `PHP`, and active rate currencies).
  - Evaluates both direct and inverted rates for each hop ($R_{\text{effective}} = R_1 \times R_2$).
  - Evaluates temporal cutoff dates ($T \le T_{\text{cutoff}}$) on both legs, setting pair freshness to $\min(t_1, t_2)$.
  - Prioritizes direct single-hop rates before triangular routing.
- **Resilient Net Worth Display (`src/pages/Overview.tsx:94-118`, `src/core/calculations.ts:498-508`)**:
  - When all accounts are convertible, renders complete `netWorth.netWorth`.
  - When foreign quotes are missing, preserves `netWorth: null` and `complete: false` (upholding invariant checks) while surfacing `knownNetWorth` (sum of convertible assets minus liabilities).
  - In `Overview.tsx`, renders `netWorth.netWorth ?? netWorth.knownNetWorth` with an `Estimated` badge and contextual notice pointing users to `/settings` or `/investments`.
  - Never displays `—` for accounts with valid balances.
- **Database Seeding (`src/db/repository.ts:362-402`)**:
  - `DEFAULT_FX_SEEDS` provides 15 baseline exchange rates covering all 9 supported currencies (`PHP`, `USD`, `EUR`, `GBP`, `JPY`, `HKD`, `CAD`, `AUD`, `SGD`) anchored at `2020-01-01T00:00:00.000Z`.
  - Seeding checks `if ((await db.fxRates.count()) === 0)`, ensuring existing or user-provided rates are never overwritten.
- **Firebase Auth Security Guard (`src/sync/firebase.ts:51-57, 140-144`)**:
  - `requireOwner()` explicitly verifies `!user || user.isAnonymous`, throwing `'Sign in with a verified account before enabling cloud synchronization.'`.
  - `userId()` returns `null` when anonymous.
  - Aligns client behavior with `firestore.rules` which rejects anonymous tokens.
- **Snapshot Listener Resilience (`src/sync/firebase.ts:243-279`)**:
  - Attaches `(error) => void` callbacks to `onSnapshot` queries for all 17 tables, preventing uncaught listener drops and recording diagnostic messages in `db.syncState` under `lastSyncError`.

### 3.2 Integrity Audit
We actively inspected the codebase for all prohibited patterns:
- **Hardcoded test expectations**: None found. Routing and valuations use general mathematical expressions and dynamic rate traversal.
- **Dummy/Facade implementations**: None found. Real Dexie tables, real Firebase queries, real triangular calculation graph.
- **Shortcuts or task bypasses**: None found.
- **Fabricated verification artifacts**: None found. All test runs were executed and verified independently.
- **Self-certifying work**: All worker claims were reproduced and verified against actual outputs.

---

## 4. Adversarial Stress-Testing & Failure Mode Analysis

| Challenge / Stress Scenario | Potential Failure Mode | Code Defense & Verification | Result |
|---|---|---|---|
| **1. Cyclic FX Rate Dependencies** (e.g. A $\to$ B and B $\to$ A in rates) | Infinite recursion or stack overflow in routing | `getDirectOrInverseFxRate` evaluates single hops without recursion. Candidate pivots strictly exclude source and destination (`pivot !== from && pivot !== to`). | **ROBUST** |
| **2. Zero, Negative, or NaN FX Rates** | Division by zero or NaN propagation in net worth | `rate.deletedAt \|\| !Number.isFinite(rate.rate) \|\| rate.rate <= 0` check filters invalid rates in both single-hop and pivot discovery. | **ROBUST** |
| **3. Temporal Cutoff Leakage** (newer rate exists in future relative to `asOf`) | Future exchange rate accidentally leaks into historical net worth snapshot | `time > cutoff` check is enforced on both Leg 1 and Leg 2. Effective time is $\min(t_1, t_2)$. Future quotes are completely ignored. | **ROBUST** |
| **4. Competing Intermediate Pivots** (both USD and EUR connect source and destination) | Arbitrary or non-deterministic rate selection | Effective timestamp $\min(t_1, t_2)$ is maximized across candidates. If timestamps are tied, standard vehicles (`USD`, `EUR`, `PHP`) take deterministic priority. | **ROBUST** |
| **5. Network Disconnect during FX Refresh** | Uncaught Promise rejection or application freeze | `safeRefreshFx` encapsulates network calls in `try/catch` returning `{ ok: false, error }`. Callers in `App.tsx` and `Overview.tsx` attach `.catch(() => {})`. App falls back to Dexie cache/seeds smoothly. | **ROBUST** |
| **6. Negative Cash Balances (Overdrafts/Liabilities)** | Sign inversion or math corruption in multi-currency conversion | `convertMoney` applies `rounded(amount / sourceScale * rate * destinationScale)` with `Math.sign(value)`, preserving negative signs. Liabilities are aggregated cleanly. | **ROBUST** |
| **7. Multiple Rapid Currency Select Changes** | Race condition or snapshot spamming | Snapshot recording uses deterministic ID `snapshot:${today()}:${settings.baseCurrency}` with equality checks against existing snapshots before saving. | **ROBUST** |
| **8. Anonymous User Sync Exploitation** | Silent `PERMISSION_DENIED` errors or corrupted sync state | `requireOwner()` and `userId()` reject anonymous users at the client boundary, throwing clear actionable error messages. | **ROBUST** |

---

## 5. Non-Blocking Recommendations for Future Milestones

1. **Missing FX UI Tooltip**: In `Overview.tsx`, the `Estimated` badge currently has a generic tooltip. In Milestone 8 (UI polish), this can be enhanced to list the specific currencies needing rates (from `netWorth.missingFx.join(', ')`).
2. **Multi-Hop (> 2 legs) Routing**: As noted in caveats, 2-hop covers fiat currencies via USD, EUR, or PHP. If exotic or custom crypto assets are introduced in future iterations, a general shortest-path algorithm (e.g. Dijkstra) can be considered.

---

## 6. Review Verdict

**APPROVE**

Milestone 1 satisfies all core criteria for R1 and R7, introduces robust currency routing and resilient net worth valuation, hardens Firebase synchronization against anonymous abuse, maintains full backwards compatibility, and passes 100% of the project test suite.
