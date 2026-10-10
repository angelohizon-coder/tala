# Adversarial Challenge Report: Triangular FX & Financial Calculations (M1-1)

**Challenger**: Challenger M1-1  
**Target Milestone**: Milestone 1 (Tala Multi-currency, FX, Net Worth)  
**Date**: 2026-10-10  
**Overall Verdict**: **APPROVE**  
**Risk Assessment**: LOW  

---

## 1. Challenge Summary

We performed empirical adversarial stress testing on the triangular FX cross-rate routing engine and multi-currency net worth valuation layer in `src/core/calculations.ts` and UI integration in `src/pages/Overview.tsx`.

We tested 4 core risk vectors across 22 adversarial scenarios in `tests/challenger-m1-adversarial.test.ts`, plus verified baseline and regression tests across `tests/calculations.test.ts` (38 tests) and `tests/challenger-financial-integrity.test.ts` (21 tests).

### Overall Risk Assessment: LOW
The mathematical implementation is robust, adheres strictly to financial invariants, avoids recursion traps, handles temporal cutoffs down to 1-millisecond resolution, rejects invalid/corrupt rates, and isolates unconvertible foreign balances without 1:1 fallback leaks.

---

## 2. Adversarial Challenges & Hypotheses

### Challenge 1 (Low Risk): Extreme Rates & Precision Limits
- **Assumption Challenged**: Multi-currency conversion maintains numerical stability and rejects overflow when given extreme rates ($10^{-9}$, $10^9$) or cross-leg products.
- **Attack Scenario**:
  1. Input rate $10^{-9}$ on Leg 1 and $10^9$ on Leg 2.
  2. Input rate $10^{-5}$ on Leg 1 and $10^{-4}$ on Leg 2 ($10^{-9}$ product).
  3. Input rate $10^8$ on Leg 1 and $10^8$ on Leg 2 ($10^{16}$ product) on large balances exceeding `MAX_SAFE_INTEGER`.
  4. Input 0, negative rates, NaN, and Infinity into triangular legs.
- **Observed Behavior**:
  - Exact cross-leg cancellation ($10^{-9} \times 10^9 = 1.0$) passed with `100.00 ABC` converting cleanly to `100.00 XYZ`.
  - Tiny rate product ($10^{-9}$) rounded cleanly to 0 minor units without subnormal corruption or crash.
  - Overflow past `Number.MAX_SAFE_INTEGER` was caught by `minor()` and threw `FinanceValidationError` as expected.
  - Non-positive and non-finite rates were discarded by `!Number.isFinite(rate.rate) || rate.rate <= 0`.
- **Verdict**: PASS.

### Challenge 2 (Low Risk): Circular Currency Topologies
- **Assumption Challenged**: Circular rate dependencies ($A \to B \to C \to A$) might trigger infinite loops, stack overflow, or non-deterministic selection.
- **Attack Scenario**:
  1. Construct cyclic topology: AUD $\to$ EUR = 0.6, EUR $\to$ JPY = 160, JPY $\to$ AUD = 1/96.
  2. Query AUD $\to$ JPY, JPY $\to$ EUR, and identity AUD $\to$ AUD.
  3. Query currency pairs with opposing quotes having different timestamps.
  4. Query currency pairs with direct and inverse quotes sharing the exact same timestamp.
- **Observed Behavior**:
  - No recursion exists: `getDirectOrInverseFxRate` is strictly 1-hop, and `getFxRate` is strictly 2-hop over candidate pivots. Loops cannot cause infinite recursion.
  - Freshest observation timestamp wins across opposing quotes.
  - Same-timestamp tie-breaker deterministically selects the direct rate.
- **Verdict**: PASS.

### Challenge 3 (Low Risk): Missing Pivot Legs & Fallback Routing
- **Assumption Challenged**: System gracefully fails or finds alternative vehicles when candidate pivot legs are missing, deleted, or expired.
- **Attack Scenario**:
  1. Pivot where Leg 1 exists but Leg 2 is missing.
  2. Pivot where Leg 2 exists but Leg 1 is missing.
  3. Candidate USD pivot has a leg marked `deletedAt`, while EUR pivot has both active legs.
  4. Competing valid candidate pivots with differing timestamps.
- **Observed Behavior**:
  - Missing legs return `null` immediately.
  - Deleted leg in USD pivot correctly triggers fallback to EUR pivot ($1.05 \times 60.0 = 63.0$).
  - Effective timestamp ($\min(t_1, t_2)$) correctly selects the freshest pivot pair.
- **Verdict**: PASS.

### Challenge 4 (Low Risk): Millisecond Temporal Boundary Conditions
- **Assumption Challenged**: Cutoff temporal boundary ($T_{\text{cutoff}} = \text{YYYY-MM-DDT23:59:59.999Z}$) must include rates on the cutoff and exclude rates 1ms after cutoff.
- **Attack Scenario**:
  1. Direct rate timestamped exactly at `23:59:59.999Z`.
  2. Direct rate timestamped at `00:00:00.000Z` the next day (+1ms).
  3. Triangular routing where Leg 1 is on cutoff, Leg 2 is 1ms post-cutoff.
  4. Triangular routing where Leg 1 is 1ms post-cutoff, Leg 2 is on cutoff.
  5. Triangular routing where both legs are on cutoff.
- **Observed Behavior**:
  - Rate on cutoff is accepted; rate 1ms post-cutoff is rejected.
  - If either leg of a triangular route is 1ms post-cutoff, the route fails (`null`).
  - When both legs are on cutoff, the triangular rate succeeds.
- **Verdict**: PASS.

### Challenge 5 (Low Risk): Multi-Currency Net Worth Aggregation
- **Assumption Challenged**: Net worth calculation handles all-foreign portfolios, mixed positive/negative balances, overdrawn foreign accounts, and foreign liabilities without 1:1 fallback.
- **Attack Scenario**:
  1. All balances foreign (USD, EUR, JPY) converting to PHP: all rates available.
  2. All balances foreign: 1 rate missing (GBP).
  3. All balances foreign: all rates missing.
  4. Mixed positive USD asset, overdrawn USD asset (-$1,000), and USD credit card liability ($4,000).
  5. Foreign credit card liability with missing FX rate.
  6. Account holding foreign cash sub-balances converted via triangular FX.
- **Observed Behavior**:
  - All rates present: full net worth calculates correctly to 12,357,333 centavos.
  - One rate missing: `netWorth: null`, `complete: false`, `knownNetWorth` preserves convertible balances, `missingFx: ['GBP']`.
  - All rates missing: `netWorth: null`, `complete: false`, `knownNetWorth: 0`, all unpriced currencies in `missingFx`.
  - Mixed positive/negative: Assets = 50,400,000 centavos, Liabilities = 22,400,000 centavos, Net worth = 28,000,000 centavos.
  - Foreign liability missing rate: `liabilities: null`, `netWorth: null`, `knownLiabilities: 0`, `knownNetWorth: 1,000,000`.
- **Verdict**: PASS.

---

## 3. Stress Test Results Summary

| Test Case | Description | Expected | Actual | Status |
|---|---|---|---|---|
| 1.1 | Tiny (1e-9) and large (1e9) cross-rate cancellation | Rate 1.0, 10000 minor units | 1.0, 10000 minor units | PASS |
| 1.2 | Tiny rate product (1e-9) rounding | Rate 1e-9, rounds to 0 | 1e-9, rounds to 0 | PASS |
| 1.3 | Overflow beyond MAX_SAFE_INTEGER | Throws FinanceValidationError | Throws FinanceValidationError | PASS |
| 1.4 | Corrupt / non-finite rate rejection | Returns null | Returns null | PASS |
| 2.1 | 3-way circular loop resolution | AUD->JPY: 96, JPY->EUR: 1/160 | 96, 1/160 | PASS |
| 2.2 | Opposing quotes with different timestamps | Selects fresher inverse rate | Selects fresher inverse rate | PASS |
| 2.3 | Same timestamp tie-breaking | Prefers direct rate | Prefers direct rate | PASS |
| 3.1 | Missing Leg 2 in candidate pivot | Returns null | Returns null | PASS |
| 3.2 | Missing Leg 1 in candidate pivot | Returns null | Returns null | PASS |
| 3.3 | Deleted pivot leg fallback | Uses EUR pivot (63.0) | Uses EUR pivot (63.0) | PASS |
| 3.4 | Freshest effective observation time | Selects EUR pivot over USD | Selects EUR pivot over USD | PASS |
| 4.1 | Rate exactly on cutoff (23:59:59.999Z) | Rate 55.5 accepted | Rate 55.5 accepted | PASS |
| 4.2 | Rate 1ms post-cutoff (00:00:00.000Z next day) | Excluded, past rate 50.0 used | Past rate 50.0 used | PASS |
| 4.3 | Triangular: Leg 1 valid, Leg 2 1ms post-cutoff | Returns null | Returns null | PASS |
| 4.4 | Triangular: Leg 1 1ms post-cutoff, Leg 2 valid | Returns null | Returns null | PASS |
| 4.5 | Triangular: Both legs on cutoff | Succeeds (60.48) | Succeeds (60.48) | PASS |
| 5.1 | All-foreign balances (USD, EUR, JPY) to PHP | 12,357,333 centavos, complete | 12,357,333 centavos, complete | PASS |
| 5.2 | All-foreign balances, 1 missing rate (GBP) | netWorth: null, known: 8624000, missingFx: ['GBP'] | Matches expected | PASS |
| 5.3 | All-foreign balances, all rates missing | netWorth: null, known: 0, missingFx: ['USD', 'EUR'] | Matches expected | PASS |
| 5.4 | Mixed positive/negative foreign balances | Net worth: 28,000,000 centavos | 28,000,000 centavos | PASS |
| 5.5 | Foreign liability with missing rate | liabilities: null, netWorth: null, knownLiab: 0 | Matches expected | PASS |
| 5.6 | Multi-currency cash sub-balances via triangular FX | 6,209,600 centavos | 6,209,600 centavos | PASS |

---

## 4. Unchallenged Areas

- **3+ Hop FX Routing**: Intentionally out of scope. In accordance with financial design and worker handoff caveats, multi-hop routing is limited to 2 hops (Source $\to$ Pivot $\to$ Destination), which covers all supported fiat currencies via standard vehicles (`USD`, `EUR`, `PHP`).
- **Firebase Auth / Sync Outbox**: Assigned to Challenger M1-2. Note that Challenger M1-2's test file (`tests/challenger-m1-2-adversarial.test.ts`) currently has 3 test assertions under active development.

---

## 5. Final Recommendation

**Verdict**: **APPROVE**  
The core currency conversion, triangular cross-rate routing, and multi-currency valuation aggregation meet all requirements of R1 with zero regressions.
