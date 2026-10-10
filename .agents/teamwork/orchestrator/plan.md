# Execution Plan — Tala Personal Finance SPA Overhaul

## Objective
Overhaul the Tala personal finance SPA to address requirements R1 through R8 and fulfill all acceptance criteria.

## Requirements Breakdown
- **R1: Multi-Currency Net Worth & Valuation Layer**: Multi-currency aggregation, FX rate caching/fallback, no broken `—` displays.
- **R2: Market Data Reliability & Investment Usability**: Reliable quote fetching, fallback mechanisms, intuitive investment holdings, transactions, and NAV/price adjustments.
- **R3: Financial Ledger Structure (Expenses & Debts)**: Dedicated Expenses tracking, separate Debts view, clear cash flow accounting without duplicate spending.
- **R4: Accounts Management**: Drag-and-drop reordering, multi-field sorting (name, balance, currency, type), persistent ordering in local storage/IndexedDB.
- **R5: Budget & Recurring Rules Redesign**: Intuitive recurring frequency settings, due dates, prompt/confirmation banners, real-time category budget targets & progress bars.
- **R6: FIRE Journey Bug Fix & Simulation Stability**: Fix runtime crashes in FIRE calculations, Monte Carlo simulation stability, custom inflation, contribution, withdrawal rates, multi-currency handling.
- **R7: Firebase Synchronization & Security Hardening**: Robust read/write sync between Dexie IndexedDB and Firestore under `/users/{uid}/{tableName}/{id}`, secure auth rules, reliable offline-first mutation queuing.
- **R8: Modern UI/UX, Footer & Mobile Responsiveness**: Sticky/flex pinned footer layout, responsive mobile layout (390px width check), modern cohesive design system.

## Phases
1. **Phase 0: Survey**:
   - Dispatch 3 Explorers / Spec Miners to map current code structure, build & test tooling, data stores (Dexie, Firebase), models, and diagnose existing bugs for R1-R8.
2. **Phase 1: Architecture & Project Definition**:
   - Synthesize findings into `PROJECT.md` with Feature Inventory, Milestones, and Interface Contracts.
3. **Phase 2: Milestone Implementation & Verification**:
   - Implementation track and Testing track.
   - Run Explorer -> Worker -> Reviewer -> Challenger -> Auditor -> Gate cycles.
4. **Phase 3: Final Acceptance**:
   - Execute all unit tests (`npm test`) and production build (`npm run build`).
   - Validate mobile responsiveness, footer anchoring, and end-to-end user journeys.
5. **Phase 4: Handoff & Completion**:
   - Deliver final report to Sentinel.
