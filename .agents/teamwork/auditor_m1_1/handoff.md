# Milestone M1 Forensic Audit Report & Handoff

**Auditor**: Forensic Auditor (`teamwork_preview_auditor`)  
**Milestone**: M1 (Architecture, Firebase Sync Engine & Supabase Removal)  
**Project Root**: `e:\Visual Studio Code\tala`  
**Working Directory**: `e:\Visual Studio Code\tala\.agents\teamwork\auditor_m1_1`  
**Timestamp**: 2026-10-09T19:13:00Z  
**Verdict**: **CLEAN**

---

## Forensic Audit Report

**Work Product**: Milestone M1 deliverables (`src/sync/engine.ts`, `src/sync/firebase.ts`, `src/firebase.ts`, `src/styles.css`, `firestore.rules`, `firebase.json`, `README.md`, `tests/sync.test.ts`, `tests/firestore-rules.test.ts`, Supabase purge)  
**Profile**: General Project  
**Integrity Mode**: Development (ground-truth per `ORIGINAL_REQUEST.md:14`)  
**Verdict**: **CLEAN**

### Phase Results
- **Phase 1: Source Code & Anti-Cheat Analysis**: PASS
  - `src/sync/engine.ts`: Web Locks implementation wraps sync execution in `withLock` via `globalThis.navigator.locks.request('tala_sync', fn)` with graceful Node fallback. Genuine serialization logic with zero facade or no-op constructs.
  - `src/sync/firebase.ts`: Composite cursors parse and track JSON maps (`Record<string, string>`) across all 17 `FINANCE_TABLES` independently. Prevents cross-table sync starvation. Legacy migration implements 500-item batch pagination (`limit(500)` and `startAfter()`) to `/users/{uid}/{tableName}/{id}` with idempotency flag. Zero facades.
  - `firestore.rules`: Enforces non-anonymous authentication via `request.auth.token.firebase.sign_in_provider != 'anonymous'`. Strict UID isolation `/users/{uid}/{tableName}/{id}`. Explicit separation of `allow delete` prevents null `request.resource.data` runtime crashes. Explicit default deny `match /{document=**} { allow read, write: false; }`. Zero backdoors or bypasses.
  - Supabase Purge: Directory `supabase/` deleted. All 8 `@supabase/*` dependencies purged from `package-lock.json` and `node_modules`. `README.md` rewritten. Grep search confirms 0 Supabase imports or calls in application source code.
- **Phase 2: Test Suite Assertions & Verification**: PASS
  - `tests/sync.test.ts`: 8 tests asserting active state mutations in Dexie IndexedDB (`fake-indexeddb`), concurrency tracking, conflict retention, and starvation avoidance. Zero `expect(true).toBe(true)` or trivial assertions.
  - `tests/firestore-rules.test.ts`: 14 tests asserting actual AST/clauses of `firestore.rules` and evaluating rule logic contexts (unauthenticated, anonymous, UID mismatch, safe delete, catch-all). Zero trivial assertions.
- **Phase 3: Independent Build & Test Execution**: PASS
  - Production Vite build (`node ./node_modules/vite/bin/vite.js build`): Exit code 0, 2575 modules transformed, production PWA assets output to `dist/`.
  - Automated test execution (`vitest run tests/sync.test.ts tests/firestore-rules.test.ts`): Exit code 0, 22 passed across 2 test files in 376ms.

---

## 1. Observation

Direct forensic observations from the project filesystem and command line executions:

1. **Web Locks in `src/sync/engine.ts` (lines 32-37, 40)**:
   ```ts
   const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
     if (typeof globalThis.navigator !== 'undefined' && globalThis.navigator?.locks?.request) {
       return globalThis.navigator.locks.request('tala_sync', fn);
     }
     return fn();
   };
   ```
   `perform()` wraps the entire synchronization pipeline within `withLock`. Inside a single tab, `syncNow()` deduplicates concurrent invocations via `if (running) return running;`. Across browser tabs, `navigator.locks.request('tala_sync', fn)` guarantees mutual exclusion.

2. **Composite Cursors in `src/sync/firebase.ts` (lines 195-238)**:
   - `pull()` parses incoming `cursor` as composite JSON (`Record<string, string>`) while retaining backward-compatibility for scalar ISO strings.
   - It iterates all 17 tables in `FINANCE_TABLES`:
     ```ts
     for (const tableName of FINANCE_TABLES) {
       const tableCursor = tableCursors[tableName];
       let q = query(
         collection(firestore, 'users', ownerId, tableName),
         where('updated_at', '<=', boundary),
         orderBy('updated_at', 'asc')
       );
       if (tableCursor) {
         q = query(q, where('updated_at', '>', tableCursor));
       }
       q = query(q, limit(1000));
       ...
     ```
   - Each table tracks its own `maxTableUpdated`, returning `JSON.stringify(tableCursors)` to prevent cross-table sync starvation.

3. **Firestore Security Rules in `firestore.rules`**:
   - Lines 6-9 define non-anonymous authentication:
     ```rules
     function isAuthenticated() {
       return request.auth != null 
         && request.auth.token.firebase.sign_in_provider != 'anonymous';
     }
     ```
   - Lines 12-21 enforce strict UID path isolation:
     ```rules
     match /users/{uid}/{tableName}/{id} {
       allow read: if isAuthenticated() && request.auth.uid == uid;
       allow delete: if isAuthenticated() && request.auth.uid == uid;
       allow create, update: if isAuthenticated() && request.auth.uid == uid 
                    && (request.resource.data.owner_id == null || request.resource.data.owner_id == uid)
                    && request.resource.data.entity_type == tableName
                    && request.resource.data.id == id;
     }
     ```
   - Lines 33-35 enforce default deny:
     ```rules
     match /{document=**} {
       allow read, write: false;
     }
     ```
   - Forensic node audit confirmed that all 8 `allow` statements in `firestore.rules` require `isAuthenticated()` and matching owner UID, or evaluate to `false`. Zero backdoors exist.

4. **Supabase Purge Verification**:
   - `git diff --stat supabase/schema.sql` confirms `schema.sql` was deleted.
   - Directory `supabase/` does not exist on disk (`powershell Test-Path "supabase"` -> `False`).
   - Repository-wide grep search for `supabase` returned 0 matches in `src/`, `package.json`, `package-lock.json`, and `README.md`.
   - The only remaining matches are in `ORIGINAL_REQUEST.md` (user requirements), `PROJECT.md` (feature plan), and `tests/e2e/helpers/mock-network.mjs:43` (privacy guard blocking remote outbound requests).

5. **Test Assertions in `tests/sync.test.ts` & `tests/firestore-rules.test.ts`**:
   - `tests/sync.test.ts` (445 lines, 8 tests) verifies:
     - `mockLocks.request` is called with lock name `'tala_sync'`.
     - Dexie `db.syncState` stores composite JSON cursor with separate timestamps for `accounts` and `categories`.
     - Category record `cat-2` updated between table timestamps arrives and is saved to Dexie (`expect(await db.categories.get('cat-2')).toBeDefined()`).
     - Dexie `syncOutbox` queues offline mutations and drains to 0 upon reconnect.
     - Conflicting records are stored in `db.conflicts` while local records remain untouched.
   - `tests/firestore-rules.test.ts` (207 lines, 14 tests) verifies:
     - Rule text contains `rules_version = '2'`, `function isAuthenticated()`, `sign_in_provider != 'anonymous'`, and deny-by-default.
     - Delete rule does not contain `request.resource.data`.
     - Simulated context evaluations verify rejection of unauthenticated users, anonymous users, UID mismatches, and entity type mismatches.

6. **Build and Test Verification**:
   - Ran `node ./node_modules/vite/bin/vite.js build`:
     `✓ built in 916ms` (Exit code: 0).
   - Ran `node ./node_modules/vitest/vitest.mjs run tests/sync.test.ts tests/firestore-rules.test.ts`:
     `Test Files 2 passed (2)`, `Tests 22 passed (22)` in 376ms (Exit code: 0).

---

## 2. Logic Chain

1. **Integrity Mode Assessment**:
   `ORIGINAL_REQUEST.md:14` specifies `Integrity mode: development`. Under development mode, libraries and framework usage are permitted, while hardcoded test outputs, dummy facade implementations, fabricated artifacts, and backdoors are strictly prohibited.
2. **Analysis of Implementation Authenticity**:
   - If Web Locks were a facade, `withLock` would simply return `fn()` without calling `navigator.locks.request`. However, `withLock` explicitly checks `globalThis.navigator.locks.request` and delegates to it with `'tala_sync'`. Tests verify that `mockLocks.request` is invoked and receives the `'tala_sync'` lock name.
   - If composite cursors were a facade, `pull()` would continue using a single scalar string. Instead, `pull()` constructs a `Record<string, string>`, queries each collection with its specific cursor, updates each table's cursor independently, and serializes the result as JSON. Test 3 in `tests/sync.test.ts` proves that a record with an earlier timestamp on a secondary table is not starved.
   - If Firestore security rules had a backdoor, there would be unauthenticated read/write rules or anonymous token allowances. Static analysis and automated assertion of all rule clauses confirm that every access pathway requires `isAuthenticated()` (which rejects anonymous tokens) and matching UID, backed by a catch-all deny rule.
   - If Supabase removal were incomplete or mocked, leftover packages would appear in `package.json`/`package-lock.json` or source files would import Supabase stubs. Grep and lockfile inspection confirm zero packages or imports remain.
3. **Conclusion Supported by Evidence**:
   Every deliverable in Milestone M1 consists of genuine, functional, non-cheating code satisfying R1, AC Security, and AC Sync requirements.

---

## 3. Caveats

1. **Pre-existing Multi-Currency Transition (Milestone M2 Scope)**:
   In commit `d300c09` (prior to Milestone M1), `Account` was refactored to `openingBalances: Record<Currency, Money>`. This produces TypeScript errors when running full `tsc --noEmit` across `calculations.ts` and `repository.ts`. As documented in `PROJECT.md` Feature 10, fixing these 13 pre-existing calculation tests belongs exclusively to Milestone M2 ("Multi-Currency Data Modeling & Valuation"). None of the files in Milestone M1 contain syntax or type errors, and the production Vite bundle builds cleanly with exit code 0.
2. **Java Runtime Environment for Live Firestore Emulator**:
   The host machine does not have a Java Runtime Environment installed (`java` command not found), preventing the live Java-based Google Cloud Firestore Emulator jar from running. Worker M1 responsibly compensated by creating `tests/firestore-rules.test.ts`, which validates rule file AST, condition strings, and security context evaluations.
3. **Remote Google Cloud Live Endpoints**:
   Local tests evaluate IndexedDB operations and mock network providers; end-to-end cloud sync with live Google OAuth and production Firestore requires live GCP credentials and deployed Firestore security rules.

---

## 4. Adversarial Review

### Challenge Dimensions
- **Assumption 1 (Web Locks Browser Support)**: Assumes `navigator.locks` is available in modern browsers.
  - *Risk*: Environments lacking Web Locks (e.g., Node.js or older WebViews) fall back to unguarded execution.
  - *Audit Finding*: The fallback is safe for single-tab/Node environments and prevents fatal crashes. Modern browsers natively support Web Locks.
- **Assumption 2 (Firestore Pagination Limit)**: Assumes 1,000 documents per table per pull is sufficient.
  - *Risk*: High volume batches could require multiple sync pulls.
  - *Audit Finding*: Because the composite cursor advances to `maxTableUpdated`, subsequent pulls pick up immediately where the previous pull left off without skipping records.
- **Assumption 3 (Anonymous User Differentiation)**: Assumes Firebase anonymous tokens can be reliably detected.
  - *Risk*: Token tampering or custom token generation.
  - *Audit Finding*: Firebase Auth ID tokens explicitly populate `sign_in_provider: 'anonymous'`. Security rules evaluate this server-side in Firestore, making client spoofing impossible.

---

## 5. Conclusion

**Verdict: CLEAN**

Milestone M1 deliverables pass all integrity, behavioral, and structural forensic checks:
- No facade or no-op implementations.
- Web Locks and composite cursors are genuinely implemented with robust logic.
- Firestore security rules strictly isolate data by UID, reject anonymous users, handle deletion safely, and enforce deny-by-default.
- Supabase has been completely purged from the codebase.
- Tests contain genuine, non-trivial assertions and pass with 100% success rate (22/22 tests).
- Production Vite build succeeds with exit code 0.

The work product is approved. Milestone M2 may proceed.

---

## 6. Verification Method

To independently verify this audit, run the following commands in PowerShell from `e:\Visual Studio Code\tala`:

```powershell
# 1. Verify production Vite build succeeds
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH
node ./node_modules/vite/bin/vite.js build

# 2. Run automated M1 test suites
node ./node_modules/vitest/vitest.mjs run tests/sync.test.ts tests/firestore-rules.test.ts

# 3. Verify zero Supabase packages in package-lock.json
node -e "const pkg = require('./package-lock.json'); const found = Object.keys(pkg.packages || {}).filter(k => k.includes('supabase')); console.log('Supabase packages in lockfile:', found.length);"

# 4. Verify firestore.rules deny-by-default and anonymous rejection
node -e "const r = require('fs').readFileSync('firestore.rules', 'utf8'); console.log('Anonymous rejection:', r.includes('sign_in_provider != \'anonymous\'')); console.log('Deny-by-default:', r.includes('match /{document=**}') && r.includes('allow read, write: false;'));"
```
