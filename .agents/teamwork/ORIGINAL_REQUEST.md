# Original User Request

## Initial Request — 2026-10-10T13:48:16Z

# Teamwork Project Prompt — Launched

> Status: Launched
> Goal: Craft prompt → get user approval → delegate to teamwork_preview
> Requested team: Full team

Overhaul the Tala personal finance SPA to resolve multi-currency aggregation in Net Worth, fix market data feeds, add a dedicated expenses view alongside debts, improve investment workflow UX, pin the footer layout, introduce drag-and-drop and sorting for account cards, redesign budget and recurring rules, fix FIRE journey calculation errors, ensure robust authenticated Firebase read/write sync with secured keys, and make the UI modern, responsive, and mobile-friendly.

Working directory: e:/Visual Studio Code/tala
Integrity mode: development

## Requirements

### R1. Multi-Currency Net Worth & Valuation Layer
Ensure total net worth accurately converts and aggregates all account balances, investment holdings, and liabilities into the chosen base currency (defaulting cleanly to PHP or user-selected currency) using active/cached dated FX exchange rates. Never show an empty or broken value (`—`) simply because accounts hold multiple currencies (e.g. PHP, USD).

### R2. Market Data Reliability & Investment Usability Overhaul
Fix the Market quote fetching mechanism so US and international tickers load reliably and gracefully fall back to cached/stale data without crashing. Redesign the Investments section to be intuitive: simplify recording activities, tracking holdings, manual NAV/price adjustments, and viewing historical price performance.

### R3. Financial Ledger Structure: Dedicated Expenses & Debt Workflows
Provide a clear, dedicated Expenses tracking experience alongside the existing Debts section. Ensure transaction recording, category summaries, and monthly cash flow calculations distinguish income, normal living expenses, transfers, and debt amortizations without confusion or duplicate spending.

### R4. Accounts Management: Reordering & Sorting
Make account cards draggable so users can reorder their accounts arbitrarily. Add sorting controls to sort accounts by name, balance, currency, or account type. Maintain this custom ordering and sort preference across app reloads in local storage / IndexedDB.

### R5. Budget & Recurring Rules Redesign
Overhaul the recurring rules and budget systems:
- Recurring rules: replace cumbersome rule templates with an intuitive interface for defining frequencies (daily, weekly, bi-weekly, monthly, annual), next due dates, auto-prompt/confirmation banners, and clear transaction links.
- Budgets: allow easy creation of monthly and annual category targets with visual progress bars, over-budget alerts, and real-time calculation from actual transactions.

### R6. FIRE Journey Bug Fix & Simulation Stability
Fix the error occurring in the FIRE journey page. Ensure stochastic Monte Carlo calculations and deterministic retirement projection math handle custom inflation, contribution amounts, withdrawal rates, and multi-currency balances smoothly without unhandled exceptions or worker crashes.

### R7. Firebase Synchronization & Security Hardening
Ensure two-way synchronization with Firestore works reliably for authenticated users:
- Enable robust read and write synchronization between local Dexie IndexedDB and Firestore under `/users/{uid}/{tableName}/{id}`.
- Enforce strict authentication, ensuring anonymous users cannot corrupt sync state and keys/tokens are secured.
- Maintain seamless offline-first capability: local operations function completely without internet, and queued mutations sync when reconnected.

### R8. Modern UI/UX, Footer Positioning & Mobile Responsiveness
Overhaul the application layout and styling:
- Ensure the footer stays pinned properly to the bottom of the viewport or content flow (`sticky`/flex column layout) without awkwardly floating mid-page.
- Optimize all pages, forms, tables, dialogs, charts, and navigation sidebars for mobile screens (touch targets, no horizontal overflow, responsive cards and drawer navigation).
- Deliver a cohesive, modern visual theme with polished typography, spacing, subtle animations, and accessible contrast.

---

## Acceptance Criteria

### Calculations & Features
- [ ] Net worth displays a correctly aggregated total converted to the active base currency even when accounts hold diverse currencies (e.g. PHP and USD).
- [ ] Markets view loads quotes without silent network failures; investment holdings can be added and valued with clear feedback.
- [ ] Accounts page supports drag-and-drop reordering of cards and provides sorting options (e.g., name, balance, type).
- [ ] Recurring transactions can be set up, viewed, and confirmed without cryptic errors; budget cards reflect real-time spending progress.
- [ ] Navigating to the FIRE journey renders without runtime errors, generating valid simulation trajectories.

### Sync & Security
- [ ] When signed in via Firebase, local changes sync to Firestore and remote records pull down successfully.
- [ ] Local-only mode functions completely offline without blocking UI actions.
- [ ] Firestore security rules guard against unauthorized or cross-UID access.

### UI & Responsiveness
- [ ] Application shell footer is neatly anchored at the bottom across all views and screen heights.
- [ ] All views render responsively on mobile viewports (390px width) without horizontal scrollbar overflow.
- [ ] Unit test suite (`npm test`) and production build (`npm run build`) succeed without errors.
