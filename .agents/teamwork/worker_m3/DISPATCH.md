## 2026-10-09T22:36:08Z
You are Worker 3 (teamwork_preview_worker) for Milestone M3 (Market Data Gateway Cloud Function) of the Tala financial SPA modernization project.
Your working directory is: e:\Visual Studio Code\tala\.agents\teamwork\worker_m3
The project root is: e:\Visual Studio Code\tala
Authoritative user request and requirements: e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md
Project plan and contracts: e:\Visual Studio Code\tala\PROJECT.md
Survey reference: e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_3\survey_report.md
Parent conversation ID: 64bc598d-7c84-4fe3-b439-553f079769f4

You must read `e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md` and `e:\Visual Studio Code\tala\PROJECT.md` before starting work.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Exclusive file ownership for Milestone M3:
- functions/src/index.ts
- functions/package.json
- functions/tsconfig.json
- tests/market-gateway.test.ts

Tasks to implement:
1. Multi-tier Market Data Gateway in `functions/src/index.ts`:
   - Standardized output schema `NormalizedMarketQuote`:
     ```typescript
     export interface NormalizedMarketQuote {
       symbol: string;
       price: number;
       currency: string;
       timestamp: number;
       asOf: string;
       provider: 'yahoo' | 'fcs' | 'cache';
       freshness: 'realtime' | 'delayed' | 'stale';
       isStale: boolean;
       change?: number;
       changePercent?: number;
     }
     ```
   - Primary provider: Yahoo Finance v8 chart API (`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`).
   - Secondary fallback: FCS API or secondary provider if primary fails.
   - Firestore STALE cache: Cache every successful quote under `/marketCache/{symbol}` with `cachedAt` timestamp.
   - CRITICAL ZERO-PRICE DEFENSE: If external APIs fail or are unreachable, query the Firestore cache for the last valid quote and return it with `isStale: true` and `freshness: 'stale'`. NEVER return `price: 0` or replace a failed quote with zero!
   - Strict CORS: Allow only `https://angelohizon-coder.github.io` and `http://localhost:5173`, `http://localhost:5174`, `http://127.0.0.1:5173`, `http://127.0.0.1:5174`. Reject all other origins with 403 Forbidden.
2. Unit and Integration Tests:
   - Create `tests/market-gateway.test.ts` verifying CORS restriction, standard schema normalization, multi-tier fallback, and STALE quote preservation.
3. Verification:
   - Build functions: `npm.cmd --prefix functions run build` (or compile TypeScript).
   - Run Vitest & E2E tests: `node ./node_modules/vitest/vitest.mjs run tests/market-gateway.test.ts` and `node tests/e2e/run-all.mjs`.
   - All tests must pass with exit code 0.

Deliver your handoff report to `e:\Visual Studio Code\tala\.agents\teamwork\worker_m3\handoff.md`. Send a message back when complete.
