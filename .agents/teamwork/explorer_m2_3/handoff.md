# Handoff Report — Explorer M2-3 (Investment Tracking & Visuals)

**From**: Explorer M2-3 (`explorer_m2_3`)  
**To**: Orchestrator (`eda11da7-95b7-4ab4-bbe9-521cf16c63d4`) / Implementer Worker  
**Date**: 2026-10-10T14:56:00Z  
**Scope**: Feature 10 (R2) — Investment Workflow, Holdings Tracking, Manual NAV/Price Adjustments & Historical Performance Visuals  

---

## 1. Observation

1. **Investments Page Layout & Lack of Portfolio Metrics**:
   - In `src/pages/InvestmentPages.tsx:20-25`, `InvestmentsPage` loads `data = useFinance()` and `instruments = useLiveQuery(...)`. It immediately loops over `instruments.map(instrument => ...)` without calculating or displaying:
     - Total portfolio value in base currency
     - Total invested cost basis
     - Aggregate unrealized gain/loss
     - Total dividend distributions collected
     - Portfolio asset allocation breakdown (Stocks vs. Mutual Funds/UITFs vs. MP2/Fixed Income vs. Alternative)
   - Holdings with 0 units are styled and rendered identically to active multi-thousand-peso holdings, displaying `0 units · PHP · Unquoted instrument` with no distinction between active investments and saved watchlist items.

2. **Absence of Historical Charts & Sparklines on Holdings**:
   - In `src/pages/InvestmentPages.tsx:24`, holding cards display only four static numerical statistics:
     ```tsx
     <div className="holding-stats">
       <div><small>Open cost basis</small><strong><Money amount={cost} currency={instrument.currency}/></strong></div>
       <div><small>Unrealized gain / loss</small><strong><TrendIndicator value={unrealized} currency={instrument.currency}/></strong></div>
       <div><small>Realized gain / loss</small><strong><TrendIndicator value={positions.reduce((s,p)=>s+p.realizedGain,0)} currency={instrument.currency}/></strong></div>
       <div><small>Dividends / income</small><strong><Money amount={positions.reduce((s,p)=>s+p.income,0)} currency={instrument.currency}/></strong></div>
     </div>
     ```
   - There are zero Recharts components rendered in `InvestmentsPage`, despite `recharts` being installed (`"recharts": "^3.10.1"` in `package.json:32`) and heavily utilized in `Overview.tsx` and `PlanningPages.tsx`.
   - Users have no way to view the historical trajectory or performance trend of an instrument's price or NAV.

3. **Trade Recording UX Friction (`TradeForm`)**:
   - In `src/pages/InvestmentPages.tsx:29`:
     ```tsx
     const accounts=useLiveQuery(()=>financeDb.accounts.filter(a=>!a.deletedAt&&!a.archived&&a.currency===instrument.currency&&!['CREDIT_CARD','PERSONAL_LOAN','MORTGAGE','OTHER_LIABILITY'].includes(a.accountType)).toArray(),[instrument.currency]);
     ```
     If the user does not have an account whose currency matches `instrument.currency`, an empty state is shown with no options.
   - In `TradeForm`, `unitPrice` is not pre-filled with the latest known price from `financeDb.prices`.
   - When selling (`INVESTMENT_SELL`), the user is not shown how many units are held in the chosen account, and there is no "Sell All" / "Max" button.
   - There is no mode to calculate units from a total cash amount.
   - If floating-point unit multiplication does not match minor units exactly, `src/core/calculations.ts:235` throws:
     `requireValue(toMinor(transaction.unitPrice * transaction.units!, transaction.currency, precision) === transaction.amount, 'Trade notional must equal units multiplied by price, excluding fees.')`

4. **Manual NAV and Price Adjustment Friction (`PriceForm`)**:
   - In `src/pages/InvestmentPages.tsx:37`:
     ```tsx
     const prior=await existing(date);if(prior.length&&!replace)throw new Error('This date already has a manual valuation. Confirm replacement before saving.');
     ```
     Users attempting to update an existing date's valuation are met with a hard error and forced to check a replacement checkbox.
   - The form does not display the prior NAV, the prior statement date, or the resulting impact on the holding value.
   - Users cannot view or delete past recorded valuations from the UI.

5. **Existing Verification Baseline**:
   - `npm.cmd test` passes 24 test files and 471 tests (0 failures).
   - `npm.cmd run typecheck` passes with 0 TypeScript errors.

---

## 2. Logic Chain

1. **Premise 1 (From Observation 1)**: Without an aggregated portfolio header and asset allocation breakdown, users cannot assess their total investment net worth, overall performance (+/- %), or asset distribution (R2 requirement: *"Redesign the Investments section to be intuitive: simplify recording activities, tracking holdings, manual NAV/price adjustments, and viewing historical price performance"*).
   - *Inference*: Adding a `PortfolioOverview` header with base-currency converted totals and a multi-segment asset allocation progress bar directly resolves this gap.

2. **Premise 2 (From Observation 2)**: Recharts is already bundled in Tala, and `financeDb.prices` stores timestamped price and NAV records indexed by `instrumentId` and `asOf`.
   - *Inference*: Querying `financeDb.prices.where('instrumentId').equals(instrument.id).sortBy('asOf')` allows embedding a 36px responsive `<HoldingSparkline />` directly onto holding cards, and providing an interactive `<HoldingHistoryModal />` with time horizons (`1M`, `3M`, `6M`, `1Y`, `ALL`) without requiring any new dependencies.

3. **Premise 3 (From Observation 3)**: Users recording trades frequently execute dollar-cost averaging (investing a fixed cash amount) or full portfolio exits ("Sell All").
   - *Inference*: Equipping `TradeForm` with pre-filled latest prices, a dual-mode calculation toggle ("By Units" vs "By Cash Amount"), available balance badges, a "Sell All" action, and integer centavo alignment guarantees mathematical validity and prevents user calculation friction.

4. **Premise 4 (From Observation 4)**: Periodic statement and NAV updates (such as for Philippine mutual funds, UITFs, and Pag-IBIG MP2) require comparing new valuations against past benchmarks.
   - *Inference*: Equipping `PriceForm` with prior NAV context, live delta calculations (`+amount`, `+%`), holding value impact previews, seamless date overwriting, and a valuation history log table provides an intuitive and reliable manual valuation workflow.

---

## 3. Caveats

1. **No Backend Database Schema Changes Required**: All proposed improvements operate entirely on existing Dexie tables (`instruments`, `prices`, `transactions`, `accounts`, `fxRates`, `settings`). No Dexie schema migrations or version bumps are necessary.
2. **MarketsPage Co-location**: `src/pages/InvestmentPages.tsx` contains both `InvestmentsPage` and `MarketsPage`. Explorer M2-2 is designing error isolation and feedback improvements for `MarketsPage`. The changes for `InvestmentsPage` and its dialogs are modular and completely decoupled from `MarketsPage`.
3. **Foreign Holdings FX Conversion**: Portfolio-level aggregation converts foreign holdings to the user's base currency using `data.fxRates`. If an FX rate is completely missing and unroutable, the portfolio gracefully displays known converted totals with a warning pill, adhering to M1 resilience standards.

---

## 4. Conclusion

The design documented in `report.md` fulfills all requirements of **Feature 10 (R2)**:
1. **Intuitive Investment Workflow UX**: Portfolio-level overview cards, multi-segment asset allocation visual, active vs. watchlist categorization, and dual-mode trade recording (`TradeForm`) with pre-filled quotes and "Sell All" protection.
2. **Manual NAV & Price Adjustments**: Live-impact NAV calculator (`PriceForm`), contextual comparison with previous statement values, seamless date updates, and valuation history management.
3. **Historical Performance Visuals**: Embedded Recharts sparklines on holding cards (`HoldingSparkline`) and an interactive historical performance modal (`HoldingHistoryModal`) with time horizon filtering and data logs.

---

## 5. Verification Method

To verify the implementation of this design:
1. **Unit and Calculation Verification**:
   - Run `npm.cmd test` to confirm all 471 tests continue to pass without regression.
   - Run `npm.cmd run typecheck` to verify strict TypeScript adherence with no type errors.
2. **Component & UX Verification**:
   - Inspect `src/pages/InvestmentPages.tsx` to verify presence of `HoldingSparkline`, `HoldingHistoryModal`, `TradeForm`, `PriceForm`, and `InvestmentsPage`.
   - Verify that adding a manual price via `PriceForm` saves a valid record into `financeDb.prices` with `status: 'manual'` and immediately updates the holding sparkline and market value.
   - Verify that `TradeForm` calculates units from cash amount without precision error.
   - Verify that selling more units than held is blocked.
   - Verify that reduced motion is respected via `useReducedMotion()`.
3. **Invalidation Conditions**:
   - Any regression in `tests/calculations.test.ts` or `tests/e2e-overhaul.test.ts`.
   - Any uncaught exception thrown during trade submission or price update.
