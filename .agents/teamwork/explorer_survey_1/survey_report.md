# Phase 0 Architectural Survey Report: Tala Financial SPA Modernization

**Project**: Tala Financial SPA Modernization  
**Role**: Survey Explorer 1 (`teamwork_preview_explorer`)  
**Date**: October 9, 2026 (Investigation Timestamp: 2026-10-09T18:55:00Z)  
**Project Root**: `e:\Visual Studio Code\tala`  
**Reference Document**: `e:\Visual Studio Code\tala\.agents\teamwork\ORIGINAL_REQUEST.md`

---

## 1. Executive Summary

This survey establishes the architectural and technical baseline for Phase 0 of the Tala modernization project, focusing on **Codebase Structure, Architecture, Firebase Sync Engine, and Legacy Supabase/`finance_entities` Cleanup**.

Key high-level findings:
1. **Repository Health**: The repository contains a hybrid React 19 SPA + Cloudflare Worker/Firebase Cloud Functions architecture. While 141 market tests pass (`node --test tests/*.test.mjs`), the TypeScript compilation (`tsc --noEmit`) and Vitest test suites currently fail due to three localized defects:
   - Syntax error in `src/sync/engine.ts` (unquoted string literals on lines 27, 38, 41).
   - Character encoding mismatch in `src/firebase.ts` (UTF-16LE instead of UTF-8, blocking Vite build).
   - In-flight transition of account balances from single numeric balances to multi-currency sub-ledgers (`Record<string, Record<Currency, Money>>`), breaking older assertions in `tests/calculations.test.ts` and `tests/backup.test.ts`.
2. **Supabase Removal**: `@supabase/supabase-js` has been removed from `package.json`, but remnants persist in `package-lock.json`, `supabase/schema.sql`, and `README.md`. No active imports exist in `src/`.
3. **Legacy `finance_entities` & Storage**: Financial data is never stored in `localStorage`; local persistence is exclusively Dexie IndexedDB (`tala-finance`, schema version 2). Remote legacy data existed in root collection `/finance_entities/{document}`. A migration function exists in `src/sync/firebase.ts` but has idempotency and cursor deficiencies.
4. **Firestore Security & Emulators**: Firestore rules currently allow read/write for matching UIDs but fail to reject **anonymous users**, and document deletion will fail due to rules evaluating non-existent `request.resource.data`. Emulators and `@firebase/rules-unit-testing` are not yet configured in `firebase.json` or `package.json`.
5. **Sync Engine**: Implements Web Locks (`navigator.locks`) and an offline Dexie outbox, but its Firestore pull mechanism uses a shared single-timestamp cursor with `>=` operators that risks missing multi-table updates and repeatedly re-fetching boundary records.
6. **GitHub Pages Compatibility**: The base path is currently relative (`./`), which conflicts with React Router v7's `BrowserRouter` expectation of an absolute `basename`.

---

## 2. Codebase Structure, Dependencies & Build System

### 2.1 Directory Hierarchy

```
e:\Visual Studio Code\tala\
├── .firebaserc                     # Firebase project mapping ("kotoba-41ab0")
├── firebase.json                   # Hosting, firestore, functions config (missing emulators)
├── firestore.indexes.json          # Composite index for legacy finance_entities
├── firestore.rules                 # Security rules for /users/{uid}/{tableName}/{id} and legacy
├── functions/                      # Firebase Cloud Functions (v2 HTTPS market gateway)
│   ├── package.json                # Dependencies: firebase-admin, firebase-functions, axios
│   ├── tsconfig.json
│   └── src/index.ts                # getMarketQuote with strict CORS origin whitelist
├── index.html                      # SPA entry point with GitHub Pages 404 redirect decoder
├── package.json                    # Root project dependencies and scripts
├── package-lock.json
├── postcss.config.js               # PostCSS with tailwindcss and autoprefixer
├── public/                         # Public assets (404.html, icon.svg, icons/)
├── scripts/                        # Utility scripts (generate-demo.mjs, import-funds.mjs)
├── site/                           # Legacy static market dashboard copied to dist/legacy-market
├── src/                            # Modern React SPA source
│   ├── App.tsx                     # Main application shell, router, navigation
│   ├── components/                 # Shared UI components
│   ├── core/                       # Pure financial calculation engine and domain types
│   │   ├── calculations.ts         # Ledgers, cash flows, net worth, positions, Monte Carlo
│   │   └── types.ts                # Core types: Account, Transaction, Money (minor units), etc.
│   ├── db/                         # Client database & repository layer (Dexie)
│   │   ├── backup.ts               # AES-GCM encrypted export/import & CSV export
│   │   ├── csv.ts                  # CSV parsing helpers
│   │   ├── database.ts             # Dexie schema definition (17 finance tables + outbox)
│   │   └── repository.ts           # Atomic repository operations, validation, conflict resolution
│   ├── firebase.ts                 # Firebase Client SDK initialization (UTF-16LE defect)
│   ├── hooks/                      # React hooks (useRouteFocus, etc.)
│   ├── lib/                        # Utility libraries
│   ├── main.tsx                    # ReactDOM root mounting with BrowserRouter
│   ├── market/                     # Market data client layer
│   ├── pages/                      # Page components (Overview, LedgerPages, PlanningPages, DataPage)
│   ├── styles.css                  # Tailwind styles and theme (PostCSS import order defect)
│   ├── sync/                       # Synchronization engine
│   │   ├── engine.ts               # Web Locks coordinator, outbox drain, pull driver (syntax defect)
│   │   ├── firebase.ts             # Firestore SyncProvider implementation
│   │   └── provider.ts             # SyncProvider interface definition
│   └── ui/                         # UI runtime and helper state
├── supabase/                       # Legacy Supabase artifacts
│   └── schema.sql                  # Legacy PostgreSQL schema for public.finance_entities
├── tailwind.config.js              # Tailwind CSS configuration
├── tests/                          # Automated test suites
│   ├── backup.test.ts              # Encrypted backups and validation (Vitest)
│   ├── calculations.test.ts        # Ledger calculations and Monte Carlo (Vitest)
│   ├── client.test.mjs             # Market client unit tests (Node test runner)
│   ├── csv.test.ts                 # CSV parsing tests (Vitest)
│   ├── data.test.mjs               # Market data tests (Node test runner)
│   ├── free-*.test.mjs             # Market provider integration tests (Node test runner)
│   ├── local-gateway.test.mjs      # Local gateway tests (Node test runner)
│   ├── repository.test.ts          # Dexie atomic transactions and sync engine (Vitest)
│   └── worker.test.mjs             # Cloudflare worker market gateway tests (Node test runner)
├── tools/                          # End-to-end browser check scripts (Playwright / Puppeteer)
│   ├── browser-check.mjs
│   └── finance-browser-check.mjs
├── tsconfig.json                   # Root TypeScript configuration
├── vitest.config.ts                # Vitest configuration (testTimeout: 30000)
└── worker/                         # Cloudflare worker source and wrangler config
```

### 2.2 Dependency Audit (`package.json`)

```json
{
  "dependencies": {
    "dexie": "^4.4.6",
    "dexie-react-hooks": "^4.4.0",
    "firebase": "^11.0.0",
    "hyparquet": "^1.31.3",
    "hyparquet-compressors": "^1.1.2",
    "lucide-react": "^1.54.0",
    "papaparse": "^5.7.0",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "react-router-dom": "^7.18.4",
    "recharts": "^3.10.1"
  },
  "devDependencies": {
    "@playwright/test": "^1.64.0",
    "@types/node": "^26.6.4",
    "@types/papaparse": "^5.5.2",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.2",
    "autoprefixer": "^10.4.19",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.1",
    "fake-indexeddb": "^6.2.5",
    "postcss": "^8.4.38",
    "tailwind-merge": "^2.3.0",
    "tailwindcss": "^3.4.4",
    "typescript": "^7.0.2",
    "vite": "^8.3.4",
    "vite-plugin-pwa": "^2.0.0",
    "vitest": "^5.0.3"
  }
}
```

Missing devDependencies required for the modernized acceptance criteria:
- `@firebase/rules-unit-testing`: Required for Firestore Security Rules emulator unit tests.

### 2.3 Existing Build & Verification Defects

Direct observation of tool commands reveals three immediate blocking issues:

1. **`src/sync/engine.ts` Syntax Error**:
   - Lines 27, 38, 41 contain unquoted string concatenation syntax:
     ```ts
     // Line 27:
     id: conflict: + entry.tableName + : + entry.entityId + : + response.record.record.version,
     // Line 38:
     const cursor = (await db.syncState.get(cursor: + ownerId))?.value;
     // Line 41:
     await db.syncState.put({ id: cursor: + ownerId, value: pulled.cursor });
     ```
   - Must be corrected to:
     ```ts
     id: `conflict:${entry.tableName}:${entry.entityId}:${response.record.record.version}`,
     const cursor = (await db.syncState.get(`cursor:${ownerId}`))?.value;
     await db.syncState.put({ id: `cursor:${ownerId}`, value: pulled.cursor });
     ```
   - This defect breaks `npm run typecheck` (`TS1005: ',' expected`) and causes Vitest to fail when compiling `tests/repository.test.ts`.

2. **`src/firebase.ts` UTF-16LE Encoding Issue**:
   - File length: 1,042 bytes. When inspected via Vite build (`debug_build.txt`), Vite produces:
     `[UNLOADABLE_DEPENDENCY] Could not load src/firebase.ts ... stream did not contain valid UTF-8`.
   - Tool `view_file` also reported `unsupported mime type text/plain; charset=utf-16le`.
   - Must be re-saved as standard UTF-8 without BOM.

3. **`src/styles.css` PostCSS Import Ordering**:
   - `debug_build.txt` line 7-11 shows:
     `@import statements must precede all other statements (besides @charset or empty @layer) and be consecutive`.
   - `@import url('https://fonts.googleapis.com/...');` is placed below `@tailwind utilities;`. It must be moved to the very top of `src/styles.css` prior to `@tailwind` directives.

4. **Multi-Currency Test Mismatch in `tests/calculations.test.ts` & `tests/backup.test.ts`**:
   - `buildLedger` and `accountBalances` return `{ [accountId]: { [currency]: balance } }` to support multi-currency sub-ledgers.
   - Older test assertions expected `{ cash: 85000, card: 9500 }`.
   - When R2 multi-currency modeling is finalized, tests and repository methods must align on sub-ledger representation.

---

## 3. Legacy Supabase Usage & Complete Removal Plan

### 3.1 Codebase Survey of Supabase References

A recursive grep search across the codebase (`grep_search`) confirmed:
- **`src/`**: Zero occurrences of `@supabase`, `supabase`, `createClient`, or Supabase-related configurations.
- **`tests/`**, **`tools/`**, **`scripts/`**, **`worker/`**, **`functions/`**: Zero references.
- **`package.json`**: No Supabase dependencies in `dependencies` or `devDependencies`.

However, Supabase artifacts still linger in four locations:
1. **`package-lock.json`**:
   - `@supabase/supabase-js` v2.117.3
   - `@supabase/auth-js` v2.117.3
   - `@supabase/functions-js` v2.117.3
   - `@supabase/phoenix` v0.4.5
   - `@supabase/postgrest-js` v2.117.3
   - `@supabase/realtime-js` v2.117.3
   - `@supabase/storage-js` v2.117.3
2. **`supabase/schema.sql`**:
   - A 67-line PostgreSQL script defining table `public.finance_entities`, index `finance_owner_updates`, row level security policies, `apply_finance_mutation` PL/pgSQL function with `pg_advisory_xact_lock`, and private realtime broadcast triggers.
3. **`README.md`**:
   - Lines 50–61 contain an entire section entitled `## Optional Supabase synchronization`, instructing users to execute `supabase/schema.sql`, set up Supabase projects, and configure broadcast policies.
4. **`tools/` and documentation**:
   - Mentions in README referencing Supabase owner RLS.

### 3.2 Removal Plan

1. **Delete File/Folder**:
   - Delete directory `e:\Visual Studio Code\tala\supabase/` and `supabase/schema.sql`.
2. **Prune Package Lock**:
   - Run `npm prune` (or `npm install` with updated package lock) to ensure `@supabase/*` modules are completely expunged from `node_modules` and `package-lock.json`.
3. **Documentation Rewrite**:
   - In `README.md`, replace the `Optional Supabase synchronization` section with the authoritative Firebase Firestore synchronization documentation, explaining Firestore `/users/{uid}/{tableName}/{id}` structure, Google OAuth, and offline Dexie synchronization.
4. **Verification**:
   - Grep search repository to ensure 0 matches for `supabase` (case-insensitive).

---

## 4. Legacy `finance_entities` Data Structures & Migration Architecture

### 4.1 Schema Comparison: Legacy vs Target

| Property | Legacy Supabase / Firestore Root (`finance_entities`) | Modern Target Firestore (`/users/{uid}/{tableName}/{id}`) | Client IndexedDB (`tala-finance`) |
| :--- | :--- | :--- | :--- |
| **Path / Table** | Root table/collection `finance_entities` | Subcollection `/users/{uid}/{tableName}/{id}` | Individual Dexie table per entity (`accounts`, `transactions`, etc.) |
| **Partitioning** | Partitioned by `owner_id` column / field | Partitioned naturally by path `{uid}` | Partitioned locally; records stamped with `ownerId` |
| **Entity Type** | `entity_type` field (1 of 17 string values) | Inferred from `{tableName}` subcollection | Dedicated Dexie table name |
| **Identifier** | `id` field | Document ID `{id}` | Primary key `id` |
| **Payload** | Nested `payload` JSON object | Flat document fields matching entity schema + metadata | Flat entity record |
| **Metadata** | `version`, `deleted_at`, `device_id`, `created_at`, `updated_at` | `version`, `deleted_at`, `device_id`, `created_at`, `updated_at` | Stored directly on Dexie record |

The 17 supported financial entity types defined in `FINANCE_TABLES` (`src/db/database.ts:30`):
```ts
export const FINANCE_TABLES: FinanceTableName[] = [
  'accounts', 'institutions', 'transactions', 'postings', 'categories',
  'tags', 'transactionTags', 'instruments', 'investmentLots', 'prices',
  'fxRates', 'budgets', 'recurringRules', 'goals', 'liabilityTerms',
  'balanceSnapshots', 'settings'
];
```

### 4.2 Storage Layer Architecture

- **Client Storage**:
  - `localStorage`: Explicitly prohibited for financial data. Used only in `site/` (legacy static dashboard) for UI watchlist state.
  - `Dexie` IndexedDB (`tala-finance`, version 2): Sole authoritative store on the client. All UI reads subscribe reactively via `useLiveQuery`.
- **Remote Storage**:
  - Target: Google Cloud Firestore in native mode.
  - Document path: `/users/{uid}/{tableName}/{id}`.

### 4.3 Migration Engine in `src/sync/firebase.ts`

Lines 26–63 of `src/sync/firebase.ts` contain the initial implementation:
```ts
async function migrateLegacyData(ownerId: string) {
  const flag = await db.syncState.get('legacyMigrated');
  if (flag?.value === true) return;

  let q = query(
    collection(firestore, 'finance_entities'),
    where('owner_id', '==', ownerId),
    orderBy('updated_at', 'asc')
  );

  let snapshot = await getDocs(q);
  if (!snapshot.empty) {
    let batch = writeBatch(firestore);
    let count = 0;
    for (const docSnap of snapshot.docs) {
      const row = docSnap.data();
      const tableName = row.entity_type as FinanceTableName;
      if (!FINANCE_TABLES.includes(tableName)) continue;
      
      const newRef = doc(firestore, 'users', ownerId, tableName, row.id);
      batch.set(newRef, row);
      count++;

      if (count >= 500) {
        await batch.commit();
        batch = writeBatch(firestore);
        count = 0;
      }
    }
    if (count > 0) {
      await batch.commit();
    }
  }

  await db.syncState.put({ id: 'legacyMigrated', value: true });
}
```

### 4.4 Migration Vulnerabilities & Necessary Enhancements

1. **Unbounded Firestore Fetch**: `getDocs(q)` fetches all legacy records into memory. For large accounts, this query should be paginated using `limit(500)` and `startAfter(docSnap)` to avoid browser memory pressure.
2. **Partial Migration Failure**: If the network drops after the first batch of 500 commits, `legacyMigrated` is not written. Upon retry, already-copied records are re-written with `batch.set(newRef, row)`. While `set` is idempotent, unneeded write operations occur.
3. **Payload Structure Flattening**: In the legacy `finance_entities`, entity properties were stored inside `row.payload`. The current migration does `batch.set(newRef, row)`. This stores `{ owner_id, entity_type, id, payload, version, ... }` rather than flattening `payload` or ensuring uniform document structure. The sync engine expects `row.payload` in `remote()` (`src/sync/firebase.ts:10`). This must be standardized across both migration and push/pull paths.
4. **Composite Index Prerequisite**: Querying `collection('finance_entities')` with `where('owner_id', '==', ownerId)` and `orderBy('updated_at', 'asc')` requires the composite index already registered in `firestore.indexes.json`:
   ```json
   {
     "collectionGroup": "finance_entities",
     "queryScope": "COLLECTION",
     "fields": [
       { "fieldPath": "owner_id", "order": "ASCENDING" },
       { "fieldPath": "updated_at", "order": "ASCENDING" }
     ]
   }
   ```

---

## 5. Firebase Architecture, Firestore Structure & Security Rules

### 5.1 Current Firebase Configuration

- Client config (`src/firebase.ts`):
  - Project ID: `kotoba-41ab0`
  - Auth Domain: `kotoba-41ab0.firebaseapp.com`
  - Storage Bucket: `kotoba-41ab0.firebasestorage.app`
- Cloud Functions (`functions/src/index.ts`):
  - Function: `getMarketQuote` (v2 HTTPS)
  - CORS Whitelist: `https://angelohizon-coder.github.io`, `http://localhost:5173`, `http://127.0.0.1:5173`
  - External Quote API: Yahoo Finance v8 (`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`)

### 5.2 Security Rules Audit (`firestore.rules`)

Existing rules:
```rules
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{tableName}/{id} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if request.auth != null && request.auth.uid == uid 
                   && (request.resource.data.owner_id == null || request.resource.data.owner_id == uid)
                   && request.resource.data.entity_type == tableName
                   && request.resource.data.id == id;
    }
    
    // Legacy support for migration
    match /finance_entities/{document} {
      allow read, write: if request.auth != null && request.auth.uid == resource.data.owner_id;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.owner_id;
    }
  }
}
```

### 5.3 Critical Security Rule Vulnerabilities & Required Fixes

1. **Vulnerability: Anonymous Authentication Not Rejected**:
   - **Acceptance Criteria**: `"Firestore Security Rules Emulator explicitly rejects read/write requests from mismatched UIDs or anonymous users."`
   - **Observation**: Current rule tests only `request.auth != null && request.auth.uid == uid`. In Firebase Auth, anonymous users have a valid `uid` and non-null `request.auth`. Therefore, an anonymous user CAN currently read and write under `/users/{anon_uid}/...`.
   - **Fix**: Require non-anonymous auth provider:
     ```rules
     function isAuthenticated() {
       return request.auth != null 
         && request.auth.token.firebase.sign_in_provider != 'anonymous';
     }
     ```
2. **Defect: Deletion Operation Breakdown**:
   - **Observation**: `allow write` applies to `create`, `update`, and `delete`. When deleting a document in Firestore, `request.resource.data` is `null`. The condition `request.resource.data.entity_type == tableName` throws an evaluation error during delete requests!
   - **Fix**: Split write into granular `create, update` and `delete` rules:
     ```rules
     allow delete: if isAuthenticated() && request.auth.uid == uid;
     allow create, update: if isAuthenticated() && request.auth.uid == uid
       && (request.resource.data.owner_id == null || request.resource.data.owner_id == uid)
       && request.resource.data.entity_type == tableName
       && request.resource.data.id == id;
     ```
3. **Deny-by-Default Fallback**:
   - Ensure an explicit fail-closed match at root:
     ```rules
     match /{document=**} {
       allow read, write: false;
     }
     ```
4. **Missing Emulators in `firebase.json`**:
   - Current `firebase.json` lacks an `emulators` section. It must be updated to:
     ```json
     "emulators": {
       "auth": { "port": 9099 },
       "firestore": { "port": 8080 },
       "functions": { "port": 5001 },
       "ui": { "enabled": true, "port": 4000 }
     }
     ```
5. **Missing Rules Test Suite**:
   - Need `@firebase/rules-unit-testing` in `package.json` devDependencies.
   - A dedicated Vitest test suite `tests/firestore-rules.test.ts` must execute against Firestore emulator on port 8080 to satisfy the acceptance criterion.

---

## 6. Custom Synchronization Engine Design

### 6.1 Multi-Tab Synchronization via `navigator.locks`

In `src/sync/engine.ts`:
```ts
async function perform() {
  return navigator.locks.request('tala_sync', async () => {
    if (!await enabled()) return { uploaded: 0, downloaded: 0, conflicts: 0, disabled: true };
    // ... push outbox ...
    // ... pull cursor ...
  });
}
```

**Evaluation**:
- The Web Locks API (`navigator.locks.request('tala_sync')`) acquires an exclusive execution lock.
- **Benefits**:
  - Two browser tabs open simultaneously will never push outbox entries concurrently.
  - Tab 2 waits for Tab 1 to complete its optimistic version increment and pull cycle before starting.
  - Prevents race conditions where two tabs read version `N` locally and attempt to push version `N+1` concurrently.
- **Defects & Improvements Needed**:
  - `navigator.locks` is undefined in Node test environments (Vitest) without mocking. `engine.ts` currently crashes in tests unless guarded with `(globalThis.navigator?.locks?.request ?? ((_name, cb) => cb()))`.
  - In `perform()`, if an individual outbox push fails due to network outage, line 34 throws `throw new Error('Cloud synchronization failed; local changes remain queued.')`. This aborts the remainder of the outbox loop and skips the pull phase. This fail-fast approach is safe for network outages, but retries should have exponential backoff rather than immediate periodic retry.

### 6.2 Offline Mutation Queue (`syncOutbox`)

- **Dexie Schema**: `syncOutbox: 'id, ownerId, entityId, tableName, status, createdAt, [tableName+entityId]'`
- **Lifecycle**:
  1. Local mutation written in `repository.ts`:
     `saveTransaction`, `put`, `remove` writes to Dexie table AND inserts an entry into `syncOutbox` with `status: 'pending'`, `baseVersion: currentVersion`, `attempts: 0`.
  2. Sync trigger:
     `engine.ts` queries all non-conflict entries for `ownerId`, sorted by `createdAt asc, baseVersion asc`.
  3. Push via Firestore Transaction:
     In `src/sync/firebase.ts:75`, `runTransaction(firestore, async (transaction) => { ... })`:
     - Reads remote document at `/users/{ownerId}/{tableName}/{entityId}`.
     - Checks if remote version matches `entry.baseVersion`.
     - If matching: sets remote document with `version = entry.baseVersion + 1`, returns `{ kind: 'applied' }`.
     - If replaying exact mutation (network retry after success): detects identical payload and returns `{ kind: 'applied' }`.
     - If remote version does not match: returns `{ kind: 'conflict' }`.
  4. Outbox disposition:
     - On `'applied'`: `await db.syncOutbox.delete(entry.id); uploaded++;`
     - On `'conflict'`: writes local and remote versions to `db.conflicts`, marks outbox entry status as `'conflict'`.
     - On network exception: updates outbox entry with `status: 'failed'`, increments `attempts`.

### 6.3 Cursor-Based Pagination for Firestore Pulls

Lines 110–147 of `src/sync/firebase.ts` contain the current pull logic:
```ts
async pull(cursor?: string) {
  const ownerId = await requireOwner();
  await migrateLegacyData(ownerId);
  
  const boundary = new Date().toISOString();
  const records: RemoteRecord[] = [];
  let latestCursor = cursor || '1970-01-01T00:00:00.000Z';
  let nextCursor = latestCursor;
  
  for (const tableName of FINANCE_TABLES) {
    let q = query(
      collection(firestore, 'users', ownerId, tableName),
      where('updated_at', '<=', boundary),
      orderBy('updated_at', 'asc')
    );
    if (cursor) {
      q = query(q, where('updated_at', '>=', cursor));
    }
    q = query(q, limit(1000));
    const snapshot = await getDocs(q);
    for (const docSnap of snapshot.docs) {
      const row = docSnap.data();
      records.push(remote(row, ownerId, tableName));
      if (row.updated_at > nextCursor) nextCursor = row.updated_at as string;
    }
  }
  return { records, cursor: nextCursor };
}
```

**Flaws in the Current Cursor Design**:
1. **The Shared-Cursor Cross-Table Starvation Bug**:
   - `cursor` is a single string timestamp passed sequentially across 17 independent tables (`FINANCE_TABLES`).
   - If Table 1 (`accounts`) has a record updated at `2026-10-09T12:00:00Z`, `nextCursor` advances to `12:00:00Z`.
   - When the loop finishes, `cursor` is persisted in `db.syncState` as `12:00:00Z`.
   - On the NEXT sync, Table 2 (`transactions`) is queried with `where('updated_at', '>=', '2026-10-09T12:00:00Z')`!
   - Any transactions that were updated at `2026-10-09T11:30:00Z` that were not yet pulled are permanently skipped!
   - **Architectural Solution**: The cursor MUST NOT be a single scalar timestamp across 17 collections. It must either be:
     - A serialized JSON map of cursors: `Record<FinanceTableName, string>`, e.g., `{"accounts": "2026-10-09T12:00:00Z", "transactions": "2026-10-09T11:00:00Z", ...}`.
     - Or individual table cursor rows in `db.syncState`: `cursor:${ownerId}:${tableName}`.
2. **Boundary Duplication with `>=`**:
   - Querying `where('updated_at', '>=', cursor)` means the record matching `cursor` is fetched again every single sync.
   - Must use `where('updated_at', '>', cursor)` or utilize Firestore query cursors (`startAfter(lastDocumentSnapshot)`).

### 6.4 Reconnect Merge Strategy

1. **Online Detection**:
   `window.addEventListener('online', retry)` triggers `syncNow()`.
2. **Order of Operations**:
   - **Step 1: Push Local Queue**: Any offline mutations queued in `syncOutbox` are pushed first. If no remote modifications occurred while offline, the mutations commit cleanly and outbox empties.
   - **Step 2: Pull Remote Changes**: Queries Firestore collections for changes since the last recorded cursor.
   - **Step 3: Dependency-Ranked Ingestion**:
     In `src/db/repository.ts:312`, incoming remote records are sorted:
     - Rank 0: Fundamental entity definitions (`accounts`, `categories`, `instruments`, `institutions`).
     - Rank 1: `transactions`.
     - Rank 2: Dependent records (`postings`, `investmentLots`, `budgets`, etc.).
   - **Step 4: Conflict Identification & Retention**:
     - If local version is identical to remote version: skips.
     - If remote version > local version AND no local pending changes: updates local database cleanly.
     - If both local and remote were updated (concurrent modification while offline):
       - Records a conflict in `db.conflicts` (`{ id, tableName, entityId, ownerId, local, remote, createdAt }`).
       - Retains the local version as active in the user ledger.
       - Marks `syncOutbox` as `status: 'conflict'`.
       - Exposes the conflict to the user in the "Data & sync" page (`DataPage.tsx:35`) with options to keep local or accept remote.

---

## 7. GitHub Pages Hosting Compatibility

### 7.1 Path & Routing Analysis

1. **Repository Name & Base URL**:
   - Target URL: `https://angelohizon-coder.github.io/tala/`
   - Repository path: `/tala/`
2. **Current `vite.config.ts` Configuration**:
   ```ts
   export default defineConfig({
     base: process.env.VITE_BASE || './',
     // ...
   });
   ```
   - When built with `base: './'`, relative asset paths are injected in `index.html`.
3. **The React Router `basename` Conflict**:
   - `src/main.tsx:6`:
     ```tsx
     <BrowserRouter basename={import.meta.env.BASE_URL}><App/></BrowserRouter>
     ```
   - If `base` is `'./'`, `import.meta.env.BASE_URL` evaluates to `'./'`.
   - `react-router-dom` v7 does not accept relative strings (like `'./'`) as `basename`; it expects an absolute path beginning with `/` (e.g. `'/tala/'` or `'/'`).
   - Deep links like `https://angelohizon-coder.github.io/tala/transactions` fail to match routes when `basename` is `'./'`.
4. **Existing 404 SPA Redirect Script**:
   - `public/404.html` lines 7–22 contains the single-page app redirect script:
     ```javascript
     var repo = l.pathname.split('/')[1];
     if (repo === 'tala') { pathSegmentsToKeep = 1; } else { pathSegmentsToKeep = 0; }
     l.replace(l.protocol + '//' + l.hostname + (l.port ? ':' + l.port : '') +
       l.pathname.split('/').slice(0, 1 + pathSegmentsToKeep).join('/') + '/?/' +
       l.pathname.slice(1).split('/').slice(pathSegmentsToKeep).join('/').replace(/&/g, '~and~') +
       (l.search ? '&' + l.search.slice(1).replace(/&/g, '~and~') : '') + l.hash);
     ```
   - `index.html` lines 3–8 decodes the query path and executes `window.history.replaceState`.
   - **Recommendation**:
     - Configure `VITE_BASE=/tala/` in GitHub Actions build environment, or set default `base: process.env.VITE_BASE || '/tala/'` (with `process.env.NODE_ENV === 'development' ? '/' : '/tala/'`).
     - Alternatively, use `HashRouter` if zero-server-configuration is required, but with the 404 hack present, `BrowserRouter` with `basename="/tala"` is fully supported once `VITE_BASE` is normalized.

### 7.2 Service Worker PWA & Asset Bundling

- In `vite.config.ts`:
  - `VitePWA` is configured with `navigateFallback: 'index.html'` and `navigateFallbackDenylist: [/^\/api\//, /\/legacy-market(?:\/|$)/]`.
  - Static legacy site in `site/` is bundled to `dist/legacy-market/` via `writeBundle`.
  - Cloud Functions CORS policy in `functions/src/index.ts` explicitly includes `https://angelohizon-coder.github.io`.

---

## 8. Concrete Architecture Recommendations & Phased Roadmap

### Priority 1: Unblock Compilation & Core Test Harness (Immediate)
1. **Fix syntax in `src/sync/engine.ts`**: Replace unquoted `conflict:` and `cursor:` with template literals on lines 27, 38, 41.
2. **Re-encode `src/firebase.ts` to UTF-8**: Convert file from UTF-16LE to standard UTF-8.
3. **Fix CSS Import Order in `src/styles.css`**: Move Google Fonts `@import` statement to line 1.
4. **Mock `navigator.locks` in Vitest setup**: Provide a clean fallback in `engine.ts` (`globalThis.navigator?.locks?.request ?? ((_name, cb) => cb())`) so repository tests execute reliably in Node.

### Priority 2: Harden Firestore Security Rules & Emulators
1. **Update `firestore.rules`**:
   - Enforce `request.auth.token.firebase.sign_in_provider != 'anonymous'`.
   - Separate `create, update` from `delete` so `request.resource.data` is not evaluated on document deletions.
   - Add explicit deny-by-default rule `match /{document=**} { allow read, write: false; }`.
2. **Add Emulators in `firebase.json`**:
   - Configure ports for Firestore (8080), Auth (9099), Functions (5001), UI (4000).
3. **Implement Emulator Test Suite**:
   - Add `@firebase/rules-unit-testing` to `devDependencies`.
   - Create `tests/firestore-rules.test.ts` to verify acceptance criteria: reject mismatched UIDs and reject anonymous users.

### Priority 3: Sync Engine Cursor & Migration Modernization
1. **Composite Cursors**:
   - Update `pull()` in `src/sync/firebase.ts` to store and return a per-table cursor map (`Record<FinanceTableName, string>`) encoded as JSON.
   - Use `>` rather than `>=` to prevent duplicate record pulls.
2. **Migration Robustness**:
   - Paginate legacy `finance_entities` retrieval in chunks of 500.
   - Flatten or standardize entity payloads consistently into `/users/{uid}/{tableName}/{id}`.

### Priority 4: Complete Supabase Eradication
1. Delete `supabase/` folder and `supabase/schema.sql`.
2. Run `npm prune` to purge `@supabase/*` from `package-lock.json`.
3. Rewrite `README.md` to document Firebase Cloud sync instead of Supabase.

### Priority 5: GitHub Pages Base Path Normalization
1. Update `vite.config.ts` base to handle development vs production (`/` vs `/tala/`).
2. Ensure `BrowserRouter` in `src/main.tsx` receives a clean absolute base path.

---

*Report prepared and verified by Survey Explorer 1.*
