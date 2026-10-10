# Handoff Report: Reviewer M1-2

**Agent**: Reviewer M1-2 (Reviewer, Critic)  
**Date**: 2026-10-10  
**Milestone**: M1 (Core Currency, Valuation & Data Sync — R1 & R7)  
**Verdict**: **`APPROVE`**  
**Type**: Hard Handoff  

---

## 1. Observation

Direct observations and evidence gathered during independent review and verification:

1. **Anonymous User Gate in `src/sync/firebase.ts`**:
   - Lines 51-57:
     ```typescript
     const requireOwner = async () => {
       const user = auth.currentUser;
       if (!user || user.isAnonymous) {
         throw new Error('Sign in with a verified account before enabling cloud synchronization.');
       }
       return user.uid;
     };
     ```
   - Lines 140-144:
     ```typescript
     async userId() {
       const user = auth.currentUser;
       if (!user || user.isAnonymous) return null;
       return user.uid;
     },
     ```
   - Both `push()` and `pull()` and `subscribe()` invoke `requireOwner()` and abort immediately with this error if `user.isAnonymous` is `true`.

2. **Snapshot Listener Error Handler in `src/sync/firebase.ts` & `src/sync/provider.ts`**:
   - `src/sync/provider.ts:7`:
     ```typescript
     subscribe(callback: (records: RemoteRecord[]) => void, onError?: (error: Error) => void): Promise<() => void>;
     ```
   - `src/sync/firebase.ts:268-275`:
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
   - All 17 table listeners in `FINANCE_TABLES` have this error callback attached to `onSnapshot`.

3. **Firebase Configuration in `src/firebase.ts`**:
   - Lines 3-14:
     ```typescript
     const getEnv = (val: string | undefined, fallback: string): string => val || fallback;

     export const firebaseConfig = {
       apiKey: getEnv(import.meta.env?.VITE_FIREBASE_API_KEY, "AIzaSyD0jeZyg4ZNv0OZHaKMrdegHyQ1XuIjrqU"),
       authDomain: getEnv(import.meta.env?.VITE_FIREBASE_AUTH_DOMAIN, "kotoba-41ab0.firebaseapp.com"),
       databaseURL: getEnv(import.meta.env?.VITE_FIREBASE_DATABASE_URL, "https://kotoba-41ab0-default-rtdb.asia-southeast1.firebasedatabase.app"),
       projectId: getEnv(import.meta.env?.VITE_FIREBASE_PROJECT_ID, "kotoba-41ab0"),
       storageBucket: getEnv(import.meta.env?.VITE_FIREBASE_STORAGE_BUCKET, "kotoba-41ab0.firebasestorage.app"),
       messagingSenderId: getEnv(import.meta.env?.VITE_FIREBASE_MESSAGING_SENDER_ID, "792855742091"),
       appId: getEnv(import.meta.env?.VITE_FIREBASE_APP_ID, "1:792855742091:web:9734098b8c9e530ac0368e"),
       measurementId: getEnv(import.meta.env?.VITE_FIREBASE_MEASUREMENT_ID, "G-Y6EHQP7YTJ")
     };
     ```
   - Environment variables are sourced with optional chaining and fallback, and `firebaseConfig` is explicitly exported.

4. **Independent Verification Execution Results**:
   - `cmd /c npx vitest run tests/firebase-sync-unit.test.ts`:
     - Result: `1 passed (1), 8 passed (8)`
   - `cmd /c npx vitest run tests/sync.test.ts`:
     - Result: `1 passed (1), 8 passed (8)`
   - `cmd /c npx vitest run tests/firestore-rules.test.ts`:
     - Result: `1 passed (1), 14 passed (14)`
   - `cmd /c npx vitest run tests/calculations.test.ts tests/challenger-financial-integrity.test.ts tests/e2e-overhaul.test.ts`:
     - Result: `3 passed (3), 126 passed (126)`
   - `cmd /c npm run typecheck`:
     - Result: `tsc --noEmit` exited with code 0.
   - `cmd /c npm run build`:
     - Result: `tsc --noEmit && vite build` built client bundle cleanly in 923ms; generated PWA service worker; exited with code 0.
   - `cmd /c npm test`:
     - Result: `22 passed (22) files, 429 passed (429) tests` (0 failures).

5. **Integrity Violations Check**:
   - Confirmed absence of hardcoded outputs, dummy facade stubs, external tool delegating shortcuts, or fabricated test runs.

---

## 2. Logic Chain

1. **Alignment with Firestore Security Rules** (supported by Observations 1 & 4):
   - `firestore.rules` enforces `request.auth.token.firebase.sign_in_provider != 'anonymous'`. Previously, the client permitted anonymous sessions to execute Firestore requests, triggering unhandled `PERMISSION_DENIED` errors in the console.
   - By gating `requireOwner()` and `userId()` in `src/sync/firebase.ts`, the client prevents any outbox push, pull, or subscription by anonymous tokens, surfacing an actionable error to the user before network transmission.
   - Verified via `tests/firebase-sync-unit.test.ts` where all anonymous calls reject as expected.

2. **Network Resilience & Non-Crashing Listeners** (supported by Observations 2 & 4):
   - In single-page applications, unhandled listener errors cause background crash loops or unhandled rejections.
   - Providing an error callback to `onSnapshot` across all 17 tables isolates network dropouts, logs warnings, persists diagnostic info in Dexie `db.syncState.lastSyncError`, and propagates to consumer code via `onError?.(error)`.
   - Verified via `tests/firebase-sync-unit.test.ts` where simulated snapshot failure successfully wrote to `db.syncState` without crashing.

3. **Dynamic Configuration Flexibility** (supported by Observations 3 & 4):
   - Sourcing `import.meta.env.VITE_FIREBASE_*` with fallback preserves existing zero-config functionality for developers while enabling staging/production CI/CD environment variable injection.
   - Exporting `firebaseConfig` satisfies external consumers and test harnesses.

4. **Zero Regressions Across Codebase** (supported by Observation 4):
   - Full test run of all 22 test files (429 unit/e2e tests) plus `tsc` and `vite build` completed with zero errors, confirming no regressions were introduced to existing financial calculations, ledger handling, or offline queues.

---

## 3. Caveats

- **Free-tier Rate Limits & Cloud Service Dependency**: Actual production behavior against Google Cloud Firestore relies on live quota and credentials. Local verification utilized mocked Firebase auth/firestore instances.
- **Multiple Error Notifications on Disconnect**: When network drops, Firestore triggers the error callback for each of the 17 table subscriptions. Consumer UI components receiving `onError` should debounce user-facing alerts to avoid duplicate toasts.

---

## 4. Conclusion

The Milestone 1 implementation is robust, complete, and fully compliant with project requirements R1 and R7. All security invariants, offline guarantees, and test suites are verified. **Verdict is APPROVE.**

---

## 5. Verification Method

To independently reproduce the verification:

```bash
# 1. Run Firebase sync security and configuration unit tests
cmd /c npx vitest run tests/firebase-sync-unit.test.ts

# 2. Run sync engine tests (Web Locks, composite cursors, offline queues)
cmd /c npx vitest run tests/sync.test.ts

# 3. Run Firestore security rules verification tests
cmd /c npx vitest run tests/firestore-rules.test.ts

# 4. Run TypeScript typecheck
cmd /c npm run typecheck

# 5. Run production build
cmd /c npm run build

# 6. Run full test suite
cmd /c npm test
```

### Invalidation Conditions
- Any anonymous Firebase token successfully executing `requireOwner()` or returning a string UID from `provider.userId()`.
- An unhandled rejection thrown when `onSnapshot` encounters a network error.
- Failure of `firebaseConfig` to resolve to default project strings when `VITE_FIREBASE_*` environment variables are absent.
- Any compile error in `npm run typecheck` or `npm run build`.
