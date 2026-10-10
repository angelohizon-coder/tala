# Handoff Report: Phase 0 Architecture, Firebase Sync Engine & Legacy Cleanup

**Agent**: Survey Explorer 1 (`teamwork_preview_explorer`)  
**Task**: Phase 0 Codebase Structure, Architecture, Firebase Sync Engine & Legacy Cleanup  
**Working Directory**: `e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_1`  
**Reference Report**: `e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_1\survey_report.md`  
**Timestamp**: 2026-10-09T18:55:00Z  

---

## 1. Observation

### Obs 1.1: Build & Typecheck Failures
- **Command**: `npm run typecheck` (`tsc --noEmit`)
  - **Output**:
    ```
    src/sync/engine.ts(27,52): error TS1005: ',' expected.
    src/sync/engine.ts(27,54): error TS1136: Property assignment expected.
    src/sync/engine.ts(38,52): error TS1005: ',' expected.
    src/sync/engine.ts(41,61): error TS1005: ',' expected.
    ```
  - **Verbatim Code in `src/sync/engine.ts`**:
    - Line 27: `await db.conflicts.put({ id: conflict: + entry.tableName + : + entry.entityId + : + response.record.record.version, ... });`
    - Line 38: `const cursor = (await db.syncState.get(cursor: + ownerId))?.value;`
    - Line 41: `await db.syncState.put({ id: cursor: + ownerId, value: pulled.cursor });`
- **File Encoding & Vite Build Failure**:
  - `src/firebase.ts` is encoded in UTF-16LE.
  - When inspected via tool `view_file`: `unsupported mime type text/plain; charset=utf-16le`.
  - When inspected in `debug_build.txt`:
    ```
    [UNLOADABLE_DEPENDENCY] Could not load src/firebase.ts
    src/sync/firebase.ts:1:21
    1 | import { app } from "../firebase";
                             ──────┬──────
                                   ╰──────── stream did not contain valid UTF-8
    ```
- **PostCSS Import Order**:
  - `debug_build.txt` lines 7-11:
    `[vite:css][postcss] @import statements must precede all other statements (besides @charset or empty @layer) and be consecutive` in `src/styles.css`.

### Obs 1.2: Supabase Usage & Lingering Artifacts
- Grep search for `supabase` across `src/`, `tests/`, `tools/`, `scripts/`, `worker/`, `functions/` returned **0 results**.
- `@supabase/supabase-js` is absent from `package.json`.
- Residual Supabase files and references:
  - `supabase/schema.sql` (67 lines) contains PostgreSQL schema for `public.finance_entities`, RPC `apply_finance_mutation`, and trigger `finance_broadcast_changes`.
  - `package-lock.json` still retains `@supabase/supabase-js`, `@supabase/auth-js`, `@supabase/functions-js`, `@supabase/phoenix`, `@supabase/postgrest-js`, `@supabase/realtime-js`, `@supabase/storage-js`.
  - `README.md` lines 50–61 describes `## Optional Supabase synchronization`.

### Obs 1.3: Legacy `finance_entities` & Storage Structure
- `localStorage` contains zero financial data; the codebase uses Dexie IndexedDB (`tala-finance`, version 2) across 17 entity tables (`FINANCE_TABLES`).
- `src/sync/firebase.ts` lines 26–63 contains `migrateLegacyData(ownerId)` which performs a one-time migration from Firestore root collection `finance_entities` to `/users/{ownerId}/{tableName}/{row.id}` in batches of 500, setting `db.syncState.put({ id: 'legacyMigrated', value: true })`.
- Firestore composite index for `finance_entities` on `(owner_id, updated_at)` is present in `firestore.indexes.json`.

### Obs 1.4: Firebase Configuration & Firestore Security Rules
- `firebase.json` specifies hosting, firestore (`firestore.rules`, `firestore.indexes.json`), and functions (`functions/`). It lacks an `emulators` configuration block.
- `firestore.rules`:
  - Path: `match /users/{uid}/{tableName}/{id}`
  - Read: `allow read: if request.auth != null && request.auth.uid == uid;`
  - Write: `allow write: if request.auth != null && request.auth.uid == uid && (request.resource.data.owner_id == null || request.resource.data.owner_id == uid) && request.resource.data.entity_type == tableName && request.resource.data.id == id;`
  - Legacy match: `match /finance_entities/{document}`.
  - No check for `request.auth.token.firebase.sign_in_provider != 'anonymous'`.
  - On delete operations, `request.resource.data` is null, causing `request.resource.data.entity_type` evaluation to throw a runtime rules error.
  - `@firebase/rules-unit-testing` is not installed in `package.json`.

### Obs 1.5: Sync Engine & Multi-Tab Web Locks
- `src/sync/engine.ts:12` wraps synchronization in `navigator.locks.request('tala_sync', async () => { ... })`.
- Node environment lacks `navigator.locks` by default, causing unhandled rejection unless mocked.
- `src/sync/firebase.ts:110-147` implements `pull(cursor)`:
  - Iterates sequentially through `FINANCE_TABLES` with `where('updated_at', '<=', boundary)` and `where('updated_at', '>=', cursor)`.
  - Uses a single shared scalar cursor for all 17 tables and advances `nextCursor` monotonically.
  - Uses `>=` which returns the boundary item redundantly on subsequent pulls.

### Obs 1.6: GitHub Pages Compatibility
- `vite.config.ts:8` sets `base: process.env.VITE_BASE || './'`.
- `src/main.tsx:6` mounts `<BrowserRouter basename={import.meta.env.BASE_URL}><App/></BrowserRouter>`.
- `public/404.html` contains the SPA redirect script redirecting `/tala/*` to `/?/*`.
- `index.html` lines 3-8 decodes query routes into `window.history.replaceState`.
- `functions/src/index.ts:6-10` restricts CORS to `https://angelohizon-coder.github.io`, `http://localhost:5173`, `http://127.0.0.1:5173`.

---

## 2. Logic Chain

1. **Build & Test Blocker Identification**:
   - `Obs 1.1` demonstrates that `src/sync/engine.ts` fails TypeScript compilation due to unquoted `conflict:` and `cursor:` strings. Because Vitest transforms files through Vite/oxc, this syntax failure also causes test suites importing `engine.ts` (`tests/repository.test.ts`) to fail immediately with parse errors.
   - `Obs 1.1` demonstrates that `src/firebase.ts` UTF-16LE encoding prevents Vite bundling (`stream did not contain valid UTF-8`).
   - Therefore, resolving these two file-level defects is the prerequisite for any automated verification in Phase 1.

2. **Supabase Removal State**:
   - `Obs 1.2` shows zero Supabase calls in actual runtime code (`src/`), confirming that client code has already migrated away from Supabase SDK.
   - However, `package-lock.json` still locks `@supabase/*` and `supabase/schema.sql` remains in the tree.
   - Therefore, complete Supabase removal requires only file deletion (`supabase/`), `npm prune`, and `README.md` cleanup.

3. **Firestore Security Rule Flaws & Acceptance Criteria**:
   - Requirement: `"Firestore Security Rules Emulator explicitly rejects read/write requests from mismatched UIDs or anonymous users."`
   - `Obs 1.4` shows that `firestore.rules` currently checks only `request.auth != null && request.auth.uid == uid`.
   - In Firebase Auth, anonymous users have a valid UID and non-null `request.auth`.
   - Therefore, the existing rules ALLOW anonymous users to read and write their own UID documents, violating the acceptance criteria.
   - Furthermore, evaluating `request.resource.data.entity_type` during a deletion causes an evaluation failure because `request.resource.data` is null upon delete.
   - Therefore, `firestore.rules` must be patched to require `request.auth.token.firebase.sign_in_provider != 'anonymous'` and split `create, update` from `delete`.

4. **Sync Engine Cursor Starvation**:
   - `Obs 1.5` shows that `pull()` updates a single shared `nextCursor` across 17 distinct collections in a sequential loop.
   - If Table 1 advances the cursor to timestamp $T_2$, subsequent Table 2 pulls on the next sync call will only search records updated after $T_2$, skipping any updates in Table 2 between $T_1$ and $T_2$.
   - Therefore, cursor pagination must store a composite per-table cursor map (`Record<FinanceTableName, string>`) rather than a single scalar timestamp.

5. **GitHub Pages Routing**:
   - `Obs 1.6` shows `BrowserRouter basename={import.meta.env.BASE_URL}` paired with `base: './'`.
   - React Router v7's `BrowserRouter` does not support relative paths like `'./'` for `basename`; it requires an absolute path (`'/tala/'` or `'/'`).
   - Therefore, building with relative base breaks client deep links under GitHub Pages. The base must be normalized to `'/tala/'` in production builds.

---

## 3. Caveats

- **Firestore Emulator Execution**: Because the local environment does not currently have Java or the Firebase emulator suite pre-configured, Firestore security rules emulator tests must be set up with `@firebase/rules-unit-testing` and run against the emulator once started.
- **Multi-Currency Test Refactor Scope**: The failure of `tests/calculations.test.ts` is caused by an incomplete refactoring of account balances from single numbers to multi-currency sub-ledgers. This belongs to Phase 2 (R2 Multi-Currency Data Modeling), but was documented here as part of repository health.

---

## 4. Conclusion

The Tala codebase has completed the foundational migration of its runtime off Supabase to Firebase, but requires targeted architectural hardening before subsequent feature phases:
1. **Compilation & Packaging**: Immediate fixes required for `src/sync/engine.ts` (syntax), `src/firebase.ts` (UTF-8 encoding), and `src/styles.css` (import order).
2. **Security Rules**: `firestore.rules` must reject anonymous tokens and handle document deletion without reading `request.resource.data`. An emulator test harness (`tests/firestore-rules.test.ts`) using `@firebase/rules-unit-testing` must be introduced.
3. **Sync Engine**: The Firestore sync provider must be upgraded to composite per-table cursors to prevent cross-table update loss, and provide a `navigator.locks` fallback for test runners.
4. **Cleanliness**: Delete `supabase/` and purge `package-lock.json`.
5. **Hosting**: Set production base path to `'/tala/'` for GitHub Pages `BrowserRouter` compatibility.

---

## 5. Verification Method

### 5.1 Verification Commands
1. **Typecheck Verification**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;$env:PATH"
   node ./node_modules/typescript/bin/tsc --noEmit
   ```
   *Expected outcome*: Exits with code 0 once `engine.ts` syntax errors are corrected.
2. **Unit Test Verification**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;$env:PATH"
   node ./node_modules/vitest/vitest.mjs run tests/repository.test.ts
   ```
   *Expected outcome*: Passes once syntax and `navigator.locks` test fallback are in place.
3. **Market Test Suite Verification**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;$env:PATH"
   node --test tests/*.test.mjs
   ```
   *Verified status*: Already 100% passing (141 tests pass).
4. **Vite Production Build Verification**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;$env:PATH"
   node ./node_modules/vite/bin/vite.js build
   ```
   *Expected outcome*: Clean build output into `dist/` without UTF-8 or PostCSS import errors.
5. **Supabase Absence Verification**:
   ```powershell
   Get-ChildItem -Recurse -Include *supabase* | Select-Object FullName
   ```
   *Expected outcome*: No remaining files once `supabase/` directory is deleted.

### 5.2 Invalidation Conditions
- If Firebase rules test allows an anonymous token (`sign_in_provider == 'anonymous'`) to write to `/users/{uid}/accounts/1`, conclusion 2 is invalidated.
- If concurrent browser tabs write records that produce duplicate Firestore documents, conclusion 3 regarding Web Locks is invalidated.
