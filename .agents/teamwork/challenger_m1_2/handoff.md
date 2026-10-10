# Challenger M1-2 Handoff Report: Firebase Auth, Error Isolation & Config

**Agent**: Challenger M1-2 (Adversarial Critic & Specialist)  
**Date**: 2026-10-10  
**Milestone**: M1 (Core Currency, Valuation & Data Sync — R1 & R7)  
**Status**: Completed  
**Verdict**: **APPROVE**  

---

## 1. Observation

Direct observations and empirical evidence gathered during adversarial verification:

1. **Client Boundary Anonymous Token Enforcement (`src/sync/firebase.ts:51-57, 140-144`)**:
   - `requireOwner()` asserts:
     ```typescript
     const user = auth.currentUser;
     if (!user || user.isAnonymous) {
       throw new Error('Sign in with a verified account before enabling cloud synchronization.');
     }
     return user.uid;
     ```
   - In `provider.userId()`, returns `null` whenever `!user || user.isAnonymous`.
   - In `src/sync/engine.ts:44-47`, `perform()` checks:
     ```typescript
     const ownerId = await provider.userId();
     if (!ownerId || (await db.syncState.get('ownerId'))?.value !== ownerId) {
       throw new Error('Sign in and explicitly assign local records before syncing.');
     }
     ```
   - Verification in `tests/challenger-m1-2-adversarial.test.ts:79-158` confirmed both unauthenticated and anonymous users are blocked with verbatim error `'Sign in with a verified account before enabling cloud synchronization.'` and `provider.userId()` returns `null`.

2. **Snapshot Listener Error Isolation & Resilience (`src/sync/firebase.ts:243-281`)**:
   - `provider.subscribe(callback, onError)` loops over all 17 tables in `FINANCE_TABLES`:
     ```typescript
     (error) => {
       console.warn(`Firestore snapshot subscription error for table ${tableName}:`, error);
       void db.syncState.put({
         id: 'lastSyncError',
         value: `Cloud listener error on ${tableName}: ${error.message || 'connection interrupted'}`
       }).catch(() => {});
       onError?.(error);
     }
     ```
   - In `tests/challenger-m1-2-adversarial.test.ts:289-317`, simulating an error storm across all 17 tables invoked `onError` 17 times with 0 unhandled promise rejections.
   - Sibling table resilience was verified: when 3 tables errored, healthy tables continued delivering records to `callback` uninterrupted (`tests/challenger-m1-2-adversarial.test.ts:319-366`).
   - Missing `onError` callback executed cleanly without throwing (`tests/challenger-m1-2-adversarial.test.ts:368-387`).

3. **Remote Schema & Tamper Defense (`src/sync/firebase.ts:23-45, 257-261`)**:
   - Snapshot listener processes changes inside a `try-catch` block:
     ```typescript
     try {
       records.push(remote(row, ownerId, tableName));
     } catch {
       // Ignore ownership/schema failures
     }
     ```
   - Verification in `tests/challenger-m1-2-adversarial.test.ts:389-417` confirmed corrupted or spoofed `owner_id` rows are rejected by `remote()` and filtered out without throwing or invoking the consumer callback.

4. **Environment Variable Fallback Resolution (`src/firebase.ts:3-14`)**:
   - Evaluates credentials via `const getEnv = (val: string | undefined, fallback: string): string => val || fallback;`.
   - Verified in `tests/challenger-m1-2-adversarial.test.ts:423-467`: empty string (`""`) and `undefined` safely resolve to default credentials for all 8 keys (`apiKey`, `authDomain`, `databaseURL`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`, `measurementId`), while non-empty overrides take precedence.

5. **Multi-User Outbox Isolation (`src/sync/engine.ts:51-56`)**:
   - `db.syncOutbox.where('ownerId').equals(ownerId)` ensures mutations queued by User A are not pushed during User B's sync session.
   - Verified in `tests/challenger-m1-2-adversarial.test.ts:589-637`.

6. **External FX Failure Isolation (`src/market/providers.ts:43-50`)**:
   - `safeRefreshFx` wraps API calls in `try-catch`, returning `{ ok: false, error: ... }`.
   - Verified in `tests/challenger-m1-2-adversarial.test.ts:672-706` under simulated HTTP 500 and malformed JSON payloads.

7. **Test Suite Non-Regression**:
   - `cmd /c npx vitest run tests/challenger-m1-2-adversarial.test.ts` (20 passed)
   - `cmd /c npx vitest run tests/challenger-sync-adversarial.test.ts` (7 passed)
   - `cmd /c npm test` (24 test files, 471 tests passed, 0 failures)
   - `cmd /c npm run typecheck` (exit 0)
   - `cmd /c npm run build` (exit 0)

---

## 2. Logic Chain

1. **Anonymous Session Containment**:
   - *Observation Reference*: 1.
   - *Inference*: By blocking anonymous users at both `provider.userId()` (returning `null`) and `requireOwner()` (throwing explicit verified account error), the system prevents invalid requests from reaching Firestore. This guarantees compliance with `firestore.rules:6-9` (`sign_in_provider != 'anonymous'`) and prevents `PERMISSION_DENIED` errors and outbox corruption.

2. **Fault-Tolerant Real-Time Synchronization**:
   - *Observation References*: 2, 3.
   - *Inference*: Each of the 17 tables has an isolated snapshot listener. An error in one or all table listeners writes diagnostic state to `db.syncState` without crashing the application runtime or interrupting healthy table subscriptions. Malformed incoming documents are discarded at the boundary before affecting local database integrity.

3. **Configuration Stability**:
   - *Observation Reference*: 4.
   - *Inference*: The logical OR fallback in `getEnv` protects against empty string env variables (common when `.env` files contain empty keys) and undefined variables, ensuring the Firebase app is always initialized with complete, functional credentials.

4. **Multi-User Privacy Protection**:
   - *Observation Reference*: 5.
   - *Inference*: Partitioning outbox entries by `ownerId` prevents cross-user contamination on shared devices. User A's unpushed offline mutations remain dormant until User A authenticates again.

5. **Network Resilience in Financial Valuation**:
   - *Observation Reference*: 6.
   - *Inference*: By shielding background FX refreshes behind `safeRefreshFx`, network glitches or upstream API outages do not cause unhandled promise rejections, and the application reliably falls back to historical floor rates (`DEFAULT_FX_SEEDS`).

---

## 3. Caveats

No caveats. All investigated areas (anonymous token rejection, listener error storms, configuration fallbacks, multi-user isolation, safe FX refresh) were tested empirically with executable Vitest test suites.

---

## 4. Conclusion

The implementation provided by Worker M1 for Milestone 1 (R1 and R7) satisfies all architectural and security constraints under adversarial testing:
1. Anonymous and unauthenticated sessions are strictly rejected.
2. Snapshot listeners isolate errors across all 17 tables with zero unhandled promise rejections.
3. Firebase configuration resolves reliably under partial and malformed environment variables.
4. Multi-user offline outbox partitions prevent data leakage across accounts.
5. All 24 test files in the project pass (471/471 tests), TypeScript typechecking succeeds with 0 errors, and the production build completes successfully.

**Verdict**: **APPROVE**

---

## 5. Verification Method

To independently reproduce Challenger M1-2's findings:

```bash
# 1. Run Challenger M1-2 Adversarial Stress Test Suite
cmd /c npx vitest run tests/challenger-m1-2-adversarial.test.ts
# Expected: 20 passed (20)

# 2. Run Challenger Sync Concurrency Suite
cmd /c npx vitest run tests/challenger-sync-adversarial.test.ts
# Expected: 7 passed (7)

# 3. Run Full Test Suite
cmd /c npm test
# Expected: 24 test files passed, 471 tests passed (0 failures)

# 4. Run TypeScript Compilation Check
cmd /c npm run typecheck
# Expected: Exit code 0

# 5. Run Production Build
cmd /c npm run build
# Expected: Exit code 0
```

### Invalidation Conditions
- Any anonymous Firebase token successfully executing `provider.push()`, `provider.pull()`, or `provider.subscribe()` without throwing `'Sign in with a verified account before enabling cloud synchronization.'`.
- Any unhandled promise rejection arising from Firestore listener error callbacks.
- Any failure of `firebaseConfig` to resolve valid fallback values when environment variables are empty strings or undefined.
- Any mutation belonging to User A being uploaded during User B's sync cycle.
- Any failure in `npm test`, `npm run typecheck`, or `npm run build`.
