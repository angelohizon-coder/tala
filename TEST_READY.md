# E2E Test Suite Ready

## Test Runner
- Command: `npx vitest run tests/e2e-overhaul.test.ts`
- Full test suite: `npm test` (`vitest run --config vitest.config.ts`)
- Expected: all 21 test files (414+ tests) pass with exit code 0

## Coverage Summary
| Tier | Count | Description |
|------|------:|-------------|
| 1. Feature Coverage | 41 | Requirements R1 through R8 with >= 5 tests each |
| 2. Boundary & Corner Cases | 15 | Zero balances, extreme FX, micro crypto, negative values, leap days, safe integer limits, unquoted assets, rapid duplicates, cycle prevention |
| 3. Cross-Feature Combinations | 6 | Multi-currency investments + dividends, FIRE + multi-currency + inflation, offline outbox + expenses reconnect, budget tracking + multi-currency, debt amort + net worth reduction, custom account ordering |
| 4. Real-World Application Scenarios | 5 | OFW Expat multi-currency portfolio, Bi-weekly salary split & mortgage paydown, Market volatility & offline sync reconnection, 35-year Lean FIRE projection, 390px mobile touch workflow |
| **Total** | **67** | Comprehensive opaque-box and requirement-driven test cases in `tests/e2e-overhaul.test.ts` |

## Feature Checklist
| Feature | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---------|:------:|:------:|:------:|:------:|
| R1: Multi-Currency Net Worth & Valuation | 5 | 2 | ✓ | ✓ |
| R2: Market Data Reliability & Investments | 6 | 2 | ✓ | ✓ |
| R3: Financial Ledger: Expenses & Debts | 5 | 2 | ✓ | ✓ |
| R4: Accounts Reordering & Sorting | 5 | 2 | ✓ | ✓ |
| R5: Budget & Recurring Rules Redesign | 5 | 2 | ✓ | ✓ |
| R6: FIRE Journey Bug Fix & Simulation Stability | 5 | 2 | ✓ | ✓ |
| R7: Firebase Sync & Security Hardening | 5 | 2 | ✓ | ✓ |
| R8: Modern UI/UX, Footer & Mobile Responsiveness | 5 | 1 | ✓ | ✓ |
