# Empirical Adversarial Challenge Report: Firebase Auth, Error Isolation & Config

**Challenger**: Challenger M1-2  
**Milestone**: M1 (Core Currency, Valuation & Data Sync — R1 & R7)  
**Date**: 2026-10-10  
**Verdict**: **APPROVE**  

---

## 1. Challenge Summary

**Overall risk assessment**: **LOW**

Challenger M1-2 conducted empirical penetration testing and adversarial stress testing against Firebase authentication validation, Firestore snapshot listener error isolation, environment variable configuration resolution, multi-account mutation isolation, and network fault tolerance in Tala.

All adversarial tests passed empirically without regression across the codebase:
- 20 new adversarial tests written in `tests/challenger-m1-2-adversarial.test.ts` (100% pass rate).
- Full regression suite verified: 24 test files, 471 tests passing (0 failures).
- Zero unhandled promise rejections detected during simulated error storms across all 17 Firestore tables.
- Strict client-side boundary validation reliably blocks unauthenticated and anonymous tokens prior to network dispatch, in 100% alignment with `firestore.rules`.
- Zero compiler errors (`tsc --noEmit`) and successful production build (`vite build`).

---

## 2. Adversarial Challenges & Hypotheses

### [Low Risk] Challenge 1: Anonymous User State Transition & Data Contamination

- **Assumption Challenged**: Transitioning between anonymous, unauthenticated, and verified states might allow orphaned anonymous mutations to sync or corrupt cloud state.
- **Attack Scenario**:
  1. User starts in anonymous session (`isAnonymous: true`) and performs local mutations.
  2. User attempts cloud sync.
  3. User subsequently logs in with verified Google credentials.
  4. User attempts cloud sync again.
  5. User downgrades or logs out back to anonymous.
- **Empirical Findings**:
  - In `src/sync/firebase.ts:51-57`, `requireOwner()` strictly throws `'Sign in with a verified account before enabling cloud synchronization.'` for anonymous and null users.
  - In `src/sync/firebase.ts:140-144`, `provider.userId()` returns `null` for anonymous users.
  - In `src/sync/engine.ts:44-47`, `perform()` immediately aborts with `'Sign in and explicitly assign local records before syncing.'` when `provider.userId()` is null, keeping local outbox mutations queued without corruption.
  - Upon logging in with verified credentials, `provider.userId()` updates immediately, allowing authorized sync.
  - Upon logging out or session degradation, cloud access is immediately revoked at the boundary.
- **Blast Radius**: None. Boundary enforcement is airtight.
- **Result**: **PASS** (Protected).

---

### [Low Risk] Challenge 2: Snapshot Listener Error Storm Across Multi-Table Subscriptions

- **Assumption Challenged**: Multi-table snapshot listeners (17 tables) could produce unhandled promise rejections or cancel healthy sibling table listeners during network interruptions or permission errors.
- **Attack Scenario**:
  1. Inject simulated Firestore listener errors across all 17 tables simultaneously.
  2. Inject mixed scenarios where 3 tables fail (quota, permissions, indexing) while 14 tables remain healthy.
  3. Omit optional `onError` callback in `provider.subscribe(callback)`.
  4. Inject schema-corrupted or cross-UID spoofed documents into snapshot changes.
- **Empirical Findings**:
  - In `src/sync/firebase.ts:268-275`, the error callback catches listener errors, logs a warning, persists `lastSyncError` into `db.syncState`, and safely invokes optional `onError?.(error)`.
  - Simulating an error storm across all 17 tables simultaneously invoked `onError` 17 times with 0 unhandled promise rejections.
  - In mixed scenarios, healthy tables successfully delivered documents through to the data callback while errored tables were isolated without cross-table disruption.
  - When `onError` is omitted, `onError?.(error)` executes cleanly without exceptions.
  - In `src/sync/firebase.ts:257-261`, schema or ownership validation failures within `remote(row, ownerId, tableName)` are safely trapped in a `try-catch` block, silently dropping corrupted documents and preventing local state corruption.
- **Blast Radius**: None. Error isolation is robust across all 17 tables.
- **Result**: **PASS** (Protected).

---

### [Low Risk] Challenge 3: Environment Variable Resolution Under Malformed & Partial Input

- **Assumption Challenged**: Partial or malformed Vite environment variables (`import.meta.env`) might cause `firebaseConfig` to fail initialization or leave mandatory credentials undefined.
- **Attack Scenario**:
  1. Test empty string values (`""`) for `VITE_FIREBASE_*`.
  2. Test `undefined` values for all keys.
  3. Test partial configuration (e.g. valid `apiKey` but empty `authDomain`).
- **Empirical Findings**:
  - In `src/firebase.ts:3-14`, `getEnv = (val, fallback) => val || fallback` evaluates empty strings and `undefined` using logical OR fallback, guaranteeing that valid fallback credentials are always populated for all 8 keys (`apiKey`, `authDomain`, `databaseURL`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`, `measurementId`).
  - Partial configurations preserve valid custom strings while providing fallbacks for missing/empty variables.
- **Blast Radius**: None. Configuration is fully resilient.
- **Result**: **PASS** (Protected).

---

### [Low Risk] Challenge 4: Multi-User Account Switching & Outbox Cross-Contamination

- **Assumption Challenged**: When User A and User B use the same local browser instance, User A's un-synced outbox mutations could leak into User B's Firestore account upon login.
- **Attack Scenario**:
  1. User A queues mutations with `ownerId: 'user-alice'`.
  2. User B logs in with `ownerId: 'user-bob'`.
  3. User B triggers sync.
- **Empirical Findings**:
  - In `src/sync/engine.ts:51-55`, the engine queries `db.syncOutbox.where('ownerId').equals(ownerId)`.
  - User B's sync only processes entries where `ownerId === 'user-bob'`. User A's records remain untouched in the local outbox.
  - Furthermore, in `src/sync/firebase.ts:147`, `requireOwner()` enforces `entry.ownerId === ownerId && entry.payload.ownerId === ownerId`, preventing cross-account writes even if invoked directly.
- **Blast Radius**: None. Multi-user isolation is enforced at both engine and provider layers.
- **Result**: **PASS** (Protected).

---

### [Low Risk] Challenge 5: Malformed Pull Cursor Recovery

- **Assumption Challenged**: Corrupted or non-JSON cursor strings stored in `db.syncState` could cause `JSON.parse` to throw and permanently break `provider.pull()`.
- **Attack Scenario**:
  1. Pass malformed JSON (`"{invalid: !!"`), array JSON (`"[1,2]"`), or scalar numbers (`"123"`) to `provider.pull(cursor)`.
- **Empirical Findings**:
  - In `src/sync/firebase.ts:200-212`, cursor parsing is wrapped in `try-catch`, falling back to per-table assignments if JSON parsing fails.
  - Pull executed without exceptions across all malformed inputs and returned valid composite JSON cursors.
- **Blast Radius**: None. Cursor recovery operates gracefully.
- **Result**: **PASS** (Protected).

---

### [Low Risk] Challenge 6: External FX Network Disruptions & `safeRefreshFx` Resilience

- **Assumption Challenged**: Upstream ExchangeRate-API outages (HTTP 500, HTML error pages, malformed JSON, timeouts) could crash application boot or base currency switches via unhandled promise rejections.
- **Attack Scenario**:
  1. Simulate HTTP 500 Internal Server Error from external FX API.
  2. Simulate malformed JSON response body (`SyntaxError`).
- **Empirical Findings**:
  - In `src/market/providers.ts:43-50`, `safeRefreshFx` encapsulates the network call in a `try-catch` block, returning `{ ok: false, error: ... }` rather than throwing.
  - App boot (`src/App.tsx`) and currency changes (`src/pages/Overview.tsx`) consume `safeRefreshFx` without uncaught promise rejections, smoothly falling back to Dexie `DEFAULT_FX_SEEDS` (15 baseline floor rates).
- **Blast Radius**: None. Failure isolation is complete.
- **Result**: **PASS** (Protected).

---

## 3. Stress Test Results Summary

| Test Area | Scenario | Expected Behavior | Actual Behavior | Result |
| :--- | :--- | :--- | :--- | :--- |
| **Auth Boundary** | Unauthenticated user calls `push`/`pull`/`subscribe` | Rejects with verified account error; `userId()` is `null` | Threw explicit error; `userId()` returned `null` | **PASS** |
| **Auth Boundary** | Anonymous user calls `push`/`pull`/`subscribe` | Rejects with verified account error; `userId()` is `null` | Threw explicit error; `userId()` returned `null` | **PASS** |
| **Auth Transition** | Anonymous user links / signs in as verified | Sync unlocks, `userId()` updates, push/pull succeed | Successfully transitioned, pushed valid account | **PASS** |
| **Auth Transition** | Verified user degrades to anonymous / signs out | Sync locks, `userId()` is null, push fails | Cloud access immediately revoked | **PASS** |
| **Payload Security** | Verified user pushes payload with spoofed `ownerId` | Rejects with account mismatch error | Threw `'The queued change belongs to another account.'` | **PASS** |
| **Listener Isolation** | 1 table experiences Firestore listener error | Error isolated, `lastSyncError` stored, `onError` called | Error isolated, warning logged, `db.syncState` updated | **PASS** |
| **Listener Isolation** | All 17 tables experience listener error storm | No unhandled rejections, all 17 reported to `onError` | Handled gracefully, 17 callbacks invoked, zero unhandled rejections | **PASS** |
| **Listener Isolation** | 3 tables fail, 14 tables healthy | Healthy tables receive documents; failed tables report errors | Categories delivered to data callback; errors isolated | **PASS** |
| **Listener Isolation** | `onError` callback omitted | No crash; optional chaining protects execution | Succeeded without exceptions | **PASS** |
| **Listener Isolation** | Snapshot contains tampered `owner_id` or schema | Tampered doc discarded; not forwarded to callback | Schema validation in `remote()` caught and dropped doc | **PASS** |
| **Config Resolution** | All 8 config keys tested with default fallbacks | Matches expected project credentials | All 8 keys verified | **PASS** |
| **Config Resolution** | Empty string `""` and `undefined` env vars | Falls back to static defaults | Fallback values returned cleanly | **PASS** |
| **Config Resolution** | Partial env vars (custom `apiKey`, missing others) | Custom overrides where provided, fallbacks elsewhere | Resolved correctly | **PASS** |
| **Sync Engine** | Anonymous user triggers `engine.syncNow()` | Aborts with explicit error; preserves outbox | Threw error; outbox preserved | **PASS** |
| **Sync Engine** | Verified user triggers `engine.syncNow()` | Pushes outbox entries and clears queue | Uploaded 2 entries; outbox cleared | **PASS** |
| **Security Rules** | Firestore rules evaluated against anonymous tokens | Denies read, write, create, update, delete | Evaluated to false across all paths | **PASS** |
| **Multi-User Sync** | User B syncs while User A has queued mutations | User A mutations isolated and not uploaded | Uploaded only User B mutations; User A preserved | **PASS** |
| **Cursor Recovery** | Malformed / non-JSON pull cursor passed | Falls back safely; returns valid composite cursor | Parsed fallback cleanly without throwing | **PASS** |
| **FX Fault Tolerance**| External FX API returns HTTP 500 | `safeRefreshFx` returns `{ ok: false }` without crashing | Handled gracefully without unhandled rejection | **PASS** |
| **FX Fault Tolerance**| External FX API returns malformed JSON | `safeRefreshFx` returns `{ ok: false }` without crashing | Handled gracefully without unhandled rejection | **PASS** |

---

## 4. Unchallenged Areas

- **IndexedDB SQLite disk corruption at OS level**: Out of scope for browser client unit testing; handled by IndexedDB browser engine.
- **Physical network partition during partial Web Batch commit**: Out of scope; Firestore transactions guarantee server-side atomicity.

---

## 5. Conclusion & Final Verdict

All Firebase authentication validation, Firestore snapshot listener error isolation, environment variable configuration resolution, and sync engine reliability requirements are empirically validated and hardened against adversarial conditions.

**Final Verdict**: **APPROVE**
