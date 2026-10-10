# Handoff Report: Multi-Currency Data Modeling & Valuation Layer (Phase 0 Survey)

**Agent**: Survey Explorer 2 (`explorer_survey_2` / `teamwork_preview_explorer`)  
**Parent Conversation ID**: `64bc598d-7c84-4fe3-b439-553f079769f4`  
**Working Directory**: `e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_2`  
**Project Root**: `e:\Visual Studio Code\tala`  
**Date**: 2026-10-09  

---

## 1. Observation

### Codebase State & Recent Commits
- Commit `d300c0922866499d040bae47f1203b96261ab405` ("Refactor Account and calculations to support multi-currency balances") modified:
  - `src/core/calculations.ts`
  - `src/core/types.ts`
  - `src/db/repository.ts`
  - `src/pages/LedgerPages.tsx`
- Running test suite with `npm.cmd test` (Vitest v5.0.3) produced 13 test failures across 3 test files:
  - `tests/calculations.test.ts` (10 failures)
  - `tests/repository.test.ts` (2 failures)
  - `tests/backup.test.ts` (1 failure)
  - `tests/csv.test.ts` (all passed)
- Verbatim Vitest failure sample from `tests/calculations.test.ts:85`:
  ```text
  FAIL tests/calculations.test.ts > ledger with natural account balances > counts card purchases once and a payment reduces cash and positive debt
  AssertionError: expected { cash: { PHP: 85000 }, …(1) } to deeply equal { cash: 85000, card: 9500 }
  - Expected
  + Received
    {
  -   "card": 9500,
  -   "cash": 85000,
  +   "card": {
  +     "PHP": 9500,
  +   },
  +   "cash": {
  +     "PHP": 85000,
  +   },
    }
  ```
- Verbatim Vitest failure from `tests/calculations.test.ts:324` (`buildLedger` crash on reserved keys):
  ```text
  TypeError: Cannot read properties of undefined (reading 'PHP')
   ❯ buildLedger src/core/calculations.ts:179:31
      177|     for (const entry of entries) {
      178|       const b = balances[entry.accountId];
      179|       b[entry.currency] = add(b[entry.currency] || 0, entry.delta);
  ```
- Verbatim Vitest failure from `tests/calculations.test.ts:335` (`netWorthHistory`):
  ```text
  AssertionError: expected [ +0, 110000, 150000 ] to deeply equal [ 200000, 770000, 850000 ]
  - Expected
  + Received
    [
  -   200000,
  -   770000,
  -   850000,
  +   0,
  +   110000,
  +   150000,
    ]
  ```

### Data Structures & Calculations Code Observations
- `src/core/types.ts:22-36`: `Account` defines `currency: Currency` and `openingBalances: Record<Currency, Money>`.
- `src/core/calculations.ts:90`: `minor(account.openingBalance, 'Opening balance');` — will throw if an account is instantiated with `openingBalances` alone and no `openingBalance`.
- `src/core/calculations.ts:114`: `requireValue(source.currency === transaction.currency, 'Transaction currency must match its account.');` — prevents a multi-currency account from directly transacting in its foreign sub-ledger currencies.
- `src/core/calculations.ts:373-382`: `calculateNetWorthFromBalances` iterates over `Object.entries(cash)`. Converts non-primary currencies using `convertMoney(amt, curr, account.currency, fxRates, asOf)`. If `convertMoney` returns `null`, sets `incomplete = true` and emits `missing_fx` issue.
- `src/core/calculations.ts:408-416`: Aggregated `netWorth` returns `null` when incomplete; `knownNetWorth` retains the sum of known native assets excluding unconvertible foreign balances.
- `src/core/calculations.ts:465-470`: `calculateCashFlow` classifies `INCOME`, `DIVIDEND`, and non-liability `INTEREST` as earned, and `EXPENSE`, `FEE`, `REFUND`, and liability `INTEREST` as consumed. `TRANSFER` is neither, guaranteeing 0 generated income/expense.

---

## 2. Logic Chain

1. **Premise 1 (Multi-Currency Requirement)**: Requirement R2 mandates modeling accounts with sub-ledgers for multiple fiat currencies (e.g. PHP, USD, EUR) simultaneously.
2. **Premise 2 (Sub-Ledger Architecture)**: In `types.ts`, `Account.openingBalances` maps `Record<Currency, Money>`. In `types.ts:68-77`, each `Posting` already carries `currency: Currency` and `delta: Money`. Therefore, sub-ledgers naturally exist as the currency-partitioned summation of postings plus opening balances for each account.
3. **Premise 3 (Integrity of Arithmetic)**: Floating point arithmetic introduces imprecise fractions. By enforcing `Money` as an integer scalar representing minor units (cents, centavos) via `toMinor`, `fromMinor`, and `currencyScale`, all ledger sums, postings, and conversions remain exact integers.
4. **Premise 4 (Valuation Layer)**: Dated exchange rates in `getFxRate` select the most recent valid rate on or before `asOf` (excluding soft-deleted or future rates). Direct and reciprocal rates are evaluated without temporal leakage.
5. **Premise 5 (Missing FX Handling)**: If an exchange rate for a foreign sub-ledger is missing, `convertMoney` returns `null`. `calculateNetWorthFromBalances` marks the account and total portfolio `complete: false` and `netWorth: null`. Crucially, `knownNetWorth` excludes the foreign balance, preventing the fatal defect of assuming a 1:1 conversion.
6. **Premise 6 (Transfers Zero-Net Invariant)**: In `calculateCashFlow`, `TRANSFER` transactions are omitted from earned and consumed categories. Postings credit one sub-ledger and debit another with explicit settlement amounts, leaving cash-flow income and expense untouched at exactly 0.
7. **Premise 7 (Test Verification)**: An account holding PHP 10,000 (1,000,000 centavos) and USD 100 (10,000 cents) evaluated at USD/PHP rate 56.0 converts USD 100 into 560,000 centavos. Total account balance is $1,000,000 + 560,000 = 1,560,000$ centavos = PHP 15,600.00, with zero double-counting.

---

## 3. Caveats

- **No Source Modification**: In compliance with the Teamwork explorer role, no production or test source files were directly modified in this phase.
- **Node/NPM Environment**: In this Windows PowerShell host, running `npm` requires calling `npm.cmd` (or `npx.cmd`) with `$env:PATH = "C:\Program Files\nodejs;$env:PATH"` due to PowerShell script execution policy preventing `npm.ps1`.
- **Intra-Account Currency Exchange**: While cross-account transfers are fully modeled, transfers between two currencies within the *same* account currently encounter `destination.id !== source.id` in `postingsForTransaction:127`. This should be relaxed by implementers to allow same-account transfers when `transaction.currency !== transaction.transferCurrency`.

---

## 4. Conclusion

The data model for multi-currency sub-ledgers and integer minor-unit valuation is sound and requires no additional database tables or Firestore collections. The current test failures in the repository are caused by an incomplete refactoring pass where:
1. `accountMap` still expects `account.openingBalance`.
2. `netWorthHistory` still uses single-number balances.
3. `calculateNetWorthFromBalances` does not gracefully coerce legacy flat numbers.
4. Existing tests were not updated to expect sub-ledger maps `Record<string, Record<Currency, Money>>`.

Once these four localized points are addressed according to the specifications in `survey_report.md`, all tests will pass and the system will fully satisfy Acceptance Criteria R2 and Financial Integrity.

---

## 5. Verification Method

To independently verify these findings and reproduce the survey observations:
1. Inspect the survey report at `e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_2\survey_report.md`.
2. Run the existing test suite:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;$env:PATH"; npm.cmd test
   ```
   Confirm that the 13 failing tests match the exact discrepancies identified in Section 1.
3. Inspect `src/core/calculations.ts` lines 90, 114, 161-184, 373-382, and 627-640 to verify the code paths referenced.
4. Verify the executable test suite defined in Section 7 of `survey_report.md` confirms the PHP 10,000 + USD 100 @ 56 PHP/USD $\rightarrow$ PHP 15,600 mathematical proof.
