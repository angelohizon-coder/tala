## 2026-10-09T22:46:24Z
You are Worker 6 (teamwork_preview_worker) for Milestone M6 (UI, UX & Accessibility Refactoring) of the Tala financial SPA modernization project.
Your working directory is: e:\Visual Studio Code\tala\.agents\teamwork\worker_m6
The project root is: e:\Visual Studio Code\tala
Authoritative user request and requirements: e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md
Project plan and contracts: e:\Visual Studio Code\tala\PROJECT.md
Survey reference: e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_3\survey_report.md
Parent conversation ID: 64bc598d-7c84-4fe3-b439-553f079769f4

You must read `e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md` and `e:\Visual Studio Code\tala\PROJECT.md` before starting work.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Exclusive file ownership for Milestone M6:
- tailwind.config.js
- src/styles.css
- src/components/EmptyState.tsx
- src/components/TrendIndicator.tsx
- src/pages/Overview.tsx
- src/pages/InvestmentPages.tsx
- tests/ui-accessibility.test.ts

Tasks to implement:
1. Tailwind CSS Brand Theme (R6):
   - Configure `tailwind.config.js` to define Tala Forest Green (`#173c34`), brand neutrals, and accessible semantic colors.
   - Modernize and clean `src/styles.css`, eliminating contrast issues.
2. Honest Empty States (R6):
   - Enforce "honest empty states" across core views (Accounts, Transactions, Investments, Budgets, FIRE, Watchlist) with zero simulated or fake demo data.
   - Implement reusable `EmptyState.tsx` providing clear onboarding guidance and call-to-action without dummy figures.
3. WCAG Standards Compliance (R6):
   - Color contrast: ensure all text meets WCAG AA 4.5:1 minimum (darken muted text `#7a8782` to `#4f5e58` or better).
   - Accessible gain/loss indicators: DO NOT rely on color alone (WCAG 1.4.1). In `TrendIndicator.tsx`, `Overview.tsx`, and `InvestmentPages.tsx`, provide explicit unary signs (`+`/`-`), directional icons, and `sr-only` screen-reader text (`Gain of`, `Loss of`).
   - Visible keyboard focus rings (`focus-visible:ring-2 focus-visible:ring-tala-green`).
4. Tests & Verification:
   - Create `tests/ui-accessibility.test.ts` verifying contrast ratios, absence of fake demo data in empty states, accessible gain/loss indicators with non-color cues, and focus styles.
   - Run typecheck: `node ./node_modules/typescript/bin/tsc --noEmit`.
   - Run Vitest: `node ./node_modules/vitest/vitest.mjs run tests/ui-accessibility.test.ts`.
   - Run E2E suites: `node tests/e2e/run-all.mjs`.
   - Run Vite build: `node ./node_modules/vite/bin/vite.js build`.
   - All tests must pass with exit code 0.

Deliver your handoff report to `e:\Visual Studio Code\tala\.agents\teamwork\worker_m6\handoff.md`. Send a message back when complete.
