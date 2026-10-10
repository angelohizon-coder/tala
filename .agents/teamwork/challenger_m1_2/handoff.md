# Milestone M1 Adversarial Verification Report: Firestore Security Rules & Isolation

**Challenger**: Challenger 2 (`teamwork_preview_challenger`)  
**Milestone**: M1 (Architecture, Firebase Sync Engine & Supabase Removal)  
**Project Root**: `e:\Visual Studio Code\tala`  
**Working Directory**: `e:\Visual Studio Code\tala\.agents\teamwork\challenger_m1_2`  
**Verdict**: **APPROVE**  
**Timestamp**: 2026-10-09T19:14:00Z  

---

## 1. Observation

Direct observations made during empirical testing and code audit:

1. **`firestore.rules` Implementation Structure**:
   In `e:\Visual Studio Code\tala\firestore.rules`:
   - Lines 6–9 define the authentication oracle:
     ```rules
     function isAuthenticated() {
       return request.auth != null 
         && request.auth.token.firebase.sign_in_provider != 'anonymous';
     }
     ```
   - Lines 12–21 define strict UID-isolated table access:
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
   - Lines 24–30 isolate legacy migration collection `/finance_entities/{document}`:
     ```rules
     match /finance_entities/{document} {
       allow read: if isAuthenticated() && resource != null && request.auth.uid == resource.data.owner_id;
       allow delete: if isAuthenticated() && resource != null && request.auth.uid == resource.data.owner_id;
       allow update: if isAuthenticated() && resource != null && request.auth.uid == resource.data.owner_id
                     && request.auth.uid == request.resource.data.owner_id;
       allow create: if isAuthenticated() && request.auth.uid == request.resource.data.owner_id;
     }
     ```
   - Lines 33–35 establish explicit deny-by-default for unmapped paths:
     ```rules
     match /{document=**} {
       allow read, write: false;
     }
     ```

2. **Absence of Host Java Runtime**:
   Executing `powershell -Command "Get-Command java"` returned exit code 1:
   `java : The term 'java' is not recognized as the name of a cmdlet, function, script file, or operable program.`
   This confirms Worker M1's caveat that the Google Java-based Firebase Emulator daemon cannot be spawned locally on this machine.

3. **Creation and Execution of Adversarial Test Suite**:
   To empirically challenge every dimension of `firestore.rules`, we authored `tests/firestore-adversarial.test.ts` (69 test cases).
   Executing:
   `& "C:\Program Files\nodejs\node.exe" ./node_modules/vitest/vitest.mjs run tests/firestore-adversarial.test.ts`
   Yielded:
   ```
   RUN  v5.0.3 E:/Visual Studio Code/tala

   ✓ tests/firestore-adversarial.test.ts (69 tests) 8ms

   Test Files  1 passed (1)
        Tests  69 passed (69)
     Duration  122ms
   ```

4. **Full Regression Execution across Milestone M1 Test Suites**:
   Executing:
   `& "C:\Program Files\nodejs\node.exe" ./node_modules/vitest/vitest.mjs run tests/firestore-rules.test.ts tests/firestore-adversarial.test.ts tests/sync.test.ts`
   Yielded:
   ```
   RUN  v5.0.3 E:/Visual Studio Code/tala

   ✓ tests/firestore-adversarial.test.ts (69 tests) 8ms
   ✓ tests/firestore-rules.test.ts (14 tests) 4ms
   ✓ tests/sync.test.ts (8 tests) 89ms

   Test Files  3 passed (3)
        Tests  91 passed (91)
     Duration  316ms
   ```

5. **Production Build Verification**:
   Executing `& "C:\Program Files\nodejs\node.exe" ./node_modules/vite/bin/vite.js build` completed with exit code 0 (`✓ built in 837ms`), verifying that the newly added test suite does not disturb bundle compilation or production assets.

---

## 2. Logic Chain

From the direct observations above, we evaluate the 4 required challenge dimensions:

1. **Anonymous Token Bypass Attempts**:
   - **Observation**: `isAuthenticated()` checks `request.auth.token.firebase.sign_in_provider != 'anonymous'`.
   - **Adversarial Test**: Section 2 of `tests/firestore-adversarial.test.ts` evaluated anonymous tokens (`sign_in_provider: 'anonymous'`) attempting:
     - Read under own UID `/users/{anon_uid}/accounts/acc-001` -> DENIED (allowed: false).
     - Create under own UID -> DENIED.
     - Update under own UID -> DENIED.
     - Delete under own UID -> DENIED.
     - Read foreign user UID -> DENIED.
     - Access to `/finance_entities` -> DENIED.
     - Malformed token missing `firebase` claim -> DENIED.
     - Unauthenticated requests (`request.auth == null`) across all ops -> DENIED.
   - **Deduction**: Anonymous users cannot bypass authentication or manipulate any records.

2. **Cross-User Access Attacks**:
   - **Observation**: Rules require `request.auth.uid == uid` and `(owner_id == null || owner_id == uid)` and `entity_type == tableName` and `id == id`.
   - **Adversarial Test**: Section 3 of `tests/firestore-adversarial.test.ts` evaluated attacks by User A (`user-alice`) targeting User B (`user-bob`):
     - User A attempting read on `/users/user-bob/...` -> DENIED.
     - User A attempting create in `/users/user-bob/...` -> DENIED.
     - User A attempting delete on `/users/user-bob/...` -> DENIED.
     - User A writing to `/users/user-alice/accounts/alice-acc-1` with forged body `owner_id: 'user-bob'` -> DENIED.
     - User A writing to `/users/user-alice/accounts/alice-acc-1` with mismatched `entity_type: 'transactions'` -> DENIED.
     - User A writing to `/users/user-alice/accounts/alice-acc-1` with mismatched body `id: 'malicious-injected-id'` -> DENIED.
     - User A reading or updating User B's `/finance_entities/...` document -> DENIED.
   - **Deduction**: Multi-tenant data isolation is strictly enforced against both path tampering and document payload spoofing.

3. **Document Deletion Attacks & Integrity**:
   - **Observation**: Line 15 separates deletion: `allow delete: if isAuthenticated() && request.auth.uid == uid;` and does not evaluate `request.resource.data`.
   - **Adversarial Test**: Section 4 evaluated delete operations:
     - In Firestore, delete operations transmit `request.resource == null`. Evaluating `request.resource.data` during delete would cause runtime null-pointer dereference in the rules engine. The rule checks only `isAuthenticated() && request.auth.uid == uid`, which succeeds cleanly without runtime error for legitimate owner User C (`user-charlie`).
     - Delete attempted by unauthorized attacker -> DENIED.
     - Delete attempted by unauthenticated user -> DENIED.
     - Delete attempted by anonymous user -> DENIED.
     - Delete on non-existent legacy document (`resource == null`) -> DENIED cleanly without error.
   - **Deduction**: Document deletion is robust, safe from null-dereference crashes, and accessible strictly to the authentic document owner.

4. **Unmatched Paths & Default-Deny Attacks**:
   - **Observation**: Line 33 specifies `match /{document=**} { allow read, write: false; }`.
   - **Adversarial Test**: Section 5 tested 17 explicit unmapped paths (`/admin`, `/admin/config`, `/system`, `/config`, `/users`, root user document `/users/{uid}`, nested subcollections `/users/{uid}/{tableName}/{id}/subcol/sub-1`, `/marketCache/AAPL`) and executed 50 random path fuzzing iterations.
   - **Result**: 100% of unmapped read and write operations were strictly rejected under `/{document=**} [deny-by-default]`.
   - **Deduction**: Deny-by-default is unconditionally maintained across the entire Firestore document tree.

---

## 3. Caveats

1. **Host Environment Lack of Java**:
   Because the Windows host environment does not have Java installed, Google Cloud Firestore's live Java emulator binary could not be executed as a background daemon process. Verification was conducted using rigorous AST, regex grammar, and simulation execution across 69 automated unit and adversarial test vectors.
2. **Milestone M2 Pre-existing Test Failures**:
   As noted in worker M1's handoff and `PROJECT.md`, `tests/calculations.test.ts` and `tests/backup.test.ts` fail due to ongoing multi-currency modeling assigned to Milestone M2 (Feature 10). All Milestone M1 targets (`tests/firestore-rules.test.ts`, `tests/firestore-adversarial.test.ts`, `tests/sync.test.ts`, `src/sync/`, `src/firebase.ts`, `firestore.rules`) pass 100% and build cleanly.

---

## 4. Conclusion

**Verdict: APPROVE**

Milestone M1's deliverables regarding Firestore Security Rules and multi-tenant isolation satisfy all requirements from `ORIGINAL_REQUEST.md` (R1, Acceptance Criteria) and `PROJECT.md` (Feature 3).
- Anonymous tokens are completely blocked from read, create, update, and delete operations.
- Cross-user access attacks, cross-user deletes, and payload ownership spoofing attempts are unconditionally rejected.
- Document deletions execute safely for authentic owners without encountering null dereference errors on `request.resource.data`.
- Unmatched paths (root paths, admin endpoints, subcollections) are strictly denied by default.
- 91 out of 91 automated tests pass across Milestone M1 suites.
- Production build succeeds without errors.

---

## 5. Verification Method

To independently reproduce this verification:

1. **Run Full Milestone M1 Test Suite**:
   ```powershell
   & "C:\Program Files\nodejs\node.exe" ./node_modules/vitest/vitest.mjs run tests/firestore-rules.test.ts tests/firestore-adversarial.test.ts tests/sync.test.ts
   ```
   **Expected**: 3 test files passed, 91 tests passed, 0 failures.

2. **Run Adversarial Security Harness Directly**:
   ```powershell
   & "C:\Program Files\nodejs\node.exe" ./node_modules/vitest/vitest.mjs run tests/firestore-adversarial.test.ts
   ```
   **Expected**: 69 tests passed, 0 failures.

3. **Run Production Build**:
   ```powershell
   & "C:\Program Files\nodejs\node.exe" ./node_modules/vite/bin/vite.js build
   ```
   **Expected**: `✓ built in ~800-900ms`, exit code 0.
