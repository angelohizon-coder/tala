# Dispatch for Explorer M1-3

## Identity & Role
- Role: Firebase Sync & Security Explorer
- Working directory: e:/Visual Studio Code/tala/.agents/teamwork/explorer_m1_3/
- Original Request path: e:/Visual Studio Code/tala/.agents/teamwork/ORIGINAL_REQUEST.md
- Project Scope: e:/Visual Studio Code/tala/PROJECT.md
- Project Root: e:/Visual Studio Code/tala

## Milestone 1: Firebase Synchronization & Security Hardening (R7)
Focus on `src/sync/firebase.ts`, `src/firebase.ts`, and `firestore.rules`:
1. In `src/sync/firebase.ts` (`requireOwner`): Add check `if (!user || user.isAnonymous) throw new Error('Sign in with a verified account before enabling cloud synchronization.');` to match Firestore rules which reject anonymous auth.
2. In `src/firebase.ts`: Replace hardcoded config keys with `import.meta.env.VITE_FIREBASE_*` variables, retaining safe default fallbacks.
3. In `src/sync/firebase.ts`: Inspect snapshot listeners (`onSnapshot`). Add error callbacks so connection drops or permission denials are caught and logged/dispatched rather than crashing the app.
4. Verify offline outbox mutation queuing (`db.syncOutbox`) behavior during offline state and reconnection.

Write your findings to `e:/Visual Studio Code/tala/.agents/teamwork/explorer_m1_3/report.md` and a self-contained `handoff.md`. Notify the orchestrator via `send_message`.

## 2026-10-10T14:12:31Z
[Message] timestamp=2026-10-10T14:12:31Z sender=eda11da7-95b7-4ab4-bbe9-521cf16c63d4 priority=MESSAGE_PRIORITY_HIGH content=You are Explorer M1-3 for Tala Milestone 1.
Your working directory is: e:/Visual Studio Code/tala/.agents/teamwork/explorer_m1_3/
The project root is: e:/Visual Studio Code/tala
Authoritative User Request: e:/Visual Studio Code/tala/.agents/teamwork/ORIGINAL_REQUEST.md
Your detailed instructions are in: e:/Visual Studio Code/tala/.agents/teamwork/explorer_m1_3/DISPATCH.md

Read ORIGINAL_REQUEST.md, PROJECT.md, and DISPATCH.md first.
Explore src/sync/firebase.ts, src/firebase.ts, and firestore.rules. Design:
1. Block anonymous tokens in requireOwner().
2. Load Firebase config from import.meta.env with fallback in src/firebase.ts.
3. Add error handler callbacks to onSnapshot listeners.
4. Verify offline outbox mutation queuing.
Document your findings in report.md and write a handoff.md. Notify orchestrator via send_message.
