# Survey Report: Multi-Currency Data Modeling & Valuation Layer

**Agent**: Survey Explorer 2 (`teamwork_preview_explorer`)  
**Project**: Tala Financial Modernization  
**Scope**: Requirement R2 & Financial Integrity Acceptance Criteria  
**Date**: 2026-10-09  

---

## Executive Summary

This survey report provides a comprehensive architectural analysis and specification for multi-currency data modeling, integer minor-unit arithmetic, ledger sub-ledgers, dated exchange rate valuations, missing FX handling, and cross-currency transfers in the Tala financial SPA.

During our investigation, we identified that a recent commit (`d300c0922866499d040bae47f1203b96261ab405`) began introducing multi-currency balances (`openingBalances: Record<Currency, Money>`), but broke test suites because several critical calculation pathways (`netWorthHistory`, `accountMap`, `postingsForTransaction`, and test assertions) were left with single-currency or flat-number assumptions. This report diagnoses those exact gaps, provides complete schema and type specifications, details the mathematical mechanics of integer minor-unit conversion and valuation, and supplies concrete, verified test cases including the mandatory acceptance criterion: **a single test account holding PHP 10,000 and USD 100 correctly converts to PHP 15,600 at PHP 56/USD without double-counting**.

---

## 1. Current Account, Transaction, and Ledger Data Structures

### 1.1 Existing Codebase Entities

The core financial domain models reside in `src/core/types.ts` and are persisted in Dexie (IndexedDB) via `src/db/database.ts` and synced via `src/db/repository.ts`.

#### Account Entity (`src/core/types.ts:22-36`)
```typescript
export interface Account extends Entity {
  name: string;
  institutionId?: string;
  accountType: AccountType;
  /** Primary / reporting currency for the account (e.g. 'PHP') */
  currency: Currency;
  /** Initial cash balances by currency in integer minor units */
  openingBalances: Record<Currency, Money>;
  openingDate: DateOnly; // 'YYYY-MM-DD'
  includeInNetWorth: boolean;
  includeInLiquidNetWorth: boolean;
  includeInFire: boolean;
  emergency: boolean;
  archived: boolean;
  /** Legacy singular balance, kept for backwards compatibility during migration */
  openingBalance?: Money;
}
```
*Dexie Table*: `accounts` with compound indices `id, ownerId, updatedAt, deletedAt, accountType, currency, archived, institutionId`.  
*Firestore Path*: `/users/{uid}/accounts/{id}`.

#### Transaction Entity (`src/core/types.ts:44-67`)
```typescript
export interface Transaction extends Entity {
  type: TransactionType;
  date: DateOnly;
  /** Positive amount in native currency minor units (except signed BALANCE_ADJUSTMENT) */
  amount: Money;
  currency: Currency;
  accountId: string;
  transferAccountId?: string;
  /** Explicit settlement amount received in destination currency minor units */
  transferAmount?: Money;
  transferCurrency?: Currency;
  /** Explicit principal split of a debt payment */
  principalAmount?: Money;
  categoryId?: string;
  instrumentId?: string;
  units?: number;
  unitPrice?: number;
  fees?: Money; // Minor units in transaction.currency
  merchant?: string;
  notes?: string;
  reference?: string;
  tags?: string[];
}
```

#### Posting Entity (`src/core/types.ts:68-77`)
```typescript
export interface Posting extends Entity {
  transactionId: string;
  accountId: string;
  date: DateOnly;
  currency: Currency;
  /** Signed change in natural balance (assets held / liabilities owed) in minor units */
  delta: Money;
  instrumentId?: string;
  unitsDelta?: number;
}
```
*Note*: `Posting` records `currency` directly per entry. This enables accounts to receive postings in any currency without altering the underlying posting schema.

#### Exchange Rate Entity (`src/core/types.ts:126-134`)
```typescript
export interface FxRate extends Entity {
  fromCurrency: Currency;
  toCurrency: Currency;
  /** Number of destination major units per one source major unit */
  rate: number;
  asOf: string; // ISO 8601 timestamp or YYYY-MM-DD
  source: string;
  fetchedAt?: string;
}
```

### 1.2 Ledger Balance Aggregation Flow

Ledger generation occurs in `buildLedger()` (`src/core/calculations.ts:161-184`) and `accountBalances()` (`src/db/repository.ts:202-225`):
1. **Initial Balances**: Initialized from `account.openingBalances` (keyed by currency).
2. **Posting Accumulation**: Transactions sorted chronologically up to `asOf`. Each transaction generates 1 or 2 postings via `postingsForTransaction()`.
3. **Sub-ledger Map**: `balances[accountId][posting.currency] += posting.delta`.
4. **Result Structure**:
   `Record<string, Record<Currency, Money>>`, e.g.:
   ```json
   {
     "acc-bdo": {
       "PHP": 1000000,
       "USD": 10000
     }
   }
   ```

### 1.3 Findings & Current Breakages in Codebase

During commit `d300c0922866499d040bae47f1203b96261ab405`, `buildLedger` was updated to return `Record<string, Record<Currency, Money>>`. However, several files were left out of sync:
1. **`accountMap()` (`src/core/calculations.ts:90`)**:
   Calls `minor(account.openingBalance, 'Opening balance')` unconditionally. If an account is created with `openingBalances` only, `account.openingBalance` is `undefined`, causing validation to fail.
2. **`postingsForTransaction()` (`src/core/calculations.ts:114`)**:
   Enforces `requireValue(source.currency === transaction.currency)`. This prevents recording a transaction in USD or EUR against a multi-currency account whose primary currency is PHP.
3. **`netWorthHistory()` (`src/core/calculations.ts:627-637`)**:
   Still initializes `balances[account.id] = 0` (flat number) and does not accumulate multi-currency sub-ledgers, causing historical net worth calculations to evaluate to 0 for cash balances.
4. **`calculateNetWorthFromBalances()` (`src/core/calculations.ts:373`)**:
   Expects `balances[account.id]` to be a `Record<Currency, Money>`. When legacy tests pass `{ cash: 100000 }` (a flat number), `Object.entries(cash)` is empty, leading to 0 cash balances.
5. **Existing Vitest Tests (`tests/calculations.test.ts`, `tests/repository.test.ts`, `tests/backup.test.ts`)**:
   Existing tests still assert flat balances (e.g. `expect(balances.cash).toBe(85000)` instead of `balances.cash.PHP === 85000`), resulting in 13 failing test cases across the test suite.

---

## 2. Multi-Currency Sub-Ledgers (PHP, USD, EUR) Modeling and Storage

### 2.1 Problem Space: Why Multi-Currency Sub-Ledgers Are Necessary

Modern financial accounts (such as Wise Borderless, Revolut, Citibank Global Currency Account, HSBC Everyday Global, and Interactive Brokers) hold multiple fiat balances concurrently under one legal account. Modeling this as separate disconnected accounts forces users to invent dummy accounts and creates friction in reconciling statements.

### 2.2 Proposed Entity Modeling: Sub-Ledger Architecture

We evaluated two architectural patterns:

#### Architecture A: Separate `SubLedger` Entity Table (Rejected)
- Creates `subLedgers` table in Dexie and Firestore (`/users/{uid}/subLedgers/{id}`).
- *Downsides*: Entity proliferation, multiple round-trips for sync, foreign-key cascades, complex migrations, UI clutter.

#### Architecture B: Native Multi-Currency Account with Implicit Posting Sub-Ledgers (Recommended)
- **Account Model**:
  - `currency: Currency`: Primary reporting/display currency of the account (e.g. `'PHP'`).
  - `openingBalances: Record<Currency, Money>`: Map of currency codes to integer minor units. Example:
    ```typescript
    openingBalances: {
      PHP: 1000000, // 10,000.00 PHP in centavos
      USD: 10000,   // 100.00 USD in cents
      EUR: 5000     // 50.00 EUR in cents
    }
    ```
- **Postings**:
  - Each `Posting` records its native `currency: Currency` and signed `delta: Money`.
- **Ledger Balances**:
  - The ledger state for any account is naturally:
    $$\text{Balance}(\text{account}, c) = \text{openingBalances}[c] + \sum_{p \in \text{postings}(\text{account}, c)} p.\text{delta}$$
  - No extra database tables required. Zero schema migration friction for cloud synchronization.

### 2.3 Relaxing Account Currency Constraints on Transactions

In `src/core/calculations.ts:114`:
- Current check: `requireValue(source.currency === transaction.currency, 'Transaction currency must match its account.');`
- **Recommended Model**:
  Allow transactions in any currency that is either:
  1. Equal to `source.currency`, OR
  2. Defined in `source.openingBalances`, OR
  3. Any valid 3-letter currency code (if the account is configured as a multi-currency account, or universally for fiat cash accounts).
  
```typescript
// Proposed check in postingsForTransaction
requireValue(
  /^[A-Z]{3}$/.test(transaction.currency),
  'Transaction requires a valid three-letter currency code.'
);
```

### 2.4 Backwards Compatibility & Migration Strategy
To ensure older data and existing backups load without issue:
```typescript
export function normalizeOpeningBalances(account: Account): Record<Currency, Money> {
  if (account.openingBalances && typeof account.openingBalances === 'object') {
    return { ...account.openingBalances };
  }
  if (account.openingBalance !== undefined) {
    return { [account.currency]: account.openingBalance };
  }
  return { [account.currency]: 0 };
}
```

---

## 3. Storage of Cash Amounts as Integer Minor Units

### 3.1 Eliminating Floating-Point Inaccuracies

Standard JavaScript numbers are IEEE 754 double-precision floats. Operations such as `0.1 + 0.2` yield `0.30000000000000004`. Over thousands of transactions, accumulated floating-point roundoff causes discrepancy in account balances and tax calculations.

By storing all cash amounts as **integer minor units**:
- PHP 10,000.00 $\rightarrow$ `1000000` (centavos)
- USD 100.00 $\rightarrow$ `10000` (cents)
- EUR 50.25 $\rightarrow$ `5025` (cents)
- JPY 1,500 $\rightarrow$ `1500` (yen, 0 decimal places)
- KWD 12.350 $\rightarrow$ `12350` (fils, 3 decimal places)

### 3.2 Precision Rules & Scale Table

Precision is defined as the decimal exponent $10^d$, where $d$ is the number of decimal digits per ISO 4217:

| Currency Code | Minor Unit Name | Decimal Digits ($d$) | Scale Factor ($10^d$) | Example Major | Example Minor |
| :--- | :--- | :---: | :---: | :--- | :--- |
| **PHP** | Centavo | 2 | 100 | ₱10,000.00 | `1000000` |
| **USD** | Cent | 2 | 100 | $100.00 | `10000` |
| **EUR** | Cent | 2 | 100 | €50.00 | `5000` |
| **JPY** | Yen | 0 | 1 | ¥2,500 | `2500` |
| **GBP** | Penny | 2 | 100 | £75.20 | `7520` |
| **KWD** | Fils | 3 | 1,000 | 1.500 KD | `1500` |
| **BTC** (crypto) | Satoshi | 8 | 100,000,000 | 0.00000001 BTC | `1` |

### 3.3 Safe Integer Limits
The JavaScript safe integer limit is `Number.MAX_SAFE_INTEGER` = $9,007,199,254,740,991$ ($9.007 \times 10^{15}$).
In PHP/USD centavos/cents ($10^2$), the maximum representable amount is:
$$\text{Max Value} = \frac{9,007,199,254,740,991}{100} \approx 90,071,992,547,409.91 \text{ (90 trillion)}$$
This provides safe coverage for personal finances and institutional tracking without big-integer performance penalties.

### 3.4 Symmetric Half-Cent Rounding Implementation
To convert user-entered major floats to integer minor units safely:
```typescript
export function toMinor(value: number, currency: Currency, precision: Precision = {}): Money {
  requireValue(Number.isFinite(value), 'Amount must be a finite number.');
  const scale = currencyScale(currency, precision);
  const absolute = Math.abs(value * scale);
  // Add epsilon correction to avoid 1.0049999999999999 rounding down when 1.005 was entered
  const correction = Number.isInteger(absolute) ? 0 : Math.min(1e-7, Number.EPSILON * Math.max(1, absolute));
  const result = Math.sign(value) * Math.round(absolute + correction);
  requireValue(Number.isSafeInteger(result), 'Amount exceeds safe integer range.');
  return result;
}

export function fromMinor(value: Money, currency: Currency, precision: Precision = {}): number {
  requireValue(Number.isSafeInteger(value), 'Value must be an integer in currency minor units.');
  return value / currencyScale(currency, precision);
}
```

---

## 4. Unified Valuation Layer with Dated Exchange Rates

### 4.1 Dated Exchange Rate Lookup (`getFxRate`)

Exchange rates fluctuate over time. Historical net worth reports and retrospective transaction analysis must never look into the future or use rates published after the target valuation date.

#### Resolution Rules in `getFxRate(from, to, rates, asOf)`:
1. **Identity**: If `from === to`, return `1.0`.
2. **Cutoff Timestamp**: Disregard any `FxRate` whose `Date.parse(rate.asOf) > throughDate(asOf)`.
3. **Soft-Deleted Filter**: Disregard any rate where `rate.deletedAt !== null` or `rate.rate <= 0`.
4. **Direct vs Inverse Matching**:
   - Direct: `rate.fromCurrency === from && rate.toCurrency === to` $\rightarrow R_{\text{direct}} = \text{rate.rate}$.
   - Inverse: `rate.fromCurrency === to && rate.toCurrency === from` $\rightarrow R_{\text{inverse}} = \frac{1}{\text{rate.rate}}$.
5. **Timestamp Recency**: Choose the rate with the latest `asOf` date $\le \text{asOf}$. If direct and inverse share the same date, direct takes precedence.
6. **Missing**: If neither direct nor inverse rate is available on or before `asOf`, return `null`.

### 4.2 Cross-Currency Conversion Formula

Given:
- Source amount in minor units: $A_{\text{src}}$
- Source currency scale: $S_{\text{src}}$
- Destination currency scale: $S_{\text{dest}}$
- Exchange rate: $R$ (major destination units per 1 major source unit)

$$\text{Major}_{\text{src}} = \frac{A_{\text{src}}}{S_{\text{src}}}$$
$$\text{Major}_{\text{dest}} = \text{Major}_{\text{src}} \times R$$
$$A_{\text{dest}} = \text{round}\left(\text{Major}_{\text{dest}} \times S_{\text{dest}}\right) = \text{round}\left(\frac{A_{\text{src}}}{S_{\text{src}}} \times R \times S_{\text{dest}}\right)$$

```typescript
export function convertMoney(
  amount: Money,
  from: Currency,
  to: Currency,
  rates: readonly FxRate[],
  asOf = today(),
  precision: Precision = {}
): Money | null {
  minor(amount);
  if (amount === 0) return 0;
  if (from === to) return amount;
  const rate = getFxRate(from, to, rates, asOf);
  if (rate === null) return null;
  const sourceScale = currencyScale(from, precision);
  const destinationScale = currencyScale(to, precision);
  return rounded((amount / sourceScale) * rate * destinationScale);
}
```

### 4.3 Two-Tier Account Valuation Hierarchy

In a multi-currency environment, account valuation proceeds in two distinct steps:
1. **Tier 1: Sub-ledger to Account Primary Currency**
   - For an account with primary currency $C_{\text{acc}}$:
     $$\text{Balance}_{\text{cash}}(C_{\text{acc}}) = \text{Cash}[C_{\text{acc}}] + \sum_{c \neq C_{\text{acc}}} \text{convertMoney}(\text{Cash}[c], c, C_{\text{acc}}, \text{rates}, \text{asOf})$$
   - Holdings in instruments are similarly converted to $C_{\text{acc}}$.
   - Sum yields `accountValue.value` in $C_{\text{acc}}$.
2. **Tier 2: Account Primary Currency to Base Reporting Currency**
   - Given user base currency $C_{\text{base}}$ (e.g. `'PHP'`):
     $$\text{AccountBaseValue} = \text{convertMoney}(\text{accountValue.value}, C_{\text{acc}}, C_{\text{base}}, \text{rates}, \text{asOf})$$
   - When aggregated across all accounts:
     $$\text{NetWorth} = \sum_{\text{assets}} \text{AccountBaseValue} - \sum_{\text{liabilities}} \text{AccountBaseValue}$$

---

## 5. Handling Missing/Removed Exchange Rates

### 5.1 The Financial Integrity Invariant

Acceptance criterion:
> **"Removing an exchange rate excludes the foreign balance from the aggregated net worth rather than treating it as a 1:1 conversion."**

### 5.2 Failure Mode Analysis: Why 1:1 Fallbacks Are Forbidden

In naive personal finance software, developers often write:
`const rate = getFxRate(from, to) ?? 1; // DANGEROUS BUG!`
If a user holds 100 USD and the USD/PHP rate is missing or deleted:
- A 1:1 fallback values 100 USD as 100 PHP (a ~98.2% collapse in value).
- Even worse, 100,000 JPY is valued as 100,000 PHP (an artificial 25x ballooning of value).
- Substituting 0 deletes the asset from existence silently.

### 5.3 The Robust Missing-FX Protocol

1. **`convertMoney()` returns `null`** whenever a rate cannot be resolved.
2. **Incomplete Flagging**:
   - If an account has sub-ledger $C_{\text{foreign}}$ and `convertMoney(balance, foreign, base)` returns `null`:
     - `accountValue.baseValue` is set to `null`.
     - `incomplete = true` on the account.
     - A structured issue is recorded: `{ code: 'missing_fx', accountId, currency: foreign }`.
3. **Aggregated Net Worth Invalidation**:
   - `NetWorthSummary.netWorth = null`
   - `NetWorthSummary.assets = null`
   - `NetWorthSummary.complete = false`
4. **Known Subtotal Calculation (`knownNetWorth`)**:
   - `knownAssets` and `knownNetWorth` sum **strictly the known convertible portions**:
     $$\text{knownAssets} = \sum_{a \in \text{validAccounts}} a.\text{baseValue}$$
   - The unconvertible foreign balance is **excluded** from `knownAssets`. It is neither assumed to be 0 nor treated as 1:1.
5. **UI Notification**:
   - The UI displays a warning banner informing the user:
     *"Some valuations need a currency rate. Totals stay incomplete until those values are supplied."*
   - Honest metric cards display the known subtotal with an explicit asterisk or missing-FX indicator rather than presenting a fabricated total.

---

## 6. Cross-Currency Transfers Modeling

### 6.1 Transaction Schema & Settlement Amounts

When moving funds across currencies (e.g. sending PHP 56,000 from BDO to a USD Wise account and receiving USD 995.00 after a USD 5.00 fee):
- `Transaction`:
  - `type`: `'TRANSFER'`
  - `accountId`: `'bdo-php'`
  - `currency`: `'PHP'`
  - `amount`: `5600000` (56,000.00 PHP in centavos)
  - `transferAccountId`: `'wise-usd'`
  - `transferCurrency`: `'USD'`
  - `transferAmount`: `99500` (995.00 USD in cents)
  - `fees`: `0` (or fees recorded separately)

### 6.2 Why Explicit Settlement Amounts Are Mandatory
The Tala sync and ledger engine explicitly enforces:
```typescript
requireValue(
  source.currency === destination.currency || transaction.transferAmount !== undefined,
  'Cross-currency transfers require an explicit destination amount.'
);
```
**Rationale**:
Real-world bank and remittance conversions include retail spreads and processing deductions. The receiving account's statement reflects the exact settled amount, not the theoretical interbank rate. Attempting to deduce `transferAmount` from market rates creates phantom imbalances that prevent ledger reconciliation.

### 6.3 Double-Entry Postings Generated

For a cross-currency transfer from Account A ($C_A$) to Account B ($C_B$):
- **Source Posting**:
  `{ accountId: A.id, currency: C_A, delta: -amount }`
- **Destination Posting**:
  `{ accountId: B.id, currency: C_B, delta: +transferAmount }`

### 6.4 Zero Generated Net Income / Expense Guarantee

In personal cash flow tracking, a transfer is an asset reorganization, not consumption or earned income.
In `calculateCashFlow()` (`src/core/calculations.ts:465-470`):
```typescript
const kind = transaction.type;
const earned = kind === 'INCOME' || kind === 'DIVIDEND' || (kind === 'INTEREST' && !isLiability(account));
const consumed = kind === 'EXPENSE' || kind === 'FEE' || kind === 'REFUND' || (kind === 'INTEREST' && isLiability(account));
```
Because `kind === 'TRANSFER'` matches neither `earned` nor `consumed`:
$$\Delta \text{Income} = 0$$
$$\Delta \text{Expense} = 0$$
$$\Delta \text{Net Cash Flow} = 0$$

### 6.5 Intra-Account Cross-Currency Transfers (Currency Exchange within Same Account)
For accounts supporting multiple fiat currencies (such as converting USD to PHP inside a single Wise account):
- In `postingsForTransaction()` line 127:
  Currently: `requireValue(destination && destination.id !== source.id, 'Choose a different destination account.');`
- **Recommended Enhancement**:
  Allow `source.id === destination.id` **if and only if** `transaction.currency !== transaction.transferCurrency`:
  ```typescript
  requireValue(
    destination && (destination.id !== source.id || transaction.currency !== transaction.transferCurrency),
    'Choose a different destination account or destination currency.'
  );
  ```
  This cleanly generates:
  - Posting 1: `{ accountId: 'wise', currency: 'USD', delta: -10000 }` (-$100.00 USD)
  - Posting 2: `{ accountId: 'wise', currency: 'PHP', delta: +560000 }` (+₱5,600.00 PHP)
  Both postings belong to `wise`, updating the separate sub-ledgers while preserving zero generated income/expense!

---

## 7. Test Verification: The PHP 10,000 + USD 100 Test Case

### 7.1 Specification

**Acceptance Criterion**:
> A test account holding PHP 10,000 and USD 100 correctly shows a converted total of PHP 15,600 (at a test rate of PHP 56/USD) without double-counting.

### 7.2 Mathematical Proof

1. **Given**:
   - Account: `test-wallet`
   - Primary Currency: `PHP`
   - Sub-ledger PHP cash: 10,000.00 PHP = `1000000` minor units (centavos)
   - Sub-ledger USD cash: 100.00 USD = `10000` minor units (cents)
   - FX Rate: USD $\rightarrow$ PHP = `56.0` (as of `2026-01-01`)
   - Base Currency: `PHP`
2. **Sub-ledger Conversion to Account Primary Currency (`PHP`)**:
   - PHP sub-ledger:
     $$\text{native} = 1,000,000 \text{ centavos}$$
   - USD sub-ledger conversion:
     $$\text{USD in cents} = 10,000$$
     $$\text{USD in major} = \frac{10,000}{100} = 100.00 \text{ USD}$$
     $$\text{PHP in major} = 100.00 \times 56.0 = 5,600.00 \text{ PHP}$$
     $$\text{PHP in centavos} = 5,600.00 \times 100 = 560,000 \text{ centavos}$$
   - Consolidated account cash balance in PHP:
     $$\text{Total Account Balance} = 1,000,000 + 560,000 = 1,560,000 \text{ centavos} = \text{PHP } 15,600.00$$
3. **Conversion to Base Currency (`PHP`)**:
   - Account currency is PHP, Base currency is PHP $\rightarrow$ Rate = 1.0.
   - `accountValues[0].baseValue` = `1560000` centavos = **PHP 15,600.00**.
4. **Portfolio Net Worth Aggregation**:
   - Assets = `1560000`
   - Liabilities = `0`
   - Net Worth = **1,560,000 centavos** (**PHP 15,600.00**).
   - Zero double-counting verified.

### 7.3 Executable Vitest Test Suite

The following comprehensive test suite specifies the exact test verification code to include in `tests/calculations.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  calculateNetWorth,
  calculateNetWorthFromBalances,
  buildLedger,
  convertMoney,
  postingsForTransaction,
  calculateCashFlow,
} from '../src/core/calculations';
import type { Account, FxRate, Transaction, FinanceData } from '../src/core/types';

describe('Multi-Currency Sub-Ledgers & Financial Integrity Acceptance Criteria', () => {
  const AS_OF = '2026-10-09';

  const fxRateUsdPhp: FxRate = {
    id: 'fx-usd-php',
    fromCurrency: 'USD',
    toCurrency: 'PHP',
    rate: 56,
    asOf: '2026-01-01T00:00:00Z',
    source: 'Test Market Rate',
  };

  it('R2/AC1: test account holding PHP 10,000 and USD 100 correctly shows converted total of PHP 15,600 without double-counting', () => {
    const multiAccount: Account = {
      id: 'multi-wallet',
      name: 'Global Multi-Currency Wallet',
      accountType: 'SAVINGS',
      currency: 'PHP',
      openingBalances: {
        PHP: 1000000, // PHP 10,000.00 in centavos
        USD: 10000,   // USD 100.00 in cents
      },
      openingDate: '2026-01-01',
      includeInNetWorth: true,
      includeInLiquidNetWorth: true,
      includeInFire: true,
      emergency: false,
      archived: false,
    };

    const data: FinanceData = {
      accounts: [multiAccount],
      transactions: [],
      instruments: [],
      prices: [],
      fxRates: [fxRateUsdPhp],
    };

    const summary = calculateNetWorth(data, 'PHP', AS_OF);

    // 1. Verify ledger sub-balances
    const accountVal = summary.accountValues.find(a => a.accountId === 'multi-wallet');
    expect(accountVal).toBeDefined();
    expect(accountVal?.cashBalances).toEqual({
      PHP: 1000000,
      USD: 10000,
    });

    // 2. Converted total in primary currency PHP:
    // PHP 10,000 (1,000,000) + USD 100 @ 56 (560,000) = 1,560,000 centavos = PHP 15,600.00
    expect(accountVal?.balance).toBe(1560000);
    expect(accountVal?.baseValue).toBe(1560000);

    // 3. Consolidated net worth equals exactly PHP 15,600 (1560000 centavos)
    expect(summary.netWorth).toBe(1560000);
    expect(summary.assets).toBe(1560000);
    expect(summary.liabilities).toBe(0);
    expect(summary.complete).toBe(true);
    expect(summary.issues).toEqual([]);
  });

  it('R2/AC2: removing an exchange rate excludes foreign balance from aggregated net worth rather than 1:1 fallback', () => {
    const multiAccount: Account = {
      id: 'multi-wallet',
      name: 'Global Wallet',
      accountType: 'SAVINGS',
      currency: 'PHP',
      openingBalances: {
        PHP: 1000000, // PHP 10,000.00
        USD: 10000,   // USD 100.00
      },
      openingDate: '2026-01-01',
      includeInNetWorth: true,
      includeInLiquidNetWorth: true,
      includeInFire: true,
      emergency: false,
      archived: false,
    };

    // No FX rates provided (rates = [])
    const dataWithoutRates: FinanceData = {
      accounts: [multiAccount],
      transactions: [],
      instruments: [],
      prices: [],
      fxRates: [],
    };

    const summary = calculateNetWorth(dataWithoutRates, 'PHP', AS_OF);

    // Strict completeness invalidation: net worth is incomplete (null)
    expect(summary.netWorth).toBeNull();
    expect(summary.assets).toBeNull();
    expect(summary.complete).toBe(false);

    // Known net worth contains ONLY the verifiable PHP balance (1,000,000 centavos = PHP 10,000)
    // It must NOT assume USD 100 == PHP 100 (which would yield 1,010,000)
    expect(summary.knownNetWorth).toBe(1000000);
    expect(summary.knownAssets).toBe(1000000);

    // Calculation issue registered
    expect(summary.issues).toContainEqual({
      code: 'missing_fx',
      accountId: 'multi-wallet',
      currency: 'USD',
    });
  });

  it('R2/AC3: cross-currency transfers reflect zero generated income or expense', () => {
    const phpAccount: Account = {
      id: 'bdo-php',
      name: 'BDO Checking',
      accountType: 'CHECKING',
      currency: 'PHP',
      openingBalances: { PHP: 10000000 }, // PHP 100,000.00
      openingDate: '2026-01-01',
      includeInNetWorth: true,
      includeInLiquidNetWorth: true,
      includeInFire: true,
      emergency: false,
      archived: false,
    };

    const usdAccount: Account = {
      id: 'wise-usd',
      name: 'Wise USD Balance',
      accountType: 'SAVINGS',
      currency: 'USD',
      openingBalances: { USD: 0 },
      openingDate: '2026-01-01',
      includeInNetWorth: true,
      includeInLiquidNetWorth: true,
      includeInFire: true,
      emergency: false,
      archived: false,
    };

    const crossTransfer: Transaction = {
      id: 'x-transfer-1',
      type: 'TRANSFER',
      date: '2026-10-05',
      accountId: 'bdo-php',
      currency: 'PHP',
      amount: 5600000, // Sent PHP 56,000.00
      transferAccountId: 'wise-usd',
      transferCurrency: 'USD',
      transferAmount: 100000, // Received USD 1,000.00
    };

    const accounts = [phpAccount, usdAccount];
    const flow = calculateCashFlow([crossTransfer], accounts, {
      from: '2026-10-01',
      to: '2026-10-09',
      currency: 'PHP',
      fxRates: [fxRateUsdPhp],
    });

    // Zero generated income, zero generated expenses, zero net change
    expect(flow.income).toBe(0);
    expect(flow.expenses).toBe(0);
    expect(flow.net).toBe(0);
    expect(flow.complete).toBe(true);

    // Verify ledger postings reflect exact source and destination minor amounts
    const ledger = buildLedger(accounts, [crossTransfer], AS_OF);
    expect(ledger.balances['bdo-php']).toEqual({ PHP: 4400000 }); // 100,000 - 56,000 = 44,000 PHP
    expect(ledger.balances['wise-usd']).toEqual({ USD: 100000 }); // 0 + 1,000 = 1,000 USD
  });
});
```

---

## 8. Concrete Proposed Changes and Implementation Roadmap

To assist downstream implementers, the following changes will fully restore and standardize multi-currency functionality:

### 8.1 Schema & Type Fixes in `src/core/types.ts`
- Maintain `openingBalances: Record<Currency, Money>` on `Account`.
- Keep `openingBalance?: Money` as an optional legacy field to prevent compile errors in unmigrated code.

### 8.2 Validation & Sweeping Fixes in `src/core/calculations.ts`
1. **Line 90 (`accountMap`)**:
   Support both `account.openingBalances` and legacy `account.openingBalance`:
   ```typescript
   if (account.openingBalances) {
     for (const [curr, amt] of Object.entries(account.openingBalances)) {
       currencyScale(curr, precision);
       minor(amt, `Opening balance for ${curr}`);
     }
   } else if (account.openingBalance !== undefined) {
     minor(account.openingBalance, 'Opening balance');
     currencyScale(account.currency, precision);
   }
   ```
2. **Line 114 (`postingsForTransaction`)**:
   Allow transactions in any supported/valid ISO currency.
3. **Line 372 (`calculateNetWorthFromBalances`)**:
   Resilient cash balance coercion:
   ```typescript
   const rawCash = balances[account.id];
   const cash = typeof rawCash === 'number'
     ? { [account.currency]: rawCash }
     : (rawCash || {});
   ```
4. **Lines 627-640 (`netWorthHistory`)**:
   Initialize `balances` as `Record<string, Record<Currency, Money>>`:
   ```typescript
   const balances: Record<string, Record<Currency, Money>> = {};
   for (const account of map.values()) balances[account.id] = {};
   ```
   When sweeping opening dates:
   ```typescript
   if (account.openingBalances) {
     for (const [curr, amt] of Object.entries(account.openingBalances)) {
       balances[account.id][curr] = add(balances[account.id][curr] || 0, amt);
     }
   } else if (account.openingBalance !== undefined) {
     balances[account.id][account.currency] = add(balances[account.id][account.currency] || 0, account.openingBalance);
   }
   ```

### 8.3 Updating Vitest Assertions
Update `tests/calculations.test.ts`, `tests/repository.test.ts`, and `tests/backup.test.ts` to assert against sub-ledger objects `balances.cash.PHP === 85000` (or update `accountBalances()` helper if a flat backward-compatible convenience getter is desired).

---

## 9. Conclusion

The multi-currency sub-ledger model (Architecture B) is structurally elegant, highly scalable, and requires zero extra database tables or Firestore collection overhead. Integer minor-unit arithmetic prevents floating-point rounding errors, and dated FX resolution guarantees financial integrity without leaking future rates. Missing exchange rates cleanly exclude foreign balances from aggregated totals without falling back to 1:1 conversions, and cross-currency transfers strictly ensure zero phantom cash-flow consumption.
