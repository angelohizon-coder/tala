# Milestone 1 Independent Review & Adversarial Challenge Report

**Reviewer**: Reviewer M1-2 (Reviewer, Critic)  
**Date**: 2026-10-10  
**Target Milestone**: M1 (Core Currency, Valuation & Data Sync — R1 & R7)  
**Artifacts Reviewed**:
- `src/firebase.ts`
- `src/sync/provider.ts`
- `src/sync/firebase.ts`
- `tests/firebase-sync-unit.test.ts`
- `tests/sync.test.ts`
- `tests/firestore-rules.test.ts`

---

## 1. Quality Review

### Review Summary

**Verdict**: **`APPROVE`**

The implementation of Milestone 1 Firebase sync hardening, anonymous token blocking, environment-based configuration, and snapshot listener error resilience is clean, correct, thoroughly tested, and conforms directly to the specifications in `ORIGINAL_REQUEST.md` (R7) and `PROJECT.md`.

### Integrity Assessment
- **Hardcoded test results**: None detected. Logic operates dynamically on actual inputs.
- **Dummy or facade implementations**: None detected. `requireOwner()`, `userId()`, `onSnapshot` error handling, and `firebaseConfig` fallbacks implement complete, authentic functionality.
- **Shortcuts or bypassing**: None detected. Code properly integrates Dexie `syncState`, Firebase Auth `isAnonymous`, and Firestore subscriptions.
- **Fabricated verification logs**: None detected. All test outputs, typechecks, and builds were executed and verified independently.
- **Self-certifying work**: None detected. Independent test suites (`firebase-sync-unit.test.ts`, `sync.test.ts`, `firestore-rules.test.ts`) assert exact behavioral expectations under simulated conditions.

---

### Findings

#### [Minor] Finding 1: Concurrent Snapshot Error Invocations on Network Loss
- **What**: When the network drops or authentication state expires, Firestore `onSnapshot` listeners for each of the 17 tables fail concurrently, invoking `onError?.(error)` and updating `db.syncState` up to 17 times in rapid succession.
- **Where**: `src/sync/firebase.ts:268-275`
- **Why**: `unsubscribes` tracks 17 individual listeners across `FINANCE_TABLES`. In the event of a global disconnect or auth failure, all 17 listeners trigger their error callbacks.
- **Impact Assessment**: Low. IndexedDB `db.syncState.put` overwrites by key `lastSyncError`, which is idempotent and thread-safe in Dexie. If consumer UI hooks into `onError` with toast notifications in future milestones, rapid duplicate notifications could appear unless debounced.
- **Suggestion**: In Milestone 5 (UI polish) or sync engine consumers, consider debouncing or throttling user-facing listener error notifications.

---

### Verified Claims

1. **Anonymous Auth Blocking in `requireOwner()`**:
   - *Claim*: Client rejects anonymous users with explicit error before sending requests to Firestore.
   - *Method*: Verified via `tests/firebase-sync-unit.test.ts:99-116` (`provider.push` with `{ uid: 'anon-123', isAnonymous: true }` rejects with `"Sign in with a verified account before enabling cloud synchronization."`). Also verified in `requireOwner()` implementation at `src/sync/firebase.ts:51-57`.
   - *Result*: **PASS**.

2. **Null `userId` for Anonymous Users**:
   - *Claim*: `provider.userId()` returns `null` if user is anonymous or null, preventing `engine.ts` from initiating sync.
   - *Method*: Verified via `tests/firebase-sync-unit.test.ts:118-128`.
   - *Result*: **PASS**.

3. **Config Environment Variable Fallback**:
   - *Claim*: `firebaseConfig` reads from `import.meta.env?.VITE_FIREBASE_*` with robust fallbacks to existing credentials.
   - *Method*: Verified via `src/firebase.ts:3-14` and `tests/firebase-sync-unit.test.ts:131-138`.
   - *Result*: **PASS**.

4. **Snapshot Listener Error Isolation & Notification**:
   - *Claim*: Firestore `onSnapshot` listeners catch errors, log warnings, store `lastSyncError` in `db.syncState`, and call optional `onError`.
   - *Method*: Verified via `tests/firebase-sync-unit.test.ts:140-157` where simulated disconnect successfully populates `db.syncState.get('lastSyncError')` and triggers `onErrorMock`.
   - *Result*: **PASS**.

5. **Firestore Security Rule Alignment**:
   - *Claim*: Security rules reject unauthenticated access, reject anonymous tokens, enforce path UID matching `/users/{uid}/{tableName}/{id}`, allow safe delete without `request.resource.data`, and deny unmapped paths by default.
   - *Method*: Verified via `tests/firestore-rules.test.ts` (14 passing tests) and inspection of `firestore.rules`.
   - *Result*: **PASS**.

6. **Composite Per-Table Cursor Handling**:
   - *Claim*: `pull()` parses per-table cursors, preventing update starvation across tables.
   - *Method*: Verified via `tests/sync.test.ts:135-256` and inspection of `src/sync/firebase.ts:198-241`.
   - *Result*: **PASS**.

---

### Coverage Gaps
- **Real Cloud Project Latency & Bandwidth Quotas**: Testing was conducted using in-memory mocks and local emulated environments in Vitest. Actual Google Cloud / Firebase service quotas and cloud latency depend on external connectivity.
  - *Risk Level*: Low. Architecture is offline-first; Dexie serves all reads/writes locally.
  - *Recommendation*: Accept risk; current test suite covers offline recovery, simulated disconnects, and conflict handling.

### Unverified Items
- None. All deliverables within Milestone 1 scope were directly executed and verified.

---

## 2. Adversarial Review

### Challenge Summary

**Overall Risk Assessment**: **`LOW`**

The architecture is defensive, resilient, and adheres strictly to the principle of least privilege. The sync engine is offline-first and prevents unauthenticated data leakage at both the client boundary and Firestore security rules boundary.

---

### Challenges

#### Challenge 1: Anonymous Session Escalation Bypass
- **Assumption Challenged**: An anonymous user might attempt to push local records to Firestore or read another user's cloud documents by invoking `push` or `pull` directly.
- **Attack Scenario**: An attacker runs `provider.push({ ... })` while `auth.currentUser` is an anonymous Firebase token.
- **Test / Verification**:
  1. Client boundary: `requireOwner()` checks `!user || user.isAnonymous` and throws immediately.
  2. Engine boundary: `provider.userId()` returns `null`, causing `engine.perform()` to abort before calling `push` or `pull`.
  3. Server boundary: `firestore.rules` enforces `request.auth.token.firebase.sign_in_provider != 'anonymous'`. Even if client-side checks were bypassed, the cloud rejects the operation with `PERMISSION_DENIED`.
- **Blast Radius**: Zero. Multi-layered defense (Client provider gate -> Engine gate -> Cloud security rules).
- **Status**: **PASS / MITIGATED**.

#### Challenge 2: Network Drop During Live Snapshot Subscription
- **Assumption Challenged**: Firestore snapshot subscriptions might crash the SPA or throw uncaught promise rejections if the user loses internet connection during active streaming.
- **Attack Scenario**: While subscribed to all 17 tables, WebSocket / HTTP long-polling drops. Firestore triggers the error callback.
- **Test / Verification**:
  - `src/sync/firebase.ts:268-275` provides the second callback parameter to `onSnapshot`.
  - Catches the error, logs via `console.warn`, safely writes to `db.syncState`, and calls `onError?.(error)`.
  - Does not crash the application or unmount React trees.
- **Blast Radius**: Isolated. State is marked with `lastSyncError`, and local Dexie operations continue unimpeded.
- **Status**: **PASS / MITIGATED**.

#### Challenge 3: Environment Variable Tampering or Missing Values
- **Assumption Challenged**: If `.env` defines an empty string (e.g. `VITE_FIREBASE_API_KEY=""`), or if the application runs in an environment where `import.meta.env` is undefined, initialization might throw or pass invalid config.
- **Attack Scenario**: Non-Vite execution environment or blank `.env` entry.
- **Test / Verification**:
  - `getEnv(val, fallback)` evaluates `val || fallback`. If `val` is empty string or undefined, it evaluates to falsy and cleanly returns the fallback string.
  - Optional chaining `import.meta.env?.VITE_...` prevents `TypeError: Cannot read properties of undefined`.
- **Blast Radius**: Zero. Always resolves to valid non-empty string.
- **Status**: **PASS / MITIGATED**.

#### Challenge 4: Malformed or Cross-Tenant Cloud Data Injection
- **Assumption Challenged**: A malicious cloud write or malformed document from another client could be broadcast over `onSnapshot` and corrupt local Dexie state.
- **Attack Scenario**: Cloud snapshot emits an entity belonging to another `ownerId` or with mismatched table name / version.
- **Test / Verification**:
  - `src/sync/firebase.ts:257-261` calls `remote(row, ownerId, tableName)`.
  - In `remote()`:
    ```typescript
    if (
      !FINANCE_TABLES.includes(tableName) ||
      !record ||
      record.ownerId !== ownerId ||
      row.owner_id !== ownerId ||
      record.id !== row.id ||
      record.version !== row.version
    ) {
      throw new Error('Cloud data failed ownership or version validation.');
    }
    ```
  - In `subscribe()`, lines 259-261: `catch { // Ignore ownership/schema failures }`.
  - Malformed documents are rejected and discarded; they never reach `callback(records)`.
- **Blast Radius**: Zero. Local Dexie tables remain uncorrupted.
- **Status**: **PASS / MITIGATED**.

---

### Stress Test Results

| Scenario | Expected Behavior | Actual Behavior | Result |
|---|---|---|---|
| Anonymous user calls `provider.push()` | Reject with clear verified account error | Throws `"Sign in with a verified account before enabling cloud synchronization."` | **PASS** |
| Anonymous user calls `provider.userId()` | Return `null` | Returns `null` | **PASS** |
| Verified user calls `provider.userId()` | Return verified UID string | Returns `'verified-user-789'` | **PASS** |
| Simulated snapshot error on 17 tables | Error logged, recorded in `db.syncState`, `onError` invoked, no unhandled exception | Handled across all 17 tables, `lastSyncError` persisted, `onError` called | **PASS** |
| Cross-table cursor synchronization | Table A advance does not starve Table B | Table A at 12:00, Table B at 08:00 pulls updates at 10:00 without skipping | **PASS** |
| Offline mutation outbox queuing | Outbox stores mutations offline, flushes on reconnect | 2 mutations queued, flushed to provider on sync, outbox drained | **PASS** |
| Sync conflict handling | Remote conflict preserved in `db.conflicts`, local data untouched | Conflict count = 1, local category unchanged, conflict entry logged | **PASS** |
| Firestore rules unauthenticated read | Deny read request | `evaluateUserPath` returns `false` | **PASS** |
| Firestore rules anonymous user read | Deny read request | `evaluateUserPath` returns `false` | **PASS** |
| Firestore rules delete operation | Allow without requiring `resource.data` | `evaluateUserPath` returns `true` | **PASS** |
| Production bundle compilation | Vite builds without errors | `tsc --noEmit && vite build` succeeds (exit 0) | **PASS** |
| Full Vitest suite | All test files pass | 22 test files passed, 429 tests passed (exit 0) | **PASS** |

---

### Unchallenged Areas
- **Direct Cloud Firestore live network latency**: Out of scope for client test harness; simulated with in-memory mocks.

---

## 3. Final Recommendation

**Milestone 1 is APPROVED.** The code quality, security posture, and test coverage meet all required standards.
