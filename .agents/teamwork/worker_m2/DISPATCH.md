## 2026-10-09T19:15:39Z
You are Worker 2 (teamwork_preview_worker) for Milestone M2 (Multi-Currency Data Modeling & Financial Core) of the Tala financial SPA modernization project.
Your working directory is: e:\Visual Studio Code\tala\.agents\teamwork\worker_m2
The project root is: e:\Visual Studio Code\tala
Authoritative user request and requirements: e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md
Project plan and contracts: e:\Visual Studio Code\tala\PROJECT.md
Explorer 2 Survey Report: e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_2\survey_report.md
Explorer 2 Handoff: e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_2\handoff.md
Parent conversation ID: 64bc598d-7c84-4fe3-b439-553f079769f4

You must read `e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md`, `e:\Visual Studio Code\tala\PROJECT.md`, and `e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_2\survey_report.md` before starting work.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Exclusive file ownership for Milestone M2:
- src/core/calculations.ts
- src/core/types.ts
- src/core/valuation.ts (if needed)
- src/db/repository.ts
- src/pages/LedgerPages.tsx
- tests/calculations.test.ts
- tests/repository.test.ts
- tests/backup.test.ts
- tests/financial-integrity.test.ts (or multi-currency test suites)

Tasks to implement:
1. Multi-Currency Sub-Ledgers (R2):
   - Model accounts with sub-ledgers for multiple fiat currencies (e.g. PHP, USD, EUR) simultaneously using `Record<Currency, Money>`.
   - In `src/core/calculations.ts`:
     - Line 90 & `accountMap`: handle `account.openingBalances` safely (e.g. `const opening = account.openingBalances ? (account.openingBalances[account.currency] ?? 0) : minor(account.openingBalance ?? 0, 'Opening balance');`), supporting both multi-currency `openingBalances` and single `openingBalance` backward compatibility.
     - `buildLedger`: ensure sub-ledger balance accumulators safely initialize `balances[entry.accountId][entry.currency]` without prototype collisions or undefined errors.
     - In `postingsForTransaction`: allow same-account cross-currency transfers when `transaction.currency !== transaction.transferCurrency`.
2. Integer Minor Units Strict Arithmetic:
   - Ensure all cash amounts are stored and calculated as integer minor units (`Money`, `toMinor`, `fromMinor`), eliminating all floating-point rounding errors.
3. Unified Valuation Layer & Missing FX Handling:
   - Convert native amounts to base currency using dated exchange rates on or before `asOf`.
   - CRITICAL REQUIREMENT: If an exchange rate is missing, `convertMoney` returns `null`, the balance is marked incomplete, and `knownNetWorth` excludes the foreign balance from the aggregated net worth. NEVER fall back to 1:1 conversion!
4. Linked Cross-Currency Transfers:
   - Record cross-currency transfers as linked source and destination postings, cleanly separating actual amounts and fees.
   - Verify `calculateCashFlow` guarantees transfers generate exactly ZERO income and ZERO expense.
5. Fix 13 Vitest Failures & Add Financial Integrity Tests:
   - Repair all 13 failures in `tests/calculations.test.ts`, `tests/repository.test.ts`, `tests/backup.test.ts` so that Vitest passes 100%.
   - Verify the acceptance criteria test: Test account holding PHP 10,000 and USD 100 correctly shows a converted total of PHP 15,600 (at test rate PHP 56/USD) without double-counting.
   - Add/verify `tests/financial-integrity.test.ts` explicitly asserting:
     a) PHP 10,000 + USD 100 @ 56 -> PHP 15,600.
     b) Removing exchange rate excludes foreign balance from net worth (not 1:1).
     c) Cross-currency transfers reflect zero income/expense.
6. Verification Requirements:
   - Remember `$env:PATH = "C:\Program Files\nodejs;" + $env:PATH`.
   - Run typecheck: `node ./node_modules/typescript/bin/tsc --noEmit`.
   - Run Vitest: `node ./node_modules/vitest/vitest.mjs run tests/calculations.test.ts tests/repository.test.ts tests/backup.test.ts tests/financial-integrity.test.ts`.
   - Run E2E suites: `node tests/e2e/run-all.mjs`.
   - Run Vite build: `node ./node_modules/vite/bin/vite.js build`.
   - All commands must pass with exit code 0.

Deliver your detailed handoff report to `e:\Visual Studio Code\tala\.agents\teamwork\worker_m2\handoff.md` with:
- Observation (commands and exact outputs)
- Logic Chain
- Caveats
- Conclusion
- Verification Method
Send a message back when completed.
