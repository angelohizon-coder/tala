## 2026-10-09T18:56:56Z
You are Test Writer (teamwork_preview_test_writer) for the Tala financial SPA modernization project.
Your working directory is: e:\Visual Studio Code\tala\.agents\teamwork\test_writer_e2e
The project root is: e:\Visual Studio Code\tala
Authoritative user request and requirements: e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md
Project plan and contracts: e:\Visual Studio Code\tala\PROJECT.md
Survey reports:
- e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_1\survey_report.md
- e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_2\survey_report.md
- e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_3\survey_report.md
Parent conversation ID: 64bc598d-7c84-4fe3-b439-553f079769f4

You must read `e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md` and `e:\Visual Studio Code\tala\PROJECT.md` before starting work.

Exclusive file ownership:
- TEST_INFRA.md (at project root)
- TEST_READY.md (at project root)
- tests/e2e/** (test runner, test suites, test helpers)
- tests/acceptance/**

You MUST NOT modify application implementation source code in `src/` or `functions/`.

Your objective is the E2E Testing Track:
1. Design and build a comprehensive opaque-box E2E test suite covering all requirements (R1 through R6) and acceptance criteria:
   - Security & Privacy: Firestore rules reject mismatched UIDs / anonymous users; local-only mode produces zero outbound network requests.
   - Financial Integrity: PHP 10,000 + USD 100 @ PHP 56/USD -> PHP 15,600 without double counting; cross-currency transfers reflect zero net income/expense; removing exchange rate excludes foreign balance from net worth instead of 1:1 fallback.
   - Synchronization: Concurrent multi-tab writes serialize via Web Locks avoiding duplicates; offline mutations queue and merge on reconnect.
   - Market Data Gateway (R3): Standardized schema, CORS restriction, STALE quote preservation (never return 0).
   - ML Categorization (R4): In-browser inference in Web Worker, zero network calls, quantized model classification.
   - Monte Carlo FIRE (R5): Student's t-distribution (v=5), 5,000+ iterations in Web Worker, PDF output and percentile fan charts.
   - UI/UX & A11y (R6): Tailwind green palette, honest empty states, WCAG compliance (contrast >= 4.5:1, visible focus, non-color gain/loss indicators).
2. Structure test cases using the 4-tier methodology:
   - Tier 1: Feature Coverage (>=5 tests per feature)
   - Tier 2: Boundary & Corner Cases (>=5 tests per feature)
   - Tier 3: Cross-Feature Interactions (pairwise combinations)
   - Tier 4: Real-World Application Scenarios (realistic end-to-end workflows)
3. Ensure the test runner can be executed easily (e.g. via Node test runner `node --test tests/e2e/*.test.mjs` or Vitest `npx vitest run tests/e2e/`).
4. Publish `TEST_INFRA.md` at project root documenting architecture, methodology, feature inventory coverage matrix.
5. When all test suites are written and verified runnable, publish `TEST_READY.md` at project root with runner command, tier breakdown, and feature checklist.
6. Write your handoff report to `e:\Visual Studio Code\tala\.agents\teamwork\test_writer_e2e\handoff.md` and send a message back when completed.
