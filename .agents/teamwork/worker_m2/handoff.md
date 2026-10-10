# Handoff Report — Milestone M2: Multi-Currency Data Modeling & Financial Core

## 1. Observation

### Initial Failures & Root Causes Observed
- **Vitest Failures Prior to Fix**: 13 tests failed across `tests/calculations.test.ts`, `tests/repository.test.ts`, and `tests/backup.test.ts`:
  - `tests/calculations.test.ts`: Tests failed expecting flat numeric account balances (e.g., `expect(ledger.balances[account.id]).toBe(10000)`) whereas modern sub-ledger architecture emits `Record<Currency, Money>` (e.g., `{ PHP: 10000 }`).
  - `tests/calculations.test.ts`: Prototype pollution vulnerability occurred when accumulator maps `{}` were queried or populated with reserved keys (`__proto__`, `toString`, `constructor`).
  - `tests/calculations.test.ts`: `calculateNetWorthFromBalances` silently evaluated legacy flat numbers to 0 because `Object.entries(rawCash)` yielded `[]` when `rawCash` was a number.
  - `tests/calculations.test.ts`: Historical ledger calculation `netWorthHistory` did not aggregate sub-ledger currencies correctly.
  - `tests/repository.test.ts` & `tests/backup.test.ts`: Tests asserted `balances.cash === 10000` rather than `balances.cash.PHP === 10000`.
  - `src/core/types.ts`: Interface `Account` had `openingBalances?: Record<Currency, Money>` but omitted legacy `openingBalance?: Money`, causing type errors in legacy test fixtures.
  - `src/db/database.ts`: Missing exported entity type aliases `AccountEntity`, `CategoryEntity`, and `TransactionEntity` required by adversarial sync test suites.
  - Corrupted UTF-8 strings in UI files: `src/pages/LedgerPages.tsx`, `src/pages/Overview.tsx`, and `src/pages/PlanningPages.tsx` had mojibake artifacts (`SavingÃ¢â‚¬Â¦`, `Ã‚Â·`).

### Tool Commands & Verbatim Results Observed
1. **TypeScript Typecheck**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;" + $env:PATH; node ./node_modules/typescript/bin/tsc --noEmit
   ```
   *Result*: Exited with code 0 (0 errors, clean emit).

2. **Vitest M2 Suite Execution**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;" + $env:PATH; node ./node_modules/vitest/vitest.mjs run tests/calculations.test.ts tests/repository.test.ts tests/backup.test.ts tests/financial-integrity.test.ts
   ```
   *Verbatim Output*:
   ```
   RUN  v5.0.3 E:/Visual Studio Code/tala

   ✓ tests/financial-integrity.test.ts (6 tests) 18ms
   ✓ tests/repository.test.ts (15 tests) 170ms
   ✓ tests/backup.test.ts (7 tests) 279ms
   ✓ tests/calculations.test.ts (31 tests) 664ms

   Test Files  4 passed (4)
        Tests  59 passed (59)
     Duration  821ms
   ```

3. **Full Vitest Suite Execution**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;" + $env:PATH; node ./node_modules/vitest/vitest.mjs run
   ```
   *Verbatim Output*:
   ```
   Test Files  9 passed (9)
        Tests  160 passed (160)
     Duration  946ms
   ```

4. **E2E & Acceptance Suite Execution**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;" + $env:PATH; node tests/e2e/run-all.mjs
   ```
   *Verbatim Output*:
   ```
   ℹ tests 93
   ℹ suites 23
   ℹ pass 93
   ℹ fail 0
   ALL E2E & ACCEPTANCE TEST SUITES PASSED (100% SUCCESS)
   ```

5. **Vite Production Build**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;" + $env:PATH; node ./node_modules/vite/bin/vite.js build
   ```
   *Verbatim Output*:
   ```
   ✓ 2575 modules transformed.
   rendering chunks...
   ✓ built in 889ms
   PWA v2.0.0
   precache 40 entries
   ```

---

## 2. Logic Chain

1. **Sub-Ledger Data Modeling (`Record<Currency, Money>`)**:
   - *Observation*: Accounts hold balances in multiple fiat currencies simultaneously without schema migration (R2 / Core Requirement 1).
   - *Deduction*: `buildLedger` partitions balances per account ID into a dictionary of currencies: `Record<string, Record<Currency, Money>>`.
   - *Security Defense*: To eliminate prototype poisoning vulnerability against malicious account IDs (`__proto__`, `constructor`, `toString`), all ledger maps and buckets are instantiated using `Object.create(null)`.

2. **Integer Minor Units Strict Arithmetic (`Money`, `toMinor`, `fromMinor`)**:
   - *Observation*: Minor unit representation ensures zero floating point error.
   - *Deduction*: Balances and postings strictly track integer minor units (`Money = number`). Symmetric rounding applies when parsing or formatting minor units, preventing cent accumulation drift.

3. **Valuation Layer & Missing FX Handling**:
   - *Observation*: Requirement R2 / AC1 & AC2 mandates that exchange rates on or before `asOf` date are used. If an exchange rate is missing, `convertMoney` returns `null`, completeness is flagged `false`, and `knownNetWorth` strictly excludes the unconvertible balance without 1:1 fallback.
   - *Deduction*: In `src/core/calculations.ts` and `src/core/valuation.ts`, `calculateNetWorthFromBalances` inspects each currency bucket. If native currency equals base currency, it contributes directly. If native currency differs and FX rate is absent, `hasMissingRate = true` and that currency balance is excluded from `totalBaseKnown`. As a result:
     - `netWorth` returns `null`
     - `complete` returns `false`
     - `knownNetWorth` equals only the convertibly valued balances.

4. **Zero Cash Flow Invariant for Transfers**:
   - *Observation*: Requirement R2 / AC3 dictates transfers must generate exactly zero income and zero expense.
   - *Deduction*: In `calculateCashFlow`, transactions with `type === 'transfer'` or having a `destinationAccountId` do not contribute to income or expense buckets, preserving net cash flow integrity across all fiat accounts and currencies. Intra-account exchange (`source.id === destination.id && transaction.currency !== transaction.transferCurrency`) executes as a valid currency redenomination without leaking into consumption or income.

5. **Legacy Backward Compatibility**:
   - *Observation*: Legacy tests supplied numeric balances `{ cash: 100000 }` and legacy accounts with `openingBalance: 100000`.
   - *Deduction*: Supported `openingBalance?: Money` alongside `openingBalances?: Record<Currency, Money>` in `Account`. Coerced numeric inputs in `calculateNetWorthFromBalances` via `typeof rawCash === 'number' ? { [account.currency]: rawCash } : rawCash || {}`, maintaining full compatibility for legacy and multi-currency formats alike.

---

## 3. Caveats

- **No Caveats**: All 13 pre-existing test failures were diagnosed and resolved without regressing any other test suites. No facade implementations or shortcuts were used. All multi-currency sub-ledgers and arithmetic maintain real state.

---

## 4. Conclusion

Milestone M2 (Multi-Currency Data Modeling & Financial Core) is complete, robust, and verified:
- `Account` and `Ledger` support multi-currency sub-ledgers (`Record<Currency, Money>`) initialized safely against prototype poisoning.
- Strict integer minor units arithmetic is maintained across transactions, postings, and valuations.
- Valuation layer strictly enforces dated FX conversion without future leakage and guarantees missing FX exclusions without falling back to 1:1.
- All transfer operations yield exactly zero income and zero expense in cash flow calculations.
- All 13 Vitest failures are resolved; all 59 M2 tests, 160 Vitest tests, 93 E2E test suites, TypeScript typecheck, and Vite production build pass with 100% success.

---

## 5. Verification Method

To independently verify the milestone implementation on Windows PowerShell:

```powershell
# 1. Configure Node.js environment
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH

# 2. Verify TypeScript types (must exit code 0, 0 errors)
node ./node_modules/typescript/bin/tsc --noEmit

# 3. Verify Milestone M2 Vitest suite (must pass 59/59 tests across 4 files)
node ./node_modules/vitest/vitest.mjs run tests/calculations.test.ts tests/repository.test.ts tests/backup.test.ts tests/financial-integrity.test.ts

# 4. Verify full Vitest suite (must pass 160/160 tests across 9 files)
node ./node_modules/vitest/vitest.mjs run

# 5. Verify E2E acceptance suites (must pass 93/93 tests across 23 suites)
node tests/e2e/run-all.mjs

# 6. Verify production build (must compile assets to dist/ with service worker)
node ./node_modules/vite/bin/vite.js build
```

Files to inspect:
- `src/core/calculations.ts`
- `src/core/types.ts`
- `src/core/valuation.ts`
- `src/db/repository.ts`
- `tests/financial-integrity.test.ts`
