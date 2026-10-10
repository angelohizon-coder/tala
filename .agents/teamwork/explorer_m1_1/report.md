# Technical Investigation Report: Core Currency & FX Engine (Milestone 1)

**Agent**: Explorer M1-1 (Currency Engine & Calculations Explorer)  
**Target Files**: `src/core/calculations.ts`, `tests/calculations.test.ts`  
**Related UI & DB Components**: `src/pages/Overview.tsx`, `src/db/repository.ts`  
**Date**: 2026-10-10  

---

## 1. Executive Summary

Tala currently implements direct and inverse dated FX rate conversion in `src/core/calculations.ts:getFxRate()`. However:
1. **No Triangular Routing**: `getFxRate(from, to, rates, asOf)` only queries direct (`from -> to`) and inverse (`to -> from`) pairs. If an exchange rate between two currencies (e.g., `EUR` and `PHP`) is not directly quoted, but both currencies have quotes against a common vehicle currency like `USD` (or base currency `PHP`), `getFxRate` returns `null`. This prevents multi-currency accounts and foreign investments from converting to the user's base currency.
2. **Brittle Net Worth Nullification in UI**: In `calculateNetWorthFromBalances()`, any missing FX rate marks `incomplete = true` and sets `netWorth = null`. While `knownNetWorth` correctly aggregates all convertible balances into the base currency, `src/pages/Overview.tsx:87` renders `<Money amount={hasAccounts ? netWorth.netWorth : null} currency={currency}/>`, which forces `formatMoney()` in `src/ui/shared.tsx:8` to output `—` (dash). Furthermore, `NetWorthSummary` lacks a structured, deduplicated `missingFx: Currency[]` field to clearly communicate unconvertible currencies to the UI.

This report specifies the mathematical model, exact TypeScript implementation, edge-case behavior, and test suites for:
1. **Triangular Cross-Rate Routing** in `getFxRate()` pivoting through `USD`, `EUR`, or `PHP` without temporal leakage.
2. **Resilient Net Worth Aggregation & Clean FX Issue Reporting** in `calculateNetWorthFromBalances()` exposing `missingFx: Currency[]` while preserving strict mathematical integrity across existing hardening tests.

---

## 2. Current State Analysis

### 2.1 Existing `getFxRate` Implementation
Located at `src/core/calculations.ts:58-74`:
```typescript
export function getFxRate(from: Currency, to: Currency, rates: readonly FxRate[], asOf = today()): number | null {
  if (from === to) return 1;
  const cutoff = throughDate(asOf);
  let direct: FxRate | undefined, inverse: FxRate | undefined, directTime = -Infinity, inverseTime = -Infinity;
  for (const rate of rates) {
    if (rate.deletedAt || !Number.isFinite(rate.rate) || rate.rate <= 0) continue;
    const isDirect = rate.fromCurrency === from && rate.toCurrency === to;
    const isInverse = rate.fromCurrency === to && rate.toCurrency === from;
    if (!isDirect && !isInverse) continue;
    const time = Date.parse(rate.asOf);
    if (!Number.isFinite(time) || time > cutoff) continue;
    if (isDirect && time > directTime) { direct = rate; directTime = time; }
    if (isInverse && time > inverseTime) { inverse = rate; inverseTime = time; }
  }
  if (direct && directTime >= inverseTime) return direct.rate;
  return inverse ? 1 / inverse.rate : null;
}
```

#### Key Observations:
- **Pair Search Limit**: Single-hop only. Loops through `rates` matching only direct or inverse keys.
- **Precedence**: When both direct and inverse exist, newer timestamp wins; ties favor direct.
- **Sanitization**: Ignores `deletedAt`, non-finite rates, rates `<= 0`, and timestamps `> cutoff`.
- **Limitation**: In global personal finance, rate feeds (Open Exchange Rates, Frankfurter, Bangko Sentral ng Pilipinas) almost never supply full $N \times (N-1)$ currency matrices. They provide pairs against USD (`USD/PHP`, `USD/EUR`, `USD/JPY`) or against the base currency. Any currency not paired directly with the destination currency is unroutable.

### 2.2 Existing `calculateNetWorthFromBalances` Implementation
Located at `src/core/calculations.ts:377-437`:
- For each account, balances in foreign currencies are converted to `account.currency` via `convertMoney()`.
- If `convertMoney()` returns `null`, `incomplete = true` and `issues.push({ code: 'missing_fx', accountId, currency })`.
- `knownValue` aggregates convertible cash + holdings in `account.currency`.
- `knownBase = convertMoney(knownValue, account.currency, settings.baseCurrency, ...)` converts this to base currency.
- If `account.includeInNetWorth`, `totals.assets` or `totals.liabilities` adds `amount = knownBase ?? 0`.
- In line 430:
  ```typescript
  netWorth: assets === null || liabilities === null ? null : add(assets, -liabilities),
  knownNetWorth: add(totals.assets, -totals.liabilities),
  complete: !Object.values(missing).some(Boolean),
  ```
- In existing adversarial tests (`tests/challenger-financial-integrity.test.ts:536`, `tests/calculations.test.ts:227`, `tests/financial-integrity.test.ts:298`), tests assert:
  - `expect(summary.netWorth).toBeNull()`
  - `expect(summary.complete).toBe(false)`
  - `expect(summary.knownNetWorth).toBe(...)` (aggregates convertible portion only)
- Therefore, changing `summary.netWorth` to non-null when incomplete would **break existing core financial integrity tests**.
- The real defect is two-fold:
  1. Lack of cross-rates in `getFxRate` unnecessarily triggers `missing_fx` for multi-currency accounts that could have been resolved via USD/PHP.
  2. `NetWorthSummary` does not surface `missingFx: Currency[]` for clean UI consumption, and `Overview.tsx` incorrectly binds to `netWorth.netWorth` instead of `netWorth.netWorth ?? netWorth.knownNetWorth`.

---

## 3. Triangular Cross-Rate Routing Design

### 3.1 Mathematical Formulation
For a requested currency conversion from source currency $S$ to destination currency $D$:
1. If $S = D$, rate is $1.0$.
2. If direct rate $R(S \to D)$ or inverse rate $R(D \to S)$ exists up to timestamp cutoff $T_{\text{cutoff}}$, rate is:
   $$\text{Rate}(S \to D) = \begin{cases} R(S \to D) & \text{if direct is newest or equal} \\ \frac{1}{R(D \to S)} & \text{if inverse is newest} \end{cases}$$
3. If no single-hop rate exists, evaluate candidate pivot currencies $P \in \mathcal{P}$ where $P \ne S$ and $P \ne D$:
   $$\text{Leg}_1 = \text{Rate}(S \to P), \quad \text{Leg}_2 = \text{Rate}(P \to D)$$
   $$\text{CrossRate}(S \to D) = \text{Leg}_1 \times \text{Leg}_2$$

### 3.2 Pivot Currency Selection Strategy
In FX markets, `USD` is the universal vehicle currency (>88% of turnover), followed by `EUR` and domestic base currencies (`PHP` in Tala).
The algorithm will:
1. Identify all active, valid currencies appearing in `rates` up to $T_{\text{cutoff}}$.
2. Order candidate intermediate pivots:
   - **Tier 1 (Standard vehicle currencies)**: `['USD', 'EUR', 'PHP']` (filtered to those present in `rates`).
   - **Tier 2 (Other observed currencies)**: Any other currency with active rates in the system.
3. For each candidate pivot $P$:
   - Query 1-hop lookup for $S \to P$ (yielding rate $r_1$ and observation time $t_1 \le T_{\text{cutoff}}$).
   - Query 1-hop lookup for $P \to D$ (yielding rate $r_2$ and observation time $t_2 \le T_{\text{cutoff}}$).
   - Effective observation timestamp is $t_{\text{eff}} = \min(t_1, t_2)$.
4. Select the pivot with the highest $t_{\text{eff}}$ (freshest data). In case of identical recency (e.g., same day's snapshot), the Tier 1 priority order (`USD` > `EUR` > `PHP`) acts as the deterministic tie-breaker.

### 3.3 Zero Temporal Leakage & Infinite Recursion Prevention
- **Recursion Guard**: Triangular routing is strictly decoupled from single-hop resolution. A helper function `getDirectOrInverseFxRate(from, to, rates, cutoff)` performs only 1-hop direct/inverse lookups and never calls `getFxRate`.
- **Temporal Integrity**: Both legs must satisfy $\text{time} \le T_{\text{cutoff}}$. No rates from after $T_{\text{cutoff}}$ are examined.
- **Sanitization**: Non-finite numbers, deleted rates (`deletedAt`), and zero/negative rates are rejected in both legs.

---

## 4. Resilient Net Worth & Clean FX Issue Reporting Design

### 4.1 Interface Contract Updates
In `src/core/calculations.ts`, update `NetWorthSummary`:
```typescript
export interface NetWorthSummary {
  assets: Money | null;
  liabilities: Money | null;
  netWorth: Money | null;
  liquidNetWorth: Money | null;
  investableNetWorth: Money | null;
  fireAssets: Money | null;
  emergencyAssets: Money | null;
  knownAssets: Money;
  knownLiabilities: Money;
  knownNetWorth: Money;
  complete: boolean;
  issues: CalculationIssue[];
  accountValues: AccountValue[];
  /** Deduplicated uppercase currency codes that failed conversion. */
  missingFx: Currency[];
}
```

### 4.2 Behavior When Rates are Missing
1. **Mathematical Honesty**: When any asset or liability cannot be converted due to missing FX, `complete` remains `false`, and `netWorth`, `assets`, `liabilities` remain `null`. This preserves 100% compatibility with existing invariant tests (`challenger-financial-integrity.test.ts:536`, `calculations.test.ts:161`).
2. **Resilient Valuation**: `knownAssets`, `knownLiabilities`, and `knownNetWorth` always represent the exact, integer minor-unit sum of all convertible balances.
3. **Structured Diagnostics**: `missingFx` extracts all distinct currencies from `issues` where `code === 'missing_fx'`:
   ```typescript
   const missingFx = Array.from(
     new Set(
       issues
         .filter(i => i.code === 'missing_fx' && i.currency)
         .map(i => i.currency!)
     )
   );
   ```

### 4.3 Handling Edge Cases
- **Zero Amounts (`0`)**: `convertMoney()` explicitly checks `if (amount === 0) return 0;` (line 78), so empty/zero balances never trigger `missing_fx`.
- **Negative Balances**: Supported natively. `minor()` validates safe integers (`Number.isSafeInteger`) without requiring non-negative values. Rounded minor arithmetic preserves sign (`Math.sign(value)`). Overdrawn accounts or liabilities convert to negative values and correctly reduce `knownNetWorth`.
- **Self-Currency Conversions (`from === to`)**: `getFxRate()` returns `1` immediately without searching rates or parsing dates.
- **Disconnected Currencies**: If no direct pair and no valid 2-hop pivot exists, `getFxRate()` returns `null`, and the balance is cleanly omitted from `knownNetWorth` with a `missing_fx` issue logged.

---

## 5. Technical Recommendations & Exact Proposed Code

### 5.1 Proposed Changes to `src/core/calculations.ts`

```typescript
// --- 1. Helper and Pivot Constants (Add above getFxRate) ---

const STANDARD_PIVOT_CURRENCIES: readonly Currency[] = ['USD', 'EUR', 'PHP'];

interface DirectFxObservation {
  rate: number;
  time: number;
}

/** Resolves single-hop direct or inverse FX rate respecting cutoff date. Never recurses. */
function getDirectOrInverseFxRate(
  from: Currency,
  to: Currency,
  rates: readonly FxRate[],
  cutoff: number
): DirectFxObservation | null {
  let direct: FxRate | undefined;
  let inverse: FxRate | undefined;
  let directTime = -Infinity;
  let inverseTime = -Infinity;

  for (const rate of rates) {
    if (rate.deletedAt || !Number.isFinite(rate.rate) || rate.rate <= 0) continue;
    const isDirect = rate.fromCurrency === from && rate.toCurrency === to;
    const isInverse = rate.fromCurrency === to && rate.toCurrency === from;
    if (!isDirect && !isInverse) continue;
    const time = Date.parse(rate.asOf);
    if (!Number.isFinite(time) || time > cutoff) continue;
    if (isDirect && time > directTime) { direct = rate; directTime = time; }
    if (isInverse && time > inverseTime) { inverse = rate; inverseTime = time; }
  }

  if (direct && directTime >= inverseTime) {
    return { rate: direct.rate, time: directTime };
  }
  if (inverse) {
    return { rate: 1 / inverse.rate, time: inverseTime };
  }
  return null;
}

// --- 2. Replacement getFxRate with Triangular Cross-Rate Routing ---

export function getFxRate(from: Currency, to: Currency, rates: readonly FxRate[], asOf = today()): number | null {
  if (from === to) return 1;
  const cutoff = throughDate(asOf);

  // Step 1: Single-hop direct or inverse lookup
  const singleHop = getDirectOrInverseFxRate(from, to, rates, cutoff);
  if (singleHop !== null) return singleHop.rate;

  // Step 2: Triangular cross-rate routing via intermediate pivot currency
  const rateCurrencies = new Set<Currency>();
  for (const rate of rates) {
    if (rate.deletedAt || !Number.isFinite(rate.rate) || rate.rate <= 0) continue;
    const time = Date.parse(rate.asOf);
    if (!Number.isFinite(time) || time > cutoff) continue;
    rateCurrencies.add(rate.fromCurrency);
    rateCurrencies.add(rate.toCurrency);
  }

  // Build candidate pivots prioritizing standard vehicles (USD, EUR, PHP)
  const candidatePivots: Currency[] = [];
  for (const pivot of STANDARD_PIVOT_CURRENCIES) {
    if (pivot !== from && pivot !== to && rateCurrencies.has(pivot)) {
      candidatePivots.push(pivot);
    }
  }
  for (const currency of rateCurrencies) {
    if (currency !== from && currency !== to && !candidatePivots.includes(currency)) {
      candidatePivots.push(currency);
    }
  }

  let bestRate: number | null = null;
  let bestTime = -Infinity;

  for (const pivot of candidatePivots) {
    const leg1 = getDirectOrInverseFxRate(from, pivot, rates, cutoff);
    if (!leg1) continue;
    const leg2 = getDirectOrInverseFxRate(pivot, to, rates, cutoff);
    if (!leg2) continue;

    const effectiveTime = Math.min(leg1.time, leg2.time);
    if (effectiveTime > bestTime) {
      bestTime = effectiveTime;
      bestRate = leg1.rate * leg2.rate;
    }
  }

  return bestRate;
}

// --- 3. Update NetWorthSummary interface & calculateNetWorthFromBalances ---
// In NetWorthSummary interface (around line 374):
//   missingFx: Currency[];

// In calculateNetWorthFromBalances return statement (around line 435):
  const missingFx = Array.from(
    new Set(
      issues
        .filter(i => i.code === 'missing_fx' && i.currency)
        .map(i => i.currency!)
    )
  );

  return {
    assets, liabilities, netWorth: assets === null || liabilities === null ? null : add(assets, -liabilities),
    liquidNetWorth: missing.liquid || liabilities === null ? null : add(totals.liquid, -liabilities),
    investableNetWorth: missing.fire || missing.fireDebt ? null : add(totals.fire, -totals.fireDebt),
    fireAssets: missing.fire ? null : totals.fire, emergencyAssets: missing.emergency ? null : totals.emergency,
    knownAssets: totals.assets, knownLiabilities: totals.liabilities, knownNetWorth: add(totals.assets, -totals.liabilities),
    complete: !Object.values(missing).some(Boolean), issues, accountValues, missingFx,
  };
```

---

## 6. Proposed Test Specifications for `tests/calculations.test.ts`

The following test suites should be added to `tests/calculations.test.ts`:

```typescript
describe('triangular cross-rate FX conversions', () => {
  it('resolves cross-rate via USD when direct pair is missing', () => {
    // EUR -> USD = 1.08, USD -> PHP = 56.0 => EUR -> PHP = 60.48
    const rates: FxRate[] = [
      fx({ id: 'eur-usd', fromCurrency: 'EUR', toCurrency: 'USD', rate: 1.08, asOf: '2026-10-08T00:00:00Z' }),
      fx({ id: 'usd-php', fromCurrency: 'USD', toCurrency: 'PHP', rate: 56.0, asOf: '2026-10-08T00:00:00Z' }),
    ];
    const rate = getFxRate('EUR', 'PHP', rates, '2026-10-09');
    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(60.48, 4);

    // 100 EUR = 6,048 PHP (604,800 minor units)
    expect(convertMoney(10000, 'EUR', 'PHP', rates, '2026-10-09')).toBe(604800);
  });

  it('resolves cross-rate with inverse legs (e.g. PHP/USD and JPY/USD)', () => {
    // Rates quoted relative to USD: USD -> PHP = 56, USD -> JPY = 150
    // PHP -> JPY = (1 / 56) * 150 = 2.67857
    const rates: FxRate[] = [
      fx({ id: 'usd-php', fromCurrency: 'USD', toCurrency: 'PHP', rate: 56.0, asOf: '2026-10-08T00:00:00Z' }),
      fx({ id: 'usd-jpy', fromCurrency: 'USD', toCurrency: 'JPY', rate: 150.0, asOf: '2026-10-08T00:00:00Z' }),
    ];
    const rate = getFxRate('PHP', 'JPY', rates, '2026-10-09');
    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(150 / 56, 4);
  });

  it('prefers direct rate over triangular routing when both are available', () => {
    const rates: FxRate[] = [
      fx({ id: 'eur-usd', fromCurrency: 'EUR', toCurrency: 'USD', rate: 1.08, asOf: '2026-10-08T00:00:00Z' }),
      fx({ id: 'usd-php', fromCurrency: 'USD', toCurrency: 'PHP', rate: 56.0, asOf: '2026-10-08T00:00:00Z' }),
      fx({ id: 'direct-eur-php', fromCurrency: 'EUR', toCurrency: 'PHP', rate: 61.0, asOf: '2026-10-08T00:00:00Z' }),
    ];
    expect(getFxRate('EUR', 'PHP', rates, '2026-10-09')).toBe(61.0);
  });

  it('returns null when intermediate currencies are completely disconnected', () => {
    const rates: FxRate[] = [
      fx({ id: 'eur-usd', fromCurrency: 'EUR', toCurrency: 'USD', rate: 1.08, asOf: '2026-10-08T00:00:00Z' }),
      fx({ id: 'cad-jpy', fromCurrency: 'CAD', toCurrency: 'JPY', rate: 110.0, asOf: '2026-10-08T00:00:00Z' }),
    ];
    expect(getFxRate('EUR', 'JPY', rates, '2026-10-09')).toBeNull();
  });

  it('respects temporal cutoff dates on both legs of triangular routing', () => {
    const rates: FxRate[] = [
      fx({ id: 'eur-usd-old', fromCurrency: 'EUR', toCurrency: 'USD', rate: 1.05, asOf: '2026-10-01T00:00:00Z' }),
      fx({ id: 'eur-usd-new', fromCurrency: 'EUR', toCurrency: 'USD', rate: 1.10, asOf: '2026-10-10T00:00:00Z' }), // Future!
      fx({ id: 'usd-php', fromCurrency: 'USD', toCurrency: 'PHP', rate: 56.0, asOf: '2026-10-05T00:00:00Z' }),
    ];
    // As of 2026-10-06, eur-usd-new is future and must be ignored; eur-usd-old (1.05) is used
    expect(getFxRate('EUR', 'PHP', rates, '2026-10-06')).toBeCloseTo(1.05 * 56.0, 4);
  });
});

describe('resilient multi-currency net worth and missingFx reporting', () => {
  it('populates missingFx with unique unconvertible currency codes', () => {
    const accounts = [
      account('php-acc', { openingBalance: 1000000 }),
      account('gbp-acc', { currency: 'GBP', openingBalance: 50000 }),
      account('chf-acc', { currency: 'CHF', openingBalance: 20000 }),
    ];
    const result = calculateNetWorthFromBalances(
      accounts,
      { 'php-acc': 1000000, 'gbp-acc': 50000, 'chf-acc': 20000 },
      [],
      [],
      { baseCurrency: 'PHP' },
      '2026-10-09'
    );
    expect(result.netWorth).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.knownNetWorth).toBe(1000000);
    expect(result.missingFx).toEqual(expect.arrayContaining(['GBP', 'CHF']));
    expect(result.missingFx).toHaveLength(2);
  });

  it('aggregates multi-currency balances seamlessly via triangular cross-rates', () => {
    const accounts = [
      account('php-acc', { openingBalance: 1000000 }), // PHP 10,000.00
      account('eur-acc', { currency: 'EUR', openingBalance: 10000 }), // EUR 100.00
    ];
    const rates: FxRate[] = [
      fx({ id: 'eur-usd', fromCurrency: 'EUR', toCurrency: 'USD', rate: 1.08, asOf: '2026-10-08T00:00:00Z' }),
      fx({ id: 'usd-php', fromCurrency: 'USD', toCurrency: 'PHP', rate: 56.0, asOf: '2026-10-08T00:00:00Z' }),
    ];
    const result = calculateNetWorthFromBalances(
      accounts,
      { 'php-acc': 1000000, 'eur-acc': 10000 },
      [],
      rates,
      { baseCurrency: 'PHP' },
      '2026-10-09'
    );
    expect(result.complete).toBe(true);
    expect(result.missingFx).toEqual([]);
    // 1,000,000 PHP + 100 EUR * (1.08 * 56.0) = 1,000,000 + 604,800 = 1,604,800
    expect(result.netWorth).toBe(1604800);
    expect(result.knownNetWorth).toBe(1604800);
  });
});
```

---

## 7. Coordination with Explorer M1-2 & UI Recommendations

While Explorer M1-1's boundary is `src/core/calculations.ts`, our investigation directly informs Explorer M1-2's work on `src/pages/Overview.tsx`:
1. In `src/pages/Overview.tsx:87`:
   - Replace:
     ```tsx
     <strong className="metric-value"><Money amount={hasAccounts?netWorth.netWorth:null} currency={currency}/></strong>
     ```
   - With:
     ```tsx
     <strong className="metric-value">
       <Money amount={hasAccounts ? (netWorth.netWorth ?? netWorth.knownNetWorth) : null} currency={currency}/>
     </strong>
     ```
2. When `!netWorth.complete`, render a warning tag or pill:
   ```tsx
   {!netWorth.complete && netWorth.missingFx.length > 0 && (
     <span className="badge warning">
       Partial valuation · Missing FX: {netWorth.missingFx.join(', ')}
     </span>
   )}
   ```
   This guarantees users **never see `—`** for multi-currency accounts, immediately satisfying Acceptance Criteria R1.
