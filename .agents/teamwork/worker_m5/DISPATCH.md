## 2026-10-09T22:46:24Z
You are Worker 5 (teamwork_preview_worker) for Milestone M5 (Advanced FIRE Monte Carlo Simulation) of the Tala financial SPA modernization project.
Your working directory is: e:\Visual Studio Code\tala\.agents\teamwork\worker_m5
The project root is: e:\Visual Studio Code\tala
Authoritative user request and requirements: e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md
Project plan and contracts: e:\Visual Studio Code\tala\PROJECT.md
Survey reference: e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_3\survey_report.md
Parent conversation ID: 64bc598d-7c84-4fe3-b439-553f079769f4

You must read `e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md` and `e:\Visual Studio Code\tala\PROJECT.md` before starting work.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Exclusive file ownership for Milestone M5:
- src/workers/monteCarlo.worker.ts
- src/workers/fireSimulation.ts
- src/pages/PlanningPages.tsx
- tests/monte-carlo.test.ts

Tasks to implement:
1. Advanced FIRE Projections (R5):
   - Replace deterministic loop in `PlanningPages.tsx` with stochastic Monte Carlo simulations utilizing parameterized fat-tailed distributions (Student's t-distribution with degrees of freedom nu = 5).
   - Execute a minimum of 5,000 discrete iterations in a Dedicated Web Worker (`src/workers/monteCarlo.worker.ts`) to ensure statistical convergence without blocking the UI thread.
   - Use Float64Array typed buffers for performance.
   - Output a Probability Density Function (PDF) of depletion years rather than a single deterministic depletion date.
   - Output percentile trajectory fan charts (P10, P50, P90) across the retirement horizon.
   - Statistical convergence: verified SE <= 0.01 at N = 5000 iterations.
2. UI Integration:
   - Wire `PlanningPages.tsx` to dispatch simulation parameters to the worker, display loading state without freezing the UI, and render the resulting PDF distribution and trajectory charts.
3. Tests & Verification:
   - Create `tests/monte-carlo.test.ts` verifying Student's t sampling, fat-tail risk (kurtosis > 3), 5,000 iterations execution, statistical convergence, and PDF output structure.
   - Run typecheck: `node ./node_modules/typescript/bin/tsc --noEmit`.
   - Run Vitest: `node ./node_modules/vitest/vitest.mjs run tests/monte-carlo.test.ts`.
   - Run E2E suites: `node tests/e2e/run-all.mjs`.
   - Run Vite build: `node ./node_modules/vite/bin/vite.js build`.
   - All tests must pass with exit code 0.

Deliver your handoff report to `e:\Visual Studio Code\tala\.agents\teamwork\worker_m5\handoff.md`. Send a message back when complete.
