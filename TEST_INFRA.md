# E2E Test Infra: Tala Personal Finance SPA Overhaul

## Test Philosophy
- Opaque-box, requirement-driven derived from `ORIGINAL_REQUEST.md` (R1-R8) and acceptance criteria.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial + Real-World Workload Testing.

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|---------|---------------------|:------:|:------:|:------:|
| 1 | Multi-Currency Net Worth Aggregation | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 2 | Market Quote Reliability & Fallbacks | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 3 | Investment Activities & NAV Tracking | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 4 | Dedicated Expenses vs Debt Amortization | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 5 | Accounts Drag-and-Drop & Sorting | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |
| 6 | Recurring Rules & Prompts | ORIGINAL_REQUEST §R5 | 5 | 5 | ✓ |
| 7 | Budgets Real-Time Alerts & Progress | ORIGINAL_REQUEST §R5 | 5 | 5 | ✓ |
| 8 | FIRE Journey Simulation & Multi-Currency | ORIGINAL_REQUEST §R6 | 5 | 5 | ✓ |
| 9 | Firebase Firestore Read/Write & Auth Guards | ORIGINAL_REQUEST §R7 | 5 | 5 | ✓ |
| 10 | Pinned Footer & Mobile Responsiveness | ORIGINAL_REQUEST §R8 | 5 | 5 | ✓ |

## Test Architecture
- Test runner: Vitest (`npx vitest run`) + Node acceptance runner (`node tools/finance-browser-check.mjs`)
- Unit and integration tests located under `tests/`
- Directory layout:
  - `tests/calculations.test.ts`
  - `tests/financial-integrity.test.ts`
  - `tests/market-gateway.test.ts`
  - `tests/monte-carlo.test.ts`
  - `tests/sync.test.ts`
  - `tests/firestore-rules.test.ts`
  - `tests/e2e-overhaul.test.ts` (new comprehensive suite)

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Multi-currency expat portfolio (USD investments + PHP cash + SGD liability) | F1, F2, F3, F4 | High |
| 2 | Bi-weekly salary with automated split into emergency fund and mortgage | F4, F6, F7 | Medium |
| 3 | Market volatility and offline sync reconnection with pending transactions | F2, F8, F9 | High |
| 4 | FIRE retirement projection with high custom inflation and mixed currency holdings | F1, F8 | High |
| 5 | Mobile 390px workflow: reordering accounts, creating recurring rule, logging expense | F4, F5, F6, F10 | Medium |

## Coverage Thresholds
- Tier 1: >= 5 per feature
- Tier 2: >= 5 per feature (boundary and corner cases)
- Tier 3: Pairwise coverage of major feature interactions
- Tier 4: >= 5 realistic application scenarios
