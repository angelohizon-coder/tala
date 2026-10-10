## 2026-10-09T18:56:56Z
You are Worker 1 (teamwork_preview_worker) for Milestone M1 (Architecture, Firebase Sync Engine & Supabase Removal) of the Tala financial SPA modernization project.
Your working directory is: e:\Visual Studio Code\tala\.agents\teamwork\worker_m1
The project root is: e:\Visual Studio Code\tala
Authoritative user request and requirements: e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md
Project plan and contracts: e:\Visual Studio Code\tala\PROJECT.md
Parent conversation ID: 64bc598d-7c84-4fe3-b439-553f079769f4

You must read `e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md`, `e:\Visual Studio Code\tala\PROJECT.md`, and the survey findings in `e:\Visual Studio Code\tala\.agents\teamwork\explorer_survey_1\survey_report.md` before starting work.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Exclusive file ownership for this milestone:
- src/sync/engine.ts
- src/sync/firebase.ts
- src/firebase.ts
- src/styles.css
- firestore.rules
- firebase.json
- supabase/ (deletion)
- README.md
- tests/firestore-rules.test.ts (or security rules tests)
- tests/sync.test.ts (or sync engine tests)

Tasks to implement:
1. Fix syntax errors in `src/sync/engine.ts` (unquoted `conflict:` and `cursor:` strings). Provide safe fallback for `navigator.locks` in Node environments so unit tests don't crash.
2. Fix file encoding for `src/firebase.ts`: convert from UTF-16LE to clean UTF-8 so Vite bundler can process it without error.
3. Fix PostCSS import order in `src/styles.css`: ensure all `@import` statements precede all other rules.
4. Purge Supabase completely: remove `supabase/` folder, clean references in `README.md`, ensure no lingering `@supabase` calls.
5. Harden Firestore Security Rules in `firestore.rules`:
   - Match `/users/{uid}/{tableName}/{id}`.
   - Enforce deny-by-default for all other paths.
   - Require authentication: `request.auth != null && request.auth.uid == uid`.
   - Explicitly reject anonymous tokens: `request.auth.token.firebase.sign_in_provider != 'anonymous'`.
   - Support `delete` without crashing on `request.resource.data` (which is null on delete).
   - Add unit/integration tests verifying that security rules reject mismatched UIDs and anonymous tokens.
6. Harden Sync Engine in `src/sync/engine.ts` and `src/sync/firebase.ts`:
   - Use `navigator.locks` to serialize multi-tab uploads and prevent duplicate records.
   - Upgrade `pull()` to use composite per-table cursors (`Record<string, string>`) so that advancing one table's timestamp does not starve or skip updates from other tables.
   - Ensure offline mutation queue persists in Dexie and seamlessly merges with remote Firestore upon reconnect.
   - Ensure legacy `migrateLegacyData` batches 500 items, normalizes records, and isolates them to `/users/{uid}/{tableName}/{id}`.
7. Verification requirements:
   - On Windows PowerShell, remember: `$env:PATH = "C:\Program Files\nodejs;$env:PATH"`.
   - Run typecheck: `node ./node_modules/typescript/bin/tsc --noEmit` or `npm.cmd run typecheck`.
   - Run build: `node ./node_modules/vite/bin/vite.js build` or `npm.cmd run build`.
   - Run tests: `node ./node_modules/vitest/vitest.mjs run tests/repository.test.ts` (and any new rules/sync tests).
   - All build and typecheck checks must pass with exit code 0.

Deliver your detailed report to `e:\Visual Studio Code\tala\.agents\teamwork\worker_m1\handoff.md` with:
- Observation (commands run and exact outputs)
- Logic Chain
- Caveats
- Conclusion
- Verification Method (with passing command outputs)
Send a message back when completed.
