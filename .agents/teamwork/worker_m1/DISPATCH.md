# Dispatch for Worker M1

## Identity & Role
- Role: Milestone 1 Implementer (Core Currency, Valuation & Data Sync)
- Working directory: e:/Visual Studio Code/tala/.agents/teamwork/worker_m1/
- Original Request path: e:/Visual Studio Code/tala/.agents/teamwork/ORIGINAL_REQUEST.md
- Project Scope: e:/Visual Studio Code/tala/PROJECT.md
- Project Root: e:/Visual Studio Code/tala

## Mandatory Integrity Warning
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Milestone 1 Implementation Scope
You exclusively own and modify the following files:
- `src/core/calculations.ts`
- `src/core/types.ts`
- `src/db/repository.ts`
- `src/market/providers.ts`
- `src/sync/firebase.ts`
- `src/sync/provider.ts`
- `src/firebase.ts`
- `src/pages/Overview.tsx`
- `src/App.tsx`
- `tests/calculations.test.ts`

### Requirements to Implement (R1 & R7)
1. **Triangular Cross-Rate Routing in `getFxRate` (`src/core/calculations.ts`)**:
   - Reference: `e:/Visual Studio Code/tala/.agents/teamwork/explorer_m1_1/report.md`
   - Implement 2-hop triangular routing pivoting through `USD`, `EUR`, `PHP`, and active currencies.
   - Enforce temporal cutoff checks on both legs so no future rates leak.
   - Preserve backward compatibility: direct and inverse rates always take precedence.
2. **Resilient Net Worth & Clean FX Reporting (`src/core/calculations.ts` & `src/core/types.ts`)**:
   - Add `missingFx?: Currency[]` to `NetWorthSummary`.
   - Maintain `knownNetWorth` as the sum of convertible balances.
   - Keep `netWorth: null` and `complete: false` when any FX is missing to uphold financial integrity invariants in existing tests.
3. **Default FX Seed Rates in Dexie (`src/db/repository.ts`)**:
   - Reference: `e:/Visual Studio Code/tala/.agents/teamwork/explorer_m1_2/report.md`
   - In `initializeFinanceDatabase`, seed `DEFAULT_FX_SEEDS` with historical floor timestamp `2020-01-01T00:00:00.000Z` covering all 9 supported currencies (`PHP`, `USD`, `EUR`, `GBP`, `JPY`, `HKD`, `CAD`, `AUD`, `SGD`).
4. **Background FX Refresh (`src/market/providers.ts`, `src/App.tsx`, `src/pages/Overview.tsx`)**:
   - Add `safeRefreshFx(base, force)` in `src/market/providers.ts`.
   - In `src/App.tsx`, trigger background FX refresh on app boot after database open.
   - In `src/pages/Overview.tsx`, trigger background FX refresh on base currency dropdown change.
5. **Resilient Overview Net Worth Display (`src/pages/Overview.tsx`)**:
   - Render `netWorth.netWorth ?? netWorth.knownNetWorth` for metric value.
   - Render subtle `Estimated` warning badge if `!netWorth.complete && hasAccounts`.
   - Never show `—` for multi-currency accounts when convertible balances exist.
6. **Firebase Auth Security (`src/sync/firebase.ts`)**:
   - Reference: `e:/Visual Studio Code/tala/.agents/teamwork/explorer_m1_3/report.md`
   - In `requireOwner()`, check `if (!user || user.isAnonymous) throw new Error('Sign in with a verified account before enabling cloud synchronization.');`
   - In `userId()`, return `null` if user is anonymous.
7. **Firebase Config Security (`src/firebase.ts`)**:
   - Source keys from `import.meta.env?.VITE_FIREBASE_*` with the existing strings as fallbacks; export `firebaseConfig`.
8. **Snapshot Listener Error Callbacks (`src/sync/firebase.ts` & `src/sync/provider.ts`)**:
   - Pass error callback to `onSnapshot` across all 17 tables, logging and storing in `db.syncState`.

### Verification Commands
Run and document results in your handoff:
- `npx vitest run tests/calculations.test.ts`
- `npx vitest run tests/challenger-financial-integrity.test.ts`
- `npx vitest run tests/sync.test.ts`
- `npx vitest run tests/firestore-rules.test.ts`
- `npm run typecheck`
- `npm run build`

Deliver your changes, write a self-contained `handoff.md` in your working directory, and message the orchestrator when finished.

## 2026-10-10T14:21:23Z
Received invocation message:
You are Worker M1 for the Tala SPA overhaul.
Your working directory is: e:/Visual Studio Code/tala/.agents/teamwork/worker_m1/
The project root is: e:/Visual Studio Code/tala
Authoritative User Request: e:/Visual Studio Code/tala/.agents/teamwork/ORIGINAL_REQUEST.md
Project Scope: e:/Visual Studio Code/tala/PROJECT.md
Detailed Instructions: e:/Visual Studio Code/tala/.agents/teamwork/worker_m1/DISPATCH.md
