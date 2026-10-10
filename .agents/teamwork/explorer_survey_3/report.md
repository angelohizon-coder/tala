# Technical Survey & Codebase Investigation Report
**Explorer Survey 3**: Features, Calculations & UI Explorer (R5, R6, R8 & Test Harness)  
**Date**: 2026-10-10  
**Project**: Tala Personal Finance SPA (`e:/Visual Studio Code/tala`)  
**Investigator**: Survey Explorer 3 (`.agents/teamwork/explorer_survey_3/`)  

---

## 1. Executive Summary

A comprehensive investigation of the Tala codebase was conducted to diagnose issues, evaluate existing architectures, and design technical solutions for:
- **R5: Budget & Recurring Rules Redesign** (recurring rules engine, frequency settings, prompt/confirmation banners, budget targets, progress bars, over-budget alerts)
- **R6: FIRE Journey Bug Fix & Simulation Stability** (root cause analysis of FIRE page runtime error/crash, stochastic Monte Carlo and deterministic calculation errors, multi-currency support)
- **R8: Modern UI/UX, Footer & Mobile Responsiveness** (pinned footer sticky/flex layout, 390px mobile responsiveness, touch targets, theme, existing test setup and test execution)

### Key Survey Discoveries:
1. **R5 (Budget & Recurring Rules)**:
   - The database interface `RecurringRule` in `src/db/database.ts:12` only permits `'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual'`. **`bi-weekly` is completely missing** from both types and recurrence math in `src/db/repository.ts`.
   - **No auto-prompt or confirmation banners** exist on the Overview or Budgets pages. Recurring rules are buried at the bottom of `/budgets`.
   - Transactions generated from confirmed recurring rules (IDs starting with `recurring:`) lack visual indicators or links connecting them back to their source rule in `TransactionsPage`.
   - Budget progress bars in `src/pages/LedgerPages.tsx:383` use a standard HTML `<progress>` capped at 100 with a static green fill (`#277657`). There are **no over-budget alerts or warning styles** when spending exceeds 100%.

2. **R6 (FIRE Journey & Simulation)**:
   - **Root Cause of Crash**: In `src/pages/PlanningPages.tsx:71-74`, Monte Carlo trajectory percentiles (`p10`, `p50`, `p90`) and inflation targets are converted via `fromMinor(Math.round(val), currency)`. `fromMinor` invokes `minor()` in `src/core/calculations.ts:15`, which throws `FinanceValidationError` whenever a value is not a safe integer (`Number.isSafeInteger`). In fat-tailed simulations (Student's t with $\nu = 5$), extreme values or NaN/Infinity trigger an unhandled exception, crashing the React component tree into the `<Boundary>` fallback.
   - **Mathematical Flaw in Inflation**: In `src/workers/fireSimulation.ts:166`, annual expenses are multiplied by `Math.pow(1 + inf, yr)` using a single-year sampled inflation rate `inf` as the base. This causes extreme instability in outer years, negative bases if `1 + inf < 0`, and NaN.
   - **Missing Deterministic Engine**: The page only runs a 5,000-iteration stochastic Monte Carlo simulation. There is no deterministic retirement projection option or trajectory.
   - **Multi-Currency Fragility**: If any asset marked `includeInFire` has a foreign currency without a cached FX rate, `calculateNetWorthFromBalances` sets `fireAssets` to `null`, completely disabling FIRE projections. Furthermore, switching base currency clears `annualSpending` and `monthlyContribution` to 0.

3. **R8 (Layout, Footer & Mobile Responsiveness)**:
   - **Footer Floating Mid-Page**: In `src/App.tsx`, `.workspace` and `#page-main` lack `display: flex; flex-direction: column; min-height: 100vh; flex: 1`. `<footer className="main-footer">` uses a static `margin-top: 32px` inside `#page-main`. On views with short content, the footer floats at ~420px height with massive empty white space beneath it.
   - **Mobile Responsiveness (390px)**: Multiple touch targets are 24px–30px (below the recommended 44px minimum). Tables (`.data-table`) have hardcoded `min-width: 850px` requiring horizontal scroll handling. Dialog modals on 390px screens have narrow padding constraints.
   - **Theme & Design System**: Tailwind CSS 3.4.4 with Tala Forest Green (`#173c34`), DM Sans, and Manrope fonts. Reduced-motion preferences are supported.

4. **Test Harness & Execution**:
   - `npm test` runs Vitest across 20 test files, **347 tests passing in 2.12s**.
   - `npm run typecheck` passes with 0 errors.
   - `npm run build` bundles client, service worker (PWA), and dedicated Web Workers cleanly.
   - Browser verification (`tools/finance-browser-check.mjs`) runs with Microsoft Edge/Chrome on Windows, but contains an assertion discrepancy: `TrendIndicator` outputs unary `+₱1,500.00` (for WCAG 1.4.1 compliance), while the browser script expects exact string `₱1,500.00`.

---

## 2. Requirement R5: Budget & Recurring Rules Redesign

### 2.1 Codebase Architecture & File Locations
- **Data Model & Schema**: `src/db/database.ts` (lines 11–15, 30, 46)
- **Repository Operations**: `src/db/repository.ts` (lines 251–267)
- **UI Components & Forms**: `src/pages/LedgerPages.tsx`
  - `BudgetsPage` (lines 357–390)
  - `BudgetForm` (lines 274–293)
  - `RecurringSection` (lines 338–355)
  - `RecurringForm` (lines 295–336)
- **Calculations Engine**: `src/core/calculations.ts`
  - `calculateBudget` (lines 579–596)
  - `periodBounds` (lines 557–566)
- **Styles**: `src/pages/ledger.css` (lines 1–5), `src/styles.css`

### 2.2 Recurring Rules Engine Survey

#### Current Interface and Type Restrictions
In `src/db/database.ts:11-15`:
```typescript
export interface RecurringRule extends Entity {
  name: string;
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual';
  startDate: string;
  nextDate: string;
  monthlyDay?: number;
  endDate?: string;
  active: boolean;
  template: Omit<Transaction, keyof Entity | 'date'> & { date?: string };
}
```
**Findings & Deficiencies**:
1. **Missing `bi-weekly` frequency**: The user specification explicitly mandates `daily`, `weekly`, `bi-weekly`, `monthly`, and `annual`. Neither `RecurringRule.frequency` nor `RecurringForm` support bi-weekly schedules (every 14 days / fortnight).
2. **Frequency Selector**: In `src/pages/LedgerPages.tsx:325`, the options are `Daily`, `Weekly`, `Monthly`, `Monthly on a chosen day`, `Quarterly`, `Annual`. The "custom" option is only day-of-month, not flexible interval cadence.
3. **Next Due Date Math in Repository**: In `src/db/repository.ts:262-265`:
   ```typescript
   const next = new Date(`${date}T12:00:00Z`);
   if (rule.frequency === 'daily' || rule.frequency === 'weekly')
     next.setUTCDate(next.getUTCDate() + (rule.frequency === 'daily' ? 1 : 7));
   else {
     const day = rule.monthlyDay ?? next.getUTCDate(),
       increase = rule.frequency === 'monthly' ? 1 : rule.frequency === 'quarterly' ? 3 : 12;
     next.setUTCDate(1);
     next.setUTCMonth(next.getUTCMonth() + increase);
     const maximum = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
     next.setUTCDate(Math.min(day, maximum));
   }
   ```
   - Lacks handling for `bi-weekly` (`next.setUTCDate(next.getUTCDate() + 14)`).
   - If a rule was due multiple periods in the past, confirming it only increments by 1 cycle, leaving the rule still overdue in the past rather than offering an option to catch up to today.

#### Confirmation Flow & Missing Banners
- **No auto-prompt banners on Overview or top of Budgets**:
  - In `src/pages/Overview.tsx`, there is zero awareness of overdue or due-today recurring rules.
  - In `src/pages/LedgerPages.tsx:346-350`, rules are rendered in a flat list `.recurring-list` inside `.recurring-section` at the very bottom of the Budgets page.
  - If a user has 3 bills due today, they receive no alert or actionable prompt banner when opening the application.
- **Cryptic Confirmation Errors**:
  - If a rule has `endDate` and `date > rule.endDate`, `confirmRecurring` throws: `'Occurrence is outside the rule dates.'`
  - If the rule version modified during sync: `'Recurring rule changed; review the occurrence again.'`
  - In `RecurringSection:349`, the button is disabled if status is `'Paused'` or `'Ended'`, but with no tooltip or inline reason why.

#### Transaction Linking Deficiencies
- When a recurring rule is confirmed, `confirmRecurring` creates a transaction with ID `recurring:${ruleId}:${date}` and adds a record in `recurringOccurrences`.
- However:
  - In `src/pages/LedgerPages.tsx:264-266` (`TransactionsPage`), there is no badge indicating "Recurring" or linking back to the recurring rule.
  - The transaction description merely shows the merchant/notes with no reference to the parent rule.
  - Users cannot filter transactions by recurring origin or jump from a recurring rule to its history of confirmed transactions.

### 2.3 Budget System Survey

#### Current Implementation & Calculation
In `src/core/calculations.ts:579-596`:
`calculateBudget` accepts a `Budget`, computes period bounds via `periodBounds(budget.period, budget.periodType)`, filters transactions for accepted category descendants, and runs `calculateCashFlow`.
It returns:
```typescript
{
  budget: budget.amount,
  spent,
  knownSpent: flow.knownExpenses,
  remaining: spent === null ? null : add(budget.amount, -spent),
  percentUsed: spent === null || budget.amount === 0 ? null : spent / budget.amount * 100,
  projectedSpend: spent === null ? null : elapsed === 0 ? 0 : rounded(spent * days / elapsed),
  complete: spent !== null,
  issues: flow.issues
}
```

#### Deficiencies in Budgets:
1. **Static Progress Bar without Alert States**:
   In `src/pages/LedgerPages.tsx:383`:
   ```tsx
   {summary.percentUsed != null && (
     <progress
       max={100}
       value={Math.max(0, Math.min(100, summary.percentUsed))}
       aria-label="Budget percentage consumed"
     />
   )}
   ```
   In `src/pages/ledger.css:1`:
   ```css
   .budget-card progress::-webkit-progress-value { background: #277657; border-radius: 5px; }
   ```
   - When spending reaches 100% or exceeds 100% (e.g. 140%), the progress bar remains clamped at 100 and stays solid Tala green (`#277657`).
   - There is no color transition (e.g. green $\to$ amber at 85% $\to$ red over 100%).
   - There is no "Over budget" warning banner, alert icon, or badge on the card.
2. **Year/Period Navigation & Target Creation**:
   - `BudgetsPage` displays budgets filtered by year: `budget.period.startsWith(year)`.
   - Creating monthly budgets for each month is repetitive; there is no "copy previous month", "apply to all remaining months of the year", or automatic monthly target calculation from an annual category target.
3. **Incomplete FX Handling**:
   - When a category has transactions in a foreign currency without an FX rate, `summary.complete` is false, and spending/remaining amounts collapse to `null`, displaying a generic error message with no quick action to add the rate.

### 2.4 Technical Recommendations for R5
1. **Extend `RecurringRule` & Repository**:
   - Update `frequency` type: `'daily' | 'weekly' | 'bi-weekly' | 'monthly' | 'quarterly' | 'annual'`.
   - Update `confirmRecurring` in `src/db/repository.ts` to support `bi-weekly` by adding 14 days.
   - Add catch-up logic: if confirming an overdue date, allow setting `nextDate` directly to the next upcoming future due date.
2. **Introduce Recurring Confirmation Banners**:
   - Create a reusable `RecurringDueBanner` component displayed at the top of `Overview` and `BudgetsPage`.
   - Scan for rules with `nextDate <= today()` and `active: true`.
   - Provide 1-click "Confirm", "Snooze / Remind tomorrow", or "Skip occurrence" actions directly in the banner.
3. **Link Transactions to Recurring Rules**:
   - Store `recurringRuleId` on `Transaction` (or detect ID format `recurring:${ruleId}:${date}`).
   - Render a "Recurring" badge with calendar icon in `TransactionsPage` that filters or navigates to the rule.
4. **Redesign Budget Cards with Over-Budget Alerting**:
   - Replace standard HTML `<progress>` with a modern styled multi-segment or custom progress bar that:
     - Turns warning amber at $\ge 85\%$.
     - Turns danger red (`#9c3832`) at $> 100\%$ with an explicit `Over budget by <Amount>` alert badge and pulsing warning indicator.
   - Add annual-to-monthly target distribution and quick duplicate actions in `BudgetForm`.

---

## 3. Requirement R6: FIRE Journey Bug Fix & Simulation Stability

### 3.1 Codebase Architecture & File Locations
- **Page Component**: `src/pages/PlanningPages.tsx` (`FirePage`, lines 18–91)
- **Simulation Worker Client**: `src/workers/fireSimulation.ts` (lines 1–338)
- **Web Worker Entry Point**: `src/workers/monteCarlo.worker.ts` (lines 1–28)
- **Core Calculations**: `src/core/calculations.ts`
  - `calculateFire` (lines 542–555)
  - `calculateNetWorthFromBalances` (lines 377–437)
  - `fromMinor` / `toMinor` / `minor` (lines 14–16, 51–56)
  - `convertMoney` (lines 75–81)
- **Finance Hook**: `src/ui/useFinance.ts` (lines 38–112)
- **Tests**: `tests/monte-carlo.test.ts` (lines 1–357), `tests/calculations.test.ts` (lines 259–268)

### 3.2 Root Cause Analysis of FIRE Page Runtime Crash

#### Primary Crash Trigger: `fromMinor` SafeInteger Exception
In `src/pages/PlanningPages.tsx:67-76`:
```typescript
const trajectories = simulation?.trajectories.map((pt, idx) => {
  const targetCompounded = (fire.target ?? 0) * Math.pow(1 + (settings.inflationAssumption ?? 0.03), idx);
  return {
    year: currentYear + pt.year,
    p10: fromMinor(Math.round(pt.p10), currency),
    p50: fromMinor(Math.round(pt.p50), currency),
    p90: fromMinor(Math.round(pt.p90), currency),
    target: fromMinor(Math.round(targetCompounded), currency),
  };
}) ?? [];
```
And in `src/core/calculations.ts:14-16, 54-56`:
```typescript
function minor(value: number, label = 'Amount'): number {
  requireValue(Number.isSafeInteger(value), `${label} must be an integer in currency minor units.`);
  return value;
}
export function fromMinor(value: Money, currency: Currency, precision: Precision = {}): number {
  return minor(value) / currencyScale(currency, precision);
}
```
**Mechanism of Failure**:
1. In `runFireSimulation`, simulated wealth `currentAssets` is computed across 5,000 iterations for 40 years.
2. In Student's t distribution with fat tails ($\nu = 5$), high volatility ($16\%$), and compounded returns over 40 years, optimistic runs in `p90` can reach orders of magnitude higher than starting capital.
3. If `pt.p90`, `pt.p50`, or `targetCompounded` exceeds `Number.MAX_SAFE_INTEGER` ($9.007 \times 10^{15}$), OR if any run produces `NaN` or `Infinity`, `Math.round(value)` results in a non-safe integer or `NaN`.
4. `fromMinor` immediately invokes `minor(value)`, which throws:
   `FinanceValidationError: Amount must be an integer in currency minor units.`
5. Because this occurs inside the render function of `FirePage`, the exception is unhandled and caught by React's `<Boundary>` in `src/App.tsx:22`:
   `"This view could not be opened. Your records remain in the local database. Reload to reopen the app."`

#### Secondary Crash Trigger: Inflation Compounding Formulation Flaw
In `src/workers/fireSimulation.ts:163-166`:
```typescript
// Sample inflation
const inf = inflationVol === 0 ? expectedInflation : expectedInflation + inflationVol * sampleGaussian();

// Inflation-adjusted spending
const adjustedExpenses = annualExpenses * Math.pow(1 + inf, yr);
```
**Mechanism of Failure**:
1. `inf` is sampled as a single normal variable for year `yr`.
2. Multiplying `(1 + inf)^yr` applies that single year's rate across all prior `yr` years.
3. If a user sets custom inflation (e.g. deflation or negative inflation $-3\%$), OR if a random Gaussian draw produces $1 + inf < 0$:
   - For odd integer years, `Math.pow(negative, odd)` is negative, making `adjustedExpenses` negative (injecting phantom money into portfolio).
   - If `inf` is ever negative with fractional powers, `Math.pow` yields `NaN`.
4. Compounding should instead accumulate year-over-year:
   $$\text{cumulativeInflation}_t = \text{cumulativeInflation}_{t-1} \times (1 + \text{inf}_t)$$
   $$\text{adjustedExpenses}_t = \text{annualExpenses} \times \text{cumulativeInflation}_t$$

#### Tertiary Crash Trigger: Goal Milestone Target Non-Integer Values
In `src/pages/PlanningPages.tsx:88-90`:
```typescript
{goals?.length ? goals.map(g => {
  const goalCurrency = g.percentage !== undefined ? currency : g.currency;
  const amount = g.percentage !== undefined && fire.target ? Math.round(g.percentage * fire.target) : g.target;
  const baseAmount = convertMoney(amount, goalCurrency, currency, data.fxRates, today(), settings.currencyPrecision);
  ...
```
- If a user created or imported a milestone where `g.target` is not a safe integer (e.g. undefined, null, or floating point), `convertMoney` calls `minor(amount)`, throwing `FinanceValidationError` during render.

### 3.3 Simulation Stability & Multi-Currency Fragility

#### Fragility in Multi-Currency Balances
In `src/ui/useFinance.ts:52, 104-108`:
```typescript
const netWorth = calculateNetWorthFromBalances(accounts, balances, positions, fxRates, settings, end);
...
const fire = calculateFire({
  annualSpending: annual !== null && annual > 0 ? annual : 0,
  withdrawalRate: settings.withdrawalRate,
  fireAssets: netWorth.fireAssets,
  essentialMonthlyExpenses: essentialMonthly ?? undefined,
  emergencyAssets: netWorth.emergencyAssets,
});
```
In `src/core/calculations.ts:423-426, 433`:
```typescript
if (account.includeInFire) {
  const key = liability ? 'fireDebt' : 'fire';
  totals[key] = add(totals[key], amount);
  missing[key] ||= absent;
}
...
fireAssets: missing.fire ? null : totals.fire
```
- If a user has accounts in PHP and USD, and the USD rate is missing or stale, `absent` is true, causing `missing.fire = true`.
- Consequently, `netWorth.fireAssets = null`.
- In `FirePage:27`: `projectionReady = netWorth.fireAssets !== null && fire.target !== null`.
- `projectionReady` becomes false, completely hiding the simulation and fan chart, even though PHP balances are fully known.
- Furthermore, `SettingsPage:265` resets `annualSpending = 0` and `monthlyContribution = 0` whenever `baseCurrency` changes, which turns `fire.target = null`, also disabling the simulation.

#### Missing Deterministic Retirement Projection
- R6 requires: *"Ensure stochastic Monte Carlo calculations and deterministic retirement projection math handle custom inflation, contribution amounts, withdrawal rates..."*
- Currently, Tala only runs the stochastic Web Worker simulation.
- There is no deterministic projection trajectory calculated or displayed (e.g. constant return and constant inflation benchmark curve).
- When users enter 0 volatility, the worker runs 5,000 identical iterations redundantly instead of using closed-form deterministic math.

### 3.4 Technical Recommendations for R6
1. **Safe Trajectory Mapping**:
   - In `PlanningPages.tsx`, sanitize simulation results before calling `fromMinor`.
   - Check `Number.isFinite(val)` and clamp between `0` and `Number.MAX_SAFE_INTEGER`.
   - Format values directly as major currency units without passing through strict `minor()` safe-integer assertions on simulation outputs.
2. **Correct Multi-Year Inflation Compounding**:
   - In `fireSimulation.ts`, track cumulative inflation per iteration path:
     `cumulativeInflation *= Math.max(0.001, 1 + inf)`.
   - Ensure `1 + r` is clamped $\ge 0$ and inflation base is never negative.
3. **Add Deterministic Compounding Mode & Benchmark Trajectory**:
   - Calculate deterministic projection curve:
     $$A_t = A_{t-1} \times (1 + r_{\text{nominal}}) + C - E \times (1 + i)^t$$
   - Plot this deterministic trajectory as an explicit baseline alongside P10, P50, and P90 fan bands.
   - If return volatility is 0, skip 5,000 iterations and return the deterministic trajectory instantly.
4. **Resilient Multi-Currency Valuation**:
   - In `useFinance.ts` and `calculateNetWorthFromBalances`, provide fallback valuation using known base accounts rather than nullifying all FIRE assets when an FX rate is pending.
   - Guard milestone goals rendering against undefined or invalid targets.

---

## 4. Requirement R8: Modern UI/UX, Footer Positioning & Mobile Responsiveness

### 4.1 Layout Structure & The Floating Footer Bug

#### Root Cause Analysis
In `src/App.tsx:35`:
```tsx
<div className="app-shell">
  <aside className={`sidebar ${menu ? 'open' : ''}`}>...</aside>
  <div className="workspace">
    <header className="topbar">...</header>
    <main id="page-main" key={locationState.pathname} className="page-transition" tabIndex={-1}>
      <Boundary>
        <Routes>...</Routes>
      </Boundary>
      <footer className="main-footer">...</footer>
    </main>
  </div>
</div>
```
In `src/styles.css:7`:
```css
.app-shell { display: flex; min-height: 100vh; }
.workspace { margin-left: 236px; width: calc(100% - 236px); min-width: 0; }
#page-main { padding: 32px 36px 18px; outline: none; max-width: 1620px; margin: 0 auto; }
.main-footer { display: flex; justify-content: space-between; gap: 15px; margin-top: 32px; padding: 16px 0; font-size: 8px; color: #4f5e58; }
```
**Mechanism of the Bug**:
1. `.app-shell` is `min-height: 100vh`, but `.workspace` is an unconstrained block child without `min-height: 100vh` or `display: flex; flex-direction: column`.
2. `#page-main` does not have `flex: 1 0 auto`. It collapses to the height of its inner route content.
3. When viewing pages with short content (e.g. empty accounts, short forms, or on large desktop screens), `#page-main` only measures ~300px–400px high.
4. `.main-footer` is placed inside `#page-main` with `margin-top: 32px`.
5. As a result, the footer renders directly below the short content—floating in the middle of the viewport with 500px+ of blank background below it.

#### Solution Architecture: Pinned Sticky/Flex Footer
To permanently eliminate floating footers across all viewports and screen heights:
```css
.workspace {
  margin-left: 236px;
  width: calc(100% - 236px);
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

#page-main {
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 1620px;
  margin: 0 auto;
  padding: 32px 36px 18px;
}

/* Ensure Boundary/Content takes remaining vertical space */
#page-main > div:first-child,
#page-main > .page-transition {
  flex: 1 0 auto;
}

.main-footer {
  margin-top: auto; /* Pushes footer to viewport bottom when content is short */
  display: flex;
  justify-content: space-between;
  gap: 15px;
  padding: 24px 0 16px;
}
```

### 4.2 Mobile Responsiveness Survey (390px Viewport)

#### 1. Touch Targets (WCAG 2.5.8 & Ergonomics)
- In `src/styles.css:89-92`:
  ```css
  button, a, input, select, textarea, [role="button"], [role="menuitem"], [role="tab"], [tabindex="0"] {
    min-height: 24px;
    min-width: 24px;
  }
  ```
  - While 24px satisfies the bare minimum WCAG 2.5.8 Level AA criterion, modern mobile standards (iOS Human Interface Guidelines, Android Material Design) require a **44px $\times$ 44px** or **48px $\times$ 48px** touch target.
  - Buttons like `.ledger-page .button.icon` (`min-width: 30px`, `padding: 7px`), `.table-actions button` (`min-height: 28px`), and `.metric-link` are difficult to tap accurately on mobile screens without mis-taps.

#### 2. Horizontal Scrolling & Content Overflow
- In `src/pages/ledger.css:1`:
  ```css
  .ledger-page .data-table { width: 100%; border-collapse: collapse; min-width: 850px; }
  ```
  - While wrapped in `.table-scroll`, wide data tables require smooth momentum scrolling (`-webkit-overflow-scrolling: touch;`) and visual scroll indicators.
  - On 390px screens, the filter bars in `TransactionsPage` (8 grid fields) take substantial vertical space.

#### 3. Modal Dialogs on 390px Screens
- In `src/styles.css:7`:
  ```css
  .dialog {
    width: min(630px, calc(100vw - 28px));
    max-height: calc(100dvh - 40px);
    padding: 27px;
  }
  ```
  - On 390px viewports, `100vw - 28px = 362px`. With `padding: 27px`, the usable form width is only `308px`.
  - At `@media(max-width: 600px)`: `padding` reduces to `23px 19px`, which fits, but full-screen bottom sheet drawers on mobile provide significantly better mobile ergonomics than centered floating dialogs.

#### 4. Navigation Drawer
- On mobile ($< 820\text{px}$), the sidebar translates off-screen (`translateX(-100%)`) and opens when clicking the hamburger button.
- Lacks touch drag-to-dismiss gesture.
- A mobile bottom navigation bar for core views (Overview, Transactions, Accounts, Budgets) would dramatically improve mobile one-handed usability.

### 4.3 Design System & Theme Alignment
- **Typography**: DM Sans (body, numbers) and Manrope (headings, brand). Tabular numbers are enforced with `font-variant-numeric: tabular-nums`.
- **Palette**: Tala Forest Green `#173c34`, mint `#c5e3c9`, sage `#87b095`, financial gain `#1f664a`, financial loss `#9c3832`, neutral `#4f5e58`.
- **Contrast**: Complies with WCAG AAA for brand forest green on white ($> 12:1$) and WCAG AA for secondary text on surfaces ($> 5.8:1$).
- **Motion**: Keyframes in `styles.css` with zero-motion overrides when `data-reduced-motion="true"`.

---

## 5. Existing Test Harness & Test Execution

### 5.1 Test Suite Inventory
The test harness uses **Vitest 5.0.3** configured in `vitest.config.ts`.
Running `cmd /c npm test`:
- **Files**: 20 passed (20)
- **Tests**: 347 passed (347)
- **Duration**: ~2.12s

| Test File | Test Focus & Scope |
|---|---|
| `accessibility-reduced-motion.test.ts` | CSS keyframe disabling, transition resets, reduced motion hooks |
| `adversarial-tier5-hardening.test.ts` | Market quote caching, stale quote serving, error preservation |
| `backup.test.ts` | JSON exports, AES-GCM encryption/decryption, schema restoration |
| `calculations.test.ts` | Financial ledger postings, cash flows, net worth, FIRE, amortization |
| `challenger-audio-adversarial.test.ts` | Sound synthesis, audio context mock safety, mute states |
| `challenger-financial-integrity.test.ts` | Multi-currency transfers, zero-net-flow invariants, rounding limits |
| `challenger-m2-adversarial.test.ts` | Precision rounding attacks, micro-transactions, sub-ledger integrity |
| `challenger-motion-stress.test.ts` | Rapid route changes, animation abort safety, DOM stability |
| `challenger-sync-adversarial.test.ts` | Outbox ordering, conflict detection, offline queuing |
| `csv.test.ts` | Statement parsing, auto column mapping, debit/credit parsing |
| `financial-integrity.test.ts` | Double-entry invariant, balance sheet reconciliations |
| `firestore-adversarial.test.ts` | Firestore mock synchronization, network partitions |
| `firestore-rules.test.ts` | Security rules evaluation for Firestore collections |
| `market-gateway.test.ts` | Cloud function proxying, quota bounds, provider failover |
| `ml-categorization.test.ts` | In-browser Naive Bayes transaction categorizer |
| `monte-carlo.test.ts` | Student's t sampling, kurtosis, SE convergence, trajectory bounds |
| `repository.test.ts` | Dexie database repository operations, atomic transactions |
| `sound-mute.test.ts` | Web Audio sound player muting and local preferences |
| `sync.test.ts` | Dexie $\leftrightarrow$ Firestore two-way sync engine |
| `ui-accessibility.test.ts` | WCAG contrast, honest empty states, trend indicators, focus rings |

### 5.2 Build & Typecheck Scripts
- `npm run typecheck` (`tsc --noEmit`): Compiles TypeScript 7.0.2 with 0 errors.
- `npm run build` (`tsc --noEmit && vite build`): Bundles production assets into `dist/`, compiling service worker and Web Workers.

### 5.3 Browser Acceptance Runner (`tools/finance-browser-check.mjs`)
- Uses Playwright to run 15 end-to-end browser user journeys.
- **Windows Path Requirement**: Playwright looks for Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`. On Windows systems where Google Chrome is not installed at that exact path, setting the environment variable `CHROME_PATH="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"` allows Playwright to run using Microsoft Edge.
- **Known Test Discrepancy**:
  - In journey 3 (`income, expense, transfer and credit-card payment reconcile`), line 401:
    `await expect(page.locator('.mini-stat-row').getByText(minorMoney(150000), { exact: true })).toBeVisible();`
  - In `Overview.tsx:116-122`, this field renders via `<TrendIndicator value={...} />`.
  - In `TrendIndicator.tsx:88`, positive numbers render with an explicit unary plus sign: `+₱1,500.00` (required for WCAG 1.4.1 compliance in `ui-accessibility.test.ts`).
  - Because `minorMoney(150000)` produces `'₱1,500.00'` without `+`, exact matching fails. Updating the check to accept `+` or using regex `/^\+?₱1,500\.00$/` resolves the test discrepancy.

---

## 6. Implementation & Test Plan Recommendations

### 6.1 Recommendations for R5 (Budget & Recurring Rules)
1. **Database Schema & Types (`src/db/database.ts`)**:
   - Add `'bi-weekly'` to `RecurringRule.frequency`.
   - Update `confirmRecurring` in `src/db/repository.ts` to calculate 14-day intervals for bi-weekly rules.
2. **Auto-Prompt / Confirmation Banners**:
   - Create `RecurringPromptBanner` component.
   - Display at top of `Overview` and `BudgetsPage` whenever active rules have `nextDate <= today()`.
   - Provide direct "Confirm" action with immediate transaction creation.
3. **Budget Progress Bars & Over-Budget Alerts**:
   - Style budget cards with dynamic progress bar colors:
     - Tala Green (`#1f664a`) when spending $< 85\%$
     - Amber (`#84692e`) when $85\% \le \text{spending} \le 100\%$
     - Dark Red (`#9c3832`) when $> 100\%$
   - Add explicit "Over budget by <Amount>" alert chip and visual banner.
4. **Transaction Linking**:
   - Add a "Recurring" badge to transaction rows in `TransactionsPage` if `id.startsWith('recurring:')`.

### 6.2 Recommendations for R6 (FIRE Journey & Simulation Stability)
1. **Trajectory Sanitization**:
   - Guard `fromMinor` calls in `PlanningPages.tsx:71-74` against `NaN`, `Infinity`, or values $> \text{MAX\_SAFE\_INTEGER}$.
   - Add safe value formatting helper that clamps and handles floating point simulation artifacts gracefully.
2. **Correct Multi-Year Inflation Compounding**:
   - Update `fireSimulation.ts` to accumulate inflation year-by-year (`cumulativeInflation *= Math.max(0.001, 1 + inf)`) rather than raising a single-year normal draw to power `yr`.
3. **Deterministic Projection Mode**:
   - Compute deterministic retirement curve directly in closed form:
     $A_t = A_{t-1} \times (1 + r) + C - E \times (1 + i)^t$.
   - Display deterministic path on the chart and provide user toggle between stochastic Monte Carlo and deterministic projection.
4. **Multi-Currency Robustness**:
   - In `useFinance.ts`, ensure missing foreign currency rates do not wipe out all known base FIRE assets.

### 6.3 Recommendations for R8 (Modern UI/UX & Responsive Layout)
1. **Pin Footer with Flex Column**:
   - Update `.workspace` to `display: flex; flex-direction: column; min-height: 100vh`.
   - Update `#page-main` to `flex: 1 0 auto; display: flex; flex-direction: column`.
   - Update `.main-footer` to `margin-top: auto`.
2. **Mobile Touch Ergonomics (390px)**:
   - Increase interactive touch targets to 44px minimum for primary action buttons.
   - Ensure horizontal table containers have clear scroll styling.
3. **Verify via Test Suite**:
   - Ensure `npm test`, `npm run typecheck`, and `npm run build` pass with zero regressions.
