## 2026-10-09T22:36:08Z
You are Worker 4 (teamwork_preview_worker) for Milestone M4 (Client-Side ML Categorization) of the Tala financial SPA modernization project.
Your working directory is: e:\Visual Studio Code\tala\.agents\teamwork\worker_m4
The project root is: e:\Visual Studio Code\tala
Authoritative user request and requirements: e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md
Project plan and contracts: e:\Visual Studio Code\tala\PROJECT.md
Survey reference: e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_3\survey_report.md
Parent conversation ID: 64bc598d-7c84-4fe3-b439-553f079769f4

You must read `e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md` and `e:\Visual Studio Code\tala\PROJECT.md` before starting work.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Exclusive file ownership for Milestone M4:
- src/workers/categorizer.worker.ts
- src/workers/mlCategorizer.ts (or client wrapper)
- src/pages/DataPage.tsx
- public/models/**
- tests/ml-categorization.test.ts

Tasks to implement:
1. Client-Side ML Categorization in Web Worker (R4):
   - Implement Dedicated Web Worker `src/workers/categorizer.worker.ts` running in-browser inference (using ONNX Runtime Web `onnxruntime-web` or quantized lightweight neural classifier) to classify imported transactions without sending data to any backend.
   - Use a quantized model format (q4/q8 or compact quantized weights) for optimized bandwidth and memory footprint.
   - Zero outbound network requests: all inference occurs entirely client-side.
   - Implement hybrid classification: local rule/pattern cache in IndexedDB resolves known merchants; the Web Worker handles unseen or generalized descriptions, outputting categories (e.g., Food & Dining, Utilities, Transportation, Entertainment, Income, Healthcare) with confidence scores.
2. Statement Import Integration:
   - In `src/pages/DataPage.tsx`, wire the statement import flow to dispatch descriptions to the categorizer worker, automatically applying predicted categories to imported transactions.
3. Tests & Verification:
   - Create `tests/ml-categorization.test.ts` testing worker message passing, classification accuracy across common financial statements, quantized inference, and zero network calls.
   - Verify typecheck: `node ./node_modules/typescript/bin/tsc --noEmit`.
   - Verify Vitest: `node ./node_modules/vitest/vitest.mjs run tests/ml-categorization.test.ts`.
   - Verify E2E suites: `node tests/e2e/run-all.mjs`.
   - Verify Vite build: `node ./node_modules/vite/bin/vite.js build`.
   - All tests must pass with exit code 0.

Deliver your handoff report to `e:\Visual Studio Code\tala\.agents\teamwork\worker_m4\handoff.md`. Send a message back when complete.
