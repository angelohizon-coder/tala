# Original User Request

## 2026-10-09T18:43:58Z

# Teamwork Project Prompt — Launched

> Status: Launched.
> Goal: Craft prompt → get user approval → delegate to teamwork_preview
> Requested team: Full team (implied by massive scope)

Modernize the Tala financial SPA into a robust, offline-capable platform bridging local-only privacy with cloud synchronization, multi-currency ledger management, intelligent categorization, and stochastic financial forecasting.

Working directory: e:/Visual Studio Code/tala
Integrity mode: development

## Requirements

### R1. Architecture & Firebase Sync Engine
- Host frontend on GitHub Pages and backend on Firebase Cloud Functions/Firestore.
- Implement strict UID-isolated Firestore structures (`/users/{uid}/{tableName}/{id}`) with deny-by-default rules.
- Build a custom sync engine using `navigator.locks` to prevent multi-tab race conditions and cursor-based pagination for Firestore pulls. Provide seamless migration for legacy `finance_entities` records.
- Completely remove all legacy Supabase dependencies from the codebase.

### R2. Multi-Currency Data Modeling
- Model accounts with sub-ledgers for multiple fiat currencies (e.g., PHP, USD, EUR) simultaneously.
- Store all cash amounts as integer minor units to eliminate floating-point rounding errors. 
- Implement a unified valuation layer that securely converts native amounts into the selected base currency using dated exchange rates.
- Record cross-currency transfers as linked source/destination entries, separating actual amounts and fees.

### R3. Market Data Gateway
- Create a Firebase Cloud Function (`functions/` directory) to serve as a market data gateway.
- Fetch from external APIs (like Yahoo Finance v8 or FCS API), normalize the data into a standard schema, and return it to the frontend.
- Restrict CORS on the Cloud Function strictly to the canonical GitHub Pages origin and localhost.
- Never replace a failed quote with zero; preserve the last valid quote with a STALE flag.

### R4. Client-Side ML Categorization
- Execute machine learning inference directly in the browser (e.g., ONNX Runtime Web or TensorFlow.js) via a Web Worker to classify imported transactions without sending data to a backend.
- Use a quantized model (q4/q8) for optimized bandwidth and memory footprint.

### R5. Advanced FIRE Projections (Monte Carlo)
- Replace deterministic calculators with stochastic Monte Carlo simulations utilizing parameterized fat-tailed distributions (Student's t-distribution).
- Execute a minimum of 5,000 discrete iterations in a Web Worker to ensure statistical convergence without blocking the UI.
- Output a probability density function rather than a single deterministic depletion date.

### R6. UI, UX, and Accessibility Refactoring
- Standardize typography, spacing, colors, and components using Tailwind CSS and PostCSS, maintaining the green brand identity.
- Enforce "honest empty states" without simulated demo data.
- Meet WCAG standards: visible keyboard focus, adequate contrast, and accessible labels (do not rely on color alone for gains/losses).

## Acceptance Criteria

### Security & Privacy
- [ ] Firestore Security Rules Emulator explicitly rejects read/write requests from mismatched UIDs or anonymous users.
- [ ] Local-only mode produces zero outbound network requests to Firebase or Open Banking APIs.

### Financial Integrity
- [ ] A test account holding PHP 10,000 and USD 100 correctly shows a converted total of PHP 15,600 (at a test rate of PHP 56/USD) without double-counting.
- [ ] Cross-currency transfers reflect zero generated income or expense.
- [ ] Removing an exchange rate excludes the foreign balance from the aggregated net worth rather than treating it as a 1:1 conversion.

### Synchronization
- [ ] Two concurrent browser tabs writing data correctly serialize uploads via Web Locks, avoiding duplicated records.
- [ ] Reconnecting after being offline successfully merges queued local mutations with the remote Firestore database.
