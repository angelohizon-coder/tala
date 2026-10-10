# Handoff Report — Explorer Survey 3

## 1. Observation
1. **R5 (Recurring Rules & Frequencies)**:
   - `src/db/database.ts:12`: `frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual';` — `bi-weekly` is omitted from the type definition.
   - `src/db/repository.ts:263-265`: In `confirmRecurring`, frequency logic only checks `daily`, `weekly`, `monthly`, `quarterly`, `annual`. Bi-weekly is unhandled.
   - `src/pages/LedgerPages.tsx:325`: The `<select>` element in `RecurringForm` only presents:
     ```tsx
     <option value="daily">Daily</option>
     <option value="weekly">Weekly</option>
     <option value="monthly">Monthly</option>
     <option value="custom">Monthly on a chosen day</option>
     <option value="quarterly">Quarterly</option>
     <option value="annual">Annual</option>
     ```
   - `src/pages/Overview.tsx:1-304`: There are zero prompt banners or notifications for overdue or due-today recurring transactions.
   - `src/pages/LedgerPages.tsx:264-266`: In `TransactionsPage`, transactions created from recurring rules (`recurring:${ruleId}:${date}`) display without any visual indicator, badge, or link indicating their recurring rule origin.
2. **R5 (Budgets & Progress Bars)**:
   - `src/pages/LedgerPages.tsx:383`:
     ```tsx
     {summary.percentUsed != null && <progress max={100} value={Math.max(0, Math.min(100, summary.percentUsed))} aria-label="Budget percentage consumed" />}
     ```
   - `src/pages/ledger.css:1`:
     ```css
     .budget-card progress::-webkit-progress-value{background:#277657;border-radius:5px}
     ```
     The progress bar value is strictly clamped to 100 with a static green fill `#277657`. When `summary.percentUsed > 100` or `summary.remaining < 0`, no alert badge, warning banner, or color shift occurs.
3. **R6 (FIRE Journey & Simulation Crash)**:
   - `src/pages/PlanningPages.tsx:71-74`:
     ```tsx
     p10:fromMinor(Math.round(pt.p10),currency),
     p50:fromMinor(Math.round(pt.p50),currency),
     p90:fromMinor(Math.round(pt.p90),currency),
     target:fromMinor(Math.round(targetCompounded),currency)
     ```
   - `src/core/calculations.ts:14-16, 54-56`:
     ```typescript
     function minor(value: number, label = 'Amount'): number {
       requireValue(Number.isSafeInteger(value), `${label} must be an integer in currency minor units.`);
       return value;
     }
     export function fromMinor(value: Money, currency: Currency, precision: Precision = {}): number {
       return minor(value) / currencyScale(currency, precision);
     }
     ```
     `fromMinor` fails and throws `FinanceValidationError` whenever `value` is not a safe integer, such as when Monte Carlo extreme outputs exceed `Number.MAX_SAFE_INTEGER` ($9.007 \times 10^{15}$) or are `NaN`. React catches this in `<Boundary>` (`src/App.tsx:22`) displaying `"This view could not be opened."`
   - `src/workers/fireSimulation.ts:163-166`:
     ```typescript
     const inf = inflationVol === 0 ? expectedInflation : expectedInflation + inflationVol * sampleGaussian();
     const adjustedExpenses = annualExpenses * Math.pow(1 + inf, yr);
     ```
     Compounding raises a single-year draw `inf` to power `yr`. Negative inflation or negative Gaussian draws ($1 + inf < 0$) cause alternating negative spending or `NaN`.
   - `src/pages/PlanningPages.tsx:27`:
     ```tsx
     const projectionReady = netWorth.fireAssets !== null && fire.target !== null;
     ```
     In `src/core/calculations.ts:423-426, 433`, if any foreign currency account marked `includeInFire` lacks an FX conversion to `baseCurrency`, `fireAssets` collapses to `null`, completely disabling the simulation.
4. **R8 (Layout & Footer)**:
   - `src/styles.css:7`:
     ```css
     .app-shell{display:flex;min-height:100vh}
     .workspace{margin-left:236px;width:calc(100% - 236px);min-width:0}
     #page-main{padding:32px 36px 18px;outline:none;max-width:1620px;margin:0 auto}
     .main-footer{display:flex;justify-content:space-between;gap:15px;margin-top:32px;padding:16px 0;font-size:8px;color:#4f5e58}
     ```
     `.workspace` and `#page-main` lack `flex-direction: column` and `flex: 1 0 auto`. On short pages, `#page-main` is under 400px tall and `.main-footer` floats mid-viewport with 500px+ of blank background below.
   - `src/styles.css:89`: Touch targets specify `min-height: 24px; min-width: 24px;` which is below standard mobile touch targets (44px).
5. **Test Harness**:
   - `cmd /c npm test` runs Vitest 5.0.3: **20 test files, 347 passed, 0 failed in 2.12s**.
   - `cmd /c npm run typecheck` passes with 0 errors.
   - `cmd /c npm run build` succeeds in 10.4s, generating PWA service worker and Web Workers.
   - `node tools/finance-browser-check.mjs` runs with `$env:CHROME_PATH="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"` on Windows, failing at step 3 because `TrendIndicator` outputs unary `+₱1,500.00` while test assertion expects exact string `₱1,500.00`.

---

## 2. Logic Chain
1. From Observation 1, `RecurringRule` interface in `database.ts` and `RecurringForm` in `LedgerPages.tsx` do not define `bi-weekly`. Therefore, users cannot schedule bi-weekly transactions.
2. From Observation 1, Overview does not query `recurringRules` for overdue or due-today items. Therefore, users do not receive auto-prompts or confirmation banners for recurring transactions.
3. From Observation 2, `LedgerPages.tsx:383` and `ledger.css:1` clamp progress to 100 with a static green color. Therefore, budgets exceeding 100% fail to display an over-budget alert or warning color.
4. From Observation 3, in `PlanningPages.tsx:71`, trajectory percentiles are mapped through `fromMinor(Math.round(pt.p10))`. `fromMinor` calls `minor()` in `calculations.ts:15`, which throws `FinanceValidationError` when values are not safe integers or `NaN`.
5. From Observation 3, in `fireSimulation.ts:166`, `Math.pow(1 + inf, yr)` compounds a single-year normal rate across `yr` years, which diverges and becomes negative or `NaN` when $1 + inf < 0$. When passed into `fromMinor`, this triggers the unhandled exception, causing `<Boundary>` to catch and render the crash error view.
6. From Observation 4, `.workspace` lacks `display: flex; flex-direction: column; min-height: 100vh`, `#page-main` lacks `flex: 1 0 auto`, and `.main-footer` uses fixed `margin-top: 32px`. On short pages, `#page-main` does not stretch to the bottom of the viewport, causing the footer to float mid-page.
7. From Observation 5, the unit and integration test suite is fully functional (347 tests passing), proving that code changes can be verified quickly and reliably with `npm test`.

---

## 3. Caveats
- No production source code was modified during this survey (in accordance with the explorer read-only constraint).
- The browser acceptance check (`finance-browser-check.mjs`) requires Edge/Chrome executable path configuration on Windows and has an assertion mismatch with `TrendIndicator` unary `+` sign.
- Firebase remote sync endpoints were verified locally via unit mocks and security rule tests, but live cloud synchronization depends on active Google credentials and Firestore quotas.

---

## 4. Conclusion
1. **R5 (Budget & Recurring Rules)** requires:
   - Adding `'bi-weekly'` to `RecurringRule.frequency` and implementing 14-day cadence in `confirmRecurring`.
   - Creating a `RecurringDueBanner` component on `Overview` and `BudgetsPage` for overdue/due-today rules.
   - Linking confirmed transactions with a visual "Recurring" badge in `TransactionsPage`.
   - Redesigning budget progress bars with amber ($\ge 85\%$) and red ($> 100\%$) alert states.
2. **R6 (FIRE Journey & Simulation)** requires:
   - Replacing direct `fromMinor(Math.round(val))` on simulation outputs with a safe numeric formatting helper that clamps non-safe integers and guards against `NaN`.
   - Correcting multi-year inflation compounding in `fireSimulation.ts` to accumulate inflation year-by-year (`cumulativeInflation *= Math.max(0.001, 1 + inf)`).
   - Adding a closed-form deterministic projection trajectory to the chart.
   - Making FIRE asset valuation resilient when foreign currency FX rates are missing.
3. **R8 (Layout & Mobile Responsiveness)** requires:
   - Setting `.workspace` to `display: flex; flex-direction: column; min-height: 100vh;`, `#page-main` to `flex: 1 0 auto; display: flex; flex-direction: column;`, and `.main-footer` to `margin-top: auto`.
   - Increasing mobile interactive touch targets to 44px minimum.

---

## 5. Verification Method
1. **Unit and Integration Tests**:
   ```bash
   cmd /c npm test
   ```
   All 20 test files must pass.
2. **Typecheck**:
   ```bash
   cmd /c npm run typecheck
   ```
   Must pass with 0 errors.
3. **Production Build**:
   ```bash
   cmd /c npm run build
   ```
   Must produce `dist/` bundle with PWA and Web Worker assets.
4. **Code Inspection**:
   - Inspect `src/pages/PlanningPages.tsx:67-76` to ensure trajectory mapping handles extreme values without throwing `FinanceValidationError`.
   - Inspect `src/styles.css:7` and `src/App.tsx` to verify flex column layout and pinned footer behavior.
   - Inspect `src/db/database.ts:12` and `src/db/repository.ts:263` for `bi-weekly` support.
