# Handoff Report: Core Currency & FX Engine (Milestone 1)

**From**: Explorer M1-1 (Currency Engine & Calculations Explorer)  
**To**: Orchestrator / Milestone 1 Implementers  
**Working Directory**: `e:/Visual Studio Code/tala/.agents/teamwork/explorer_m1_1/`  
**Report Reference**: `e:/Visual Studio Code/tala/.agents/teamwork/explorer_m1_1/report.md`  

---

## 1. Observation

1. **`src/core/calculations.ts:58-74`**:
   `getFxRate(from, to, rates, asOf)` only inspects direct and inverse pairs:
   ```typescript
   const isDirect = rate.fromCurrency === from && rate.toCurrency === to;
   const isInverse = rate.fromCurrency === to && rate.toCurrency === from;
   ```
   Lines 72-73 return direct or inverse rate, or `null`. No intermediate vehicle or triangular routing is implemented.

2. **`src/core/calculations.ts:398-436`**:
   `calculateNetWorthFromBalances()` sets `incomplete = true` on line 399 and line 410 when `convertMoney()` returns `null`. On line 430:
   ```typescript
   netWorth: assets === null || liabilities === null ? null : add(assets, -liabilities),
   knownAssets: totals.assets, knownLiabilities: totals.liabilities, knownNetWorth: add(totals.assets, -totals.liabilities),
   complete: !Object.values(missing).some(Boolean), issues, accountValues,
   ```
   `knownNetWorth` properly accumulates all convertible balances in `settings.baseCurrency`. However, `NetWorthSummary` does not expose a clean, deduplicated `missingFx: Currency[]` field.

3. **`src/pages/Overview.tsx:87`**:
   ```tsx
   <strong className="metric-value"><Money amount={hasAccounts?netWorth.netWorth:null} currency={currency}/></strong>
   ```
   Because `netWorth.netWorth` is `null` when partial FX is missing, `<Money />` receives `null`.

4. **`src/ui/shared.tsx:8`**:
   ```typescript
   export function formatMoney(amount:number|null|undefined,currency='PHP'){return typeof amount==='number'&&Number.isFinite(amount)?...:'—';}
   ```
   `formatMoney(null)` returns `'—'`.

5. **`tests/calculations.test.ts:227` & `tests/challenger-financial-integrity.test.ts:536`**:
   Existing hardening tests explicitly assert:
   ```typescript
   expect(summary.netWorth).toBeNull();
   expect(summary.complete).toBe(false);
   expect(summary.knownNetWorth).toBe(1000000);
   ```
   Any change setting `netWorth` to non-null on incomplete valuation would break these invariant tests.

6. **Test Suite Baseline**:
   Running `cmd /c npx vitest run`: 19 test files pass, 346 tests pass. Only `tests/monte-carlo.test.ts:260` fails (known M4 tolerance issue). All 31 tests in `tests/calculations.test.ts` pass cleanly.

---

## 2. Logic Chain

1. From Observation 1, if a user has multi-currency accounts (e.g. `PHP` and `EUR`) and standard FX feeds only provide `USD/PHP` and `EUR/USD`, `getFxRate('EUR', 'PHP')` returns `null` because no direct pair exists.
2. From Observation 2, returning `null` forces `calculateNetWorthFromBalances()` to mark `incomplete = true` and `netWorth = null`, even though `knownNetWorth` holds the converted sum of convertible accounts.
3. From Observations 3 and 4, the UI in `Overview.tsx` binds directly to `netWorth.netWorth` instead of `netWorth.knownNetWorth`, causing `formatMoney()` to display `—`.
4. From Observation 5, existing financial integrity tests strictly assert `netWorth === null` and `complete === false` when rates are missing. Therefore, `calculateNetWorthFromBalances()` must **not** force `netWorth` to be non-null when incomplete.
5. Consequently, the complete solution requires:
   - Upgrading `getFxRate()` with 2-hop triangular cross-rate routing pivoting through `USD`, `EUR`, or `PHP` using the latest available rates up to `cutoff`.
   - Augmenting `NetWorthSummary` with `missingFx: Currency[]` so callers receive clean unconvertible currency codes.
   - Coordinating with Explorer M1-2 so `Overview.tsx` renders `netWorth.netWorth ?? netWorth.knownNetWorth` and displays a warning badge when `!netWorth.complete`.

---

## 3. Caveats

- **Scope Boundary**: Explorer M1-1 focused on `src/core/calculations.ts` and `tests/calculations.test.ts`. `Overview.tsx` and `src/db/repository.ts` are explored by M1-2.
- **Hop Count Limit**: Triangular routing is designed for 2-hop paths (`from -> pivot -> to`). Paths requiring 3+ hops are not supported, which is standard practice in personal finance engines given that all supported currencies (`PHP, USD, EUR, GBP, JPY, HKD, CAD, AUD, SGD`) pair directly with `USD` or `PHP`.
- **Assumptions Made**: Rates are positive finite numbers; rates where `deletedAt` is set or timestamp is in the future relative to `asOf` are strictly ignored.

---

## 4. Conclusion

The core currency calculation engine can be made fully resilient and multi-currency capable by:
1. Implementing a non-recursive helper `getDirectOrInverseFxRate()` in `src/core/calculations.ts`.
2. Enhancing `getFxRate()` to search candidate vehicle pivots (`USD`, `EUR`, `PHP`, and active currencies) when single-hop lookup fails, picking the freshest pair by `Math.min(leg1.time, leg2.time)` and prioritizing `USD > EUR > PHP`.
3. Updating `NetWorthSummary` to include `missingFx: Currency[]` extracted from `issues`.
4. Adding comprehensive unit tests in `tests/calculations.test.ts` covering triangular cross-rates, inverse legs, temporal cutoff isolation, and multi-currency portfolio valuation.

All proposed TypeScript code and test specifications are documented in `report.md`.

---

## 5. Verification Method

To verify the proposed implementation once applied:
1. **Run Unit Tests**:
   ```bash
   cmd /c npx vitest run tests/calculations.test.ts
   ```
   All 31 existing tests and new triangular test suites must pass.
2. **Run Challenger Financial Integrity Tests**:
   ```bash
   cmd /c npx vitest run tests/challenger-financial-integrity.test.ts
   ```
   Tests 5.1 through 6.2 must pass without regressions.
3. **Inspect Invalidation Conditions**:
   - If direct rate lookups are superseded by cross-rates, verification fails.
   - If future rates leak across the cutoff date in either leg of triangular routing, verification fails.
   - If `summary.netWorth` is non-null when a rate is genuinely missing, verification fails.
