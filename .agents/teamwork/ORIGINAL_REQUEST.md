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


## 2026-10-10T03:02:29Z

# Teamwork Project Prompt — Launched

> Status: Launched
> Goal: Craft prompt → get user approval → delegate to teamwork_preview
> Requested team: The full team

Use the full team of agents. Add UI animations and sound cues to the Tala application. This should be handled as part of a comprehensive UI overhaul.

Working directory: e:/Visual Studio Code/tala
Integrity mode: benchmark

## Requirements

### R1. UI Animations
Animate page transitions, modal opening/closing, and chart rendering on load. Ensure animations are smooth, performant, and do not cause layout thrashing. 

### R2. Sound Cues
Integrate open-source UI sound assets for key interactions (e.g., success and error states). 

### R3. Accessibility & Controls
Respect the user's `prefers-reduced-motion` OS settings by disabling animations automatically when requested. Implement a global settings toggle allowing users to mute all sound cues.

## Acceptance Criteria

### Verification: Programmatic Tests
- [ ] Add unit/accessibility tests verifying that animation classes/styles are completely disabled when `window.matchMedia('(prefers-reduced-motion: reduce)')` is true.
- [ ] Add tests verifying that the global mute toggle correctly prevents the sound implementation from being called.
- [ ] The existing test suite (`npm test` / vitest) must pass without regressions.

### Verification: Agent-as-Judge (UI/UX Review)
- [ ] An independent reviewer must verify that page transitions and modals do not stutter or cause layout shifting during animation.
- [ ] An independent reviewer must verify that sound assets trigger appropriately on success/error without overlapping unpleasantly or throwing console errors.

---
*Next: when approved → delegate via invoke_subagent (see Delegation Protocol)*


## 2026-10-10T05:00:46Z

Perform a full codebase overhaul of the Tala personal finance app (a React/TypeScript SPA deployed on GitHub Pages, using Firebase for auth and Firestore sync) by removing dead code, legacy modules, redundant tooling, and infrastructure artifacts that do not belong in a Firebase + GitHub Pages deployment.

Working directory: e:/Visual Studio Code/tala
Integrity mode: development

---

## What to Keep
- `src/` — all application source code (App.tsx, pages, hooks, db, sync, ui, workers, market, core, components)
- `functions/` — Firebase Cloud Functions (market data gateway) 
- `public/` — static assets (icons, sounds, models)
- `tests/` — Vitest unit + integration tests (`*.test.ts`) and the browser journey test (`tools/finance-browser-check.mjs`)
- `.github/workflows/pages.yml` — the GitHub Actions deployment pipeline
- `firebase.json`, `firestore.indexes.json`, `firestore.rules` (if it exists) — Firebase config
- `vite.config.ts`, `tailwind.config.js`, `postcss.config.js`, `tsconfig.json`, `package.json`

---

## Requirements

### R1. Remove Legacy Market Dashboard (the `site/` directory)
The `site/` directory contains a standalone vanilla-JS market dashboard (`site/index.html`, `site/styles.css`, `site/src/*.js`, `site/data/*.json`) that predates the React app. It is bundled into the Vite build via `vite.config.ts` (`preserve-market-module` plugin copying `site/` into `dist/legacy-market/`). Remove the `site/` directory entirely. Remove the `preserve-market-module` plugin block from `vite.config.ts`. Remove any scripts, tools, or tests that exist exclusively to serve or test this legacy module (e.g. `tools/serve.mjs`, `tools/check.mjs`, `tools/browser-check.mjs`, `tests/client.test.mjs`, `tests/data.test.mjs`, `tests/worker.test.mjs`). Remove the `"market:dev"` and `"test:market:browser"` npm scripts.

### R2. Remove Cloudflare Worker Infrastructure
The `worker/` directory contains a Cloudflare Worker gateway (`worker/index.mjs`, `worker/wrangler.toml`, `worker/README.md`) that duplicates what the Firebase Cloud Function in `functions/` already does. Remove the `worker/` directory entirely.

### R3. Remove `.agents/` Teamwork Scaffolding
The `.agents/` directory contains internal teamwork agent scaffolding files from previous AI agent runs (briefings, handoffs, progress notes). This is not application code. Remove the `.agents/` directory entirely.

### R4. Remove `artifacts/` Directory from Git
The `artifacts/` directory contains local CI test screenshots and JSON data dumps (e.g. screenshots, market fixture data, edge profile caches). These are CI-generated and should not live in source control. Remove the `artifacts/` directory and add `artifacts/` to `.gitignore`. Retain the `artifacts/` directory in `.gitignore` to prevent future CI-generated files from being committed.

### R5. Remove Debug Workflow and Debug Log Files
The `.github/workflows/debug.yml` workflow was a temporary diagnostic tool. It commits debug log files (`debug.txt`, `debug_test.txt`, `debug_build.txt`, `debug_browser.txt`) back to `main`. Remove `debug.yml` entirely. Delete the existing committed `debug*.txt` files. Remove any other temporary/scratch files at the repo root (e.g. `ORIGINAL_REQUEST.md`, any `.md` files that are agent-generated planning docs at the repo root — but keep `README.md` if it exists).

### R6. Remove Redundant Market Tools and Tests
The `tools/` directory contains several tools for probing and testing free market data sources (PSE, global, mirror) that are not part of the production deployment or CI pipeline. Remove: `tools/free-market.mjs`, `tools/free-pse.mjs`, `tools/free-global.mjs`, `tools/free-global-mirror.mjs`, `tools/probe-free-source.mjs`, `tools/generate-icons.mjs`. Remove corresponding tests: `tests/free-market.test.mjs`, `tests/free-pse.test.mjs`, `tests/free-global.test.mjs`, `tests/free-global-mirror.test.mjs`, `tests/local-gateway.test.mjs`, `tests/acceptance/` directory, `tests/e2e/` directory. Remove the `"check:source"` npm script. Update `package.json` to remove the `"test:market"` script that runs these `.mjs` tests if they are removed (or update it to point only to remaining `.test.mjs` files).

### R7. Remove Unused devDependencies
After removals, audit `package.json` devDependencies and remove packages that are no longer used anywhere in the remaining codebase. Specifically: `axios` (used only in `functions/src/index.ts` which has its own `functions/package.json`; not used in the frontend/tests), `class-variance-authority`, `tailwind-merge`, `clsx` (check if any remaining `.tsx`/`.ts` file actually imports these before removing). Do not remove `firebase-admin` or `firebase-functions` — they are needed to type-check `functions/` during root-level `tsc`. Keep all other devDependencies that are genuinely used.

### R8. Clean Up `vite.config.ts`
After removing the `site/` directory and legacy market module plugin (R1), simplify `vite.config.ts`. The `preserve-market-module` plugin block should be removed entirely (it references `site/` and copies it to `dist/legacy-market/`). The `workbox` navigateFallbackDenylist should also drop `/legacy-market/` from its deny list since that path no longer exists.

### R9. Fix `debug.yml` Removal Impact on `pages.yml`
Verify that `pages.yml` is self-contained, passes `npm test` and `npm run build` after all removals, and that `npm run test:browser` still works. Update the CI pipeline if any scripts or test references were changed as part of the cleanup (e.g. if `"test:market"` script changes).

---

## Acceptance Criteria

### Codebase Cleanliness
- [ ] `site/` directory does not exist in the repository after cleanup.
- [ ] `worker/` directory does not exist in the repository after cleanup.
- [ ] `.agents/` directory does not exist in the repository after cleanup.
- [ ] `artifacts/` is listed in `.gitignore` and not tracked by git.
- [ ] `.github/workflows/debug.yml` does not exist. No `debug*.txt` files are committed.
- [ ] `ORIGINAL_REQUEST.md` and any other agent-generated planning `.md` files at the repo root are removed (keep `README.md` if present).

### Build Integrity
- [ ] `npm run build` (`tsc --noEmit && vite build`) succeeds without type errors after all removals.
- [ ] `npm test` (vitest) passes with all tests that remain after cleanup (no regressions in `tests/*.test.ts`).
- [ ] `vite.config.ts` does not reference `site/`, `legacy-market`, or the `preserve-market-module` plugin.

### CI Pipeline Integrity  
- [ ] `.github/workflows/pages.yml` runs all remaining steps successfully: `npm install`, `npm test`, `npm run build`, `npm run test:browser`.
- [ ] The `npm run test:market` script in `package.json` either points only to existing `.mjs` test files or is removed if no such files remain.

### No Broken Imports
- [ ] `npm run typecheck` (`tsc --noEmit`) passes with zero errors after removals.
- [ ] No `src/` file imports from a path that no longer exists.
