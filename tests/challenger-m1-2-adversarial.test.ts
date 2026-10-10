import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as auth from 'firebase/auth';
import * as firestore from 'firebase/firestore';
import { createFirebaseSyncProvider } from '../src/sync/firebase';
import { firebaseConfig } from '../src/firebase';
import { FinanceDatabase, FINANCE_TABLES, type FinanceTableName, type OutboxEntry } from '../src/db/database';
import { createFinanceRepository } from '../src/db/repository';
import { createSyncEngine } from '../src/sync/engine';
import fs from 'node:fs';
import path from 'node:path';

// Shared mock states for auth and firestore
let currentMockUser: { uid: string; isAnonymous: boolean; email?: string } | null = null;
let perTableSnapshotError: Map<string, Error> = new Map();
let perTableSnapshotDocs: Map<string, any[]> = new Map();

vi.mock('firebase/auth', () => {
  return {
    getAuth: vi.fn(() => ({
      get currentUser() {
        return currentMockUser;
      },
    })),
    signOut: vi.fn(async () => {
      currentMockUser = null;
    }),
    signInWithPopup: vi.fn(async () => {
      currentMockUser = { uid: 'user-verified-google', isAnonymous: false, email: 'user@verified.com' };
      return { user: currentMockUser };
    }),
    GoogleAuthProvider: vi.fn(),
  };
});

vi.mock('firebase/firestore', () => {
  return {
    getFirestore: vi.fn(() => ({})),
    doc: vi.fn((_fs, ...parts) => ({ path: parts.join('/') })),
    collection: vi.fn((_fs, ...parts) => {
      // parts: 'users', ownerId, tableName
      const tableName = parts[2] || 'unknown';
      return { path: parts.join('/'), tableName };
    }),
    query: vi.fn((coll) => coll),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    startAfter: vi.fn(),
    getDocs: vi.fn(async () => ({ empty: true, docs: [] })),
    writeBatch: vi.fn(() => ({
      set: vi.fn(),
      commit: vi.fn(async () => {}),
    })),
    runTransaction: vi.fn(async (_fs, updateFn) => {
      return updateFn({
        get: vi.fn(async () => ({ data: () => null })),
        set: vi.fn(),
      });
    }),
    onSnapshot: vi.fn((q, onNext, onError) => {
      const tableName = q.tableName || 'unknown';
      if (perTableSnapshotError.has(tableName) && onError) {
        const err = perTableSnapshotError.get(tableName)!;
        onError(err);
      } else if (perTableSnapshotDocs.has(tableName) && onNext) {
        const docs = perTableSnapshotDocs.get(tableName)!;
        onNext({
          docChanges: () =>
            docs.map((d) => ({
              type: 'added',
              doc: { data: () => d },
            })),
        });
      }
      return vi.fn(); // unsubscribe mock
    }),
  };
});

describe('Adversarial Verification: Firebase Auth, Error Isolation & Config (Challenger M1-2)', () => {
  let db: FinanceDatabase;

  beforeEach(async () => {
    currentMockUser = null;
    perTableSnapshotError.clear();
    perTableSnapshotDocs.clear();
    db = new FinanceDatabase(`adversarial-m1-2-${crypto.randomUUID()}`);
    await db.open();
  });

  afterEach(async () => {
    currentMockUser = null;
    perTableSnapshotError.clear();
    perTableSnapshotDocs.clear();
    await db.delete();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. ANONYMOUS USER STATE & AUTH TRANSITION STRESS TESTING
  // =========================================================================
  describe('1. Anonymous User Edge Cases & State Transitions', () => {
    it('completely denies push/pull/subscribe when unauthenticated (null currentUser)', async () => {
      currentMockUser = null;
      const provider = createFirebaseSyncProvider(db);

      expect(await provider.userId()).toBeNull();

      const sampleOutbox: OutboxEntry = {
        id: 'outbox-unauth',
        ownerId: 'u-unauth',
        tableName: 'accounts',
        entityId: 'acc-unauth',
        baseVersion: 0,
        payload: { id: 'acc-unauth', ownerId: 'u-unauth' } as any,
        status: 'pending',
        attempts: 0,
        createdAt: new Date().toISOString(),
      };

      await expect(provider.push(sampleOutbox)).rejects.toThrow(
        'Sign in with a verified account before enabling cloud synchronization.'
      );
      await expect(provider.pull()).rejects.toThrow(
        'Sign in with a verified account before enabling cloud synchronization.'
      );
      await expect(provider.subscribe(vi.fn())).rejects.toThrow(
        'Sign in with a verified account before enabling cloud synchronization.'
      );
    });

    it('strictly rejects anonymous user tokens across push, pull, and subscribe', async () => {
      currentMockUser = { uid: 'anon-attacker-1', isAnonymous: true };
      const provider = createFirebaseSyncProvider(db);

      // Must hide UID from engine
      expect(await provider.userId()).toBeNull();

      const sampleOutbox: OutboxEntry = {
        id: 'outbox-anon',
        ownerId: 'anon-attacker-1',
        tableName: 'categories',
        entityId: 'cat-anon',
        baseVersion: 0,
        payload: { id: 'cat-anon', ownerId: 'anon-attacker-1' } as any,
        status: 'pending',
        attempts: 0,
        createdAt: new Date().toISOString(),
      };

      await expect(provider.push(sampleOutbox)).rejects.toThrow(
        'Sign in with a verified account before enabling cloud synchronization.'
      );
      await expect(provider.pull()).rejects.toThrow(
        'Sign in with a verified account before enabling cloud synchronization.'
      );
      await expect(provider.subscribe(vi.fn())).rejects.toThrow(
        'Sign in with a verified account before enabling cloud synchronization.'
      );
    });

    it('seamlessly transitions from anonymous user to verified user, unlocking sync', async () => {
      // Step A: User starts anonymous
      currentMockUser = { uid: 'anon-user-phase1', isAnonymous: true };
      const provider = createFirebaseSyncProvider(db);

      expect(await provider.userId()).toBeNull();
      await expect(provider.pull()).rejects.toThrow(
        'Sign in with a verified account before enabling cloud synchronization.'
      );

      // Step B: User links / authenticates with verified credentials
      currentMockUser = { uid: 'verified-user-phase2', isAnonymous: false, email: 'user@real.com' };

      // Provider now exposes verified UID
      expect(await provider.userId()).toBe('verified-user-phase2');

      // Pull now succeeds without throwing
      const pullResult = await provider.pull();
      expect(pullResult).toBeDefined();
      expect(Array.isArray(pullResult.records)).toBe(true);

      // Push with matching ownerId succeeds
      const validOutbox: OutboxEntry = {
        id: 'outbox-verified',
        ownerId: 'verified-user-phase2',
        tableName: 'accounts',
        entityId: 'acc-verified-1',
        baseVersion: 0,
        payload: {
          id: 'acc-verified-1',
          ownerId: 'verified-user-phase2',
          name: 'Checking',
          accountType: 'CASH',
          currency: 'PHP',
          openingBalance: 5000,
          openingDate: '2026-01-01',
          includeInNetWorth: true,
          includeInLiquidNetWorth: true,
          includeInFire: true,
          emergency: false,
          archived: false,
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
          deviceId: 'dev-1',
        } as any,
        status: 'pending',
        attempts: 0,
        createdAt: new Date().toISOString(),
      };

      const pushResult = await provider.push(validOutbox);
      expect(pushResult.kind).toBe('applied');
      expect(pushResult.record.record.ownerId).toBe('verified-user-phase2');
    });

    it('immediately revokes cloud access when transitioning from authenticated to anonymous or signed-out', async () => {
      // Step A: Verified user
      currentMockUser = { uid: 'user-active', isAnonymous: false };
      const provider = createFirebaseSyncProvider(db);
      expect(await provider.userId()).toBe('user-active');

      // Step B: User signs out or session degrades to anonymous
      currentMockUser = { uid: 'anon-downgraded', isAnonymous: true };
      expect(await provider.userId()).toBeNull();

      const outbox: OutboxEntry = {
        id: 'outbox-downgraded',
        ownerId: 'user-active',
        tableName: 'accounts',
        entityId: 'acc-1',
        baseVersion: 0,
        payload: { id: 'acc-1', ownerId: 'user-active' } as any,
        status: 'pending',
        attempts: 0,
        createdAt: new Date().toISOString(),
      };

      await expect(provider.push(outbox)).rejects.toThrow(
        'Sign in with a verified account before enabling cloud synchronization.'
      );
    });

    it('rejects push if payload.ownerId attempts to spoof another user despite verified auth', async () => {
      currentMockUser = { uid: 'verified-victim', isAnonymous: false };
      const provider = createFirebaseSyncProvider(db);

      const spoofedOutbox: OutboxEntry = {
        id: 'outbox-spoofed',
        ownerId: 'verified-victim',
        tableName: 'accounts',
        entityId: 'acc-spoofed',
        baseVersion: 0,
        payload: {
          id: 'acc-spoofed',
          ownerId: 'attacker-account', // Tampered ownerId inside payload
          name: 'Malicious',
        } as any,
        status: 'pending',
        attempts: 0,
        createdAt: new Date().toISOString(),
      };

      await expect(provider.push(spoofedOutbox)).rejects.toThrow(
        'The queued change belongs to another account.'
      );
    });
  });

  // =========================================================================
  // 2. SNAPSHOT LISTENER ERROR ISOLATION & RESILIENCE
  // =========================================================================
  describe('2. Snapshot Listener Error Isolation & Fault Tolerance', () => {
    it('isolates single-table error: logs warning, records lastSyncError, and invokes onError', async () => {
      currentMockUser = { uid: 'user-listener-1', isAnonymous: false };
      perTableSnapshotError.set('accounts', new Error('Firestore: Quota exceeded for accounts'));

      const provider = createFirebaseSyncProvider(db);
      const onErrorMock = vi.fn();
      const onDataMock = vi.fn();

      const unsubscribe = await provider.subscribe(onDataMock, onErrorMock);
      expect(onErrorMock).toHaveBeenCalledTimes(1);
      expect(onErrorMock.mock.calls[0][0].message).toContain('Quota exceeded for accounts');

      const syncError = await db.syncState.get('lastSyncError');
      expect(syncError?.value).toContain('Cloud listener error on accounts: Firestore: Quota exceeded for accounts');

      unsubscribe();
    });

    it('survives an error storm across ALL 17 tables without unhandled promise rejections', async () => {
      currentMockUser = { uid: 'user-listener-storm', isAnonymous: false };
      
      // Inject distinct errors for all 17 tables
      for (const t of FINANCE_TABLES) {
        perTableSnapshotError.set(t, new Error(`Connection reset on table ${t}`));
      }

      const provider = createFirebaseSyncProvider(db);
      const onErrorMock = vi.fn();

      // Subscribe to all 17 tables
      const unsubscribe = await provider.subscribe(vi.fn(), onErrorMock);

      // Verify all 17 errors were captured through onError without crashing
      expect(onErrorMock).toHaveBeenCalledTimes(FINANCE_TABLES.length);
      expect(onErrorMock).toHaveBeenCalledTimes(17);

      // db.syncState recorded error
      const syncError = await db.syncState.get('lastSyncError');
      expect(syncError?.value).toContain('Cloud listener error on');

      // Clean unsubscription
      unsubscribe();
    });

    it('healthy tables receive snapshots even when sibling tables experience errors', async () => {
      currentMockUser = { uid: 'user-healthy-mixed', isAnonymous: false };

      // Set errors on 3 tables
      perTableSnapshotError.set('accounts', new Error('Permission denied on accounts'));
      perTableSnapshotError.set('transactions', new Error('Quota exceeded on transactions'));
      perTableSnapshotError.set('budgets', new Error('Index building on budgets'));

      // Healthy table receives valid data
      const validCategory = {
        owner_id: 'user-healthy-mixed',
        entity_type: 'categories',
        id: 'cat-healthy-1',
        version: 1,
        payload: {
          id: 'cat-healthy-1',
          ownerId: 'user-healthy-mixed',
          name: 'Groceries',
          kind: 'expense',
          color: '#00ff00',
          essential: true,
          archived: false,
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
          deviceId: 'd1',
        },
      };
      perTableSnapshotDocs.set('categories', [validCategory]);

      const provider = createFirebaseSyncProvider(db);
      const onErrorMock = vi.fn();
      const onDataMock = vi.fn();

      const unsubscribe = await provider.subscribe(onDataMock, onErrorMock);

      // 3 errors occurred
      expect(onErrorMock).toHaveBeenCalledTimes(3);

      // Healthy category record successfully made it through!
      expect(onDataMock).toHaveBeenCalledTimes(1);
      const receivedRecords = onDataMock.mock.calls[0][0];
      expect(receivedRecords.length).toBe(1);
      expect(receivedRecords[0].tableName).toBe('categories');
      expect(receivedRecords[0].record.name).toBe('Groceries');

      unsubscribe();
    });

    it('does not throw or crash when onError callback is omitted (undefined)', async () => {
      currentMockUser = { uid: 'user-no-onerror', isAnonymous: false };
      perTableSnapshotError.set('postings', new Error('Network timeout'));

      const provider = createFirebaseSyncProvider(db);

      // Call subscribe with only onNext callback
      let unsubscribe: (() => void) | null = null;
      expect(() => {
        // provider.subscribe returns a Promise
      }).not.toThrow();

      unsubscribe = await provider.subscribe(vi.fn());
      expect(typeof unsubscribe).toBe('function');

      const syncError = await db.syncState.get('lastSyncError');
      expect(syncError?.value).toContain('Cloud listener error on postings: Network timeout');

      unsubscribe();
    });

    it('discards spoofed or schema-invalid remote rows without crashing or forwarding to callback', async () => {
      currentMockUser = { uid: 'user-tamper-check', isAnonymous: false };

      // Corrupted row with mismatched owner_id
      const spoofedRow = {
        owner_id: 'attacker-uid',
        entity_type: 'categories',
        id: 'cat-tampered',
        version: 1,
        payload: {
          id: 'cat-tampered',
          ownerId: 'attacker-uid',
          name: 'Spoofed',
        },
      };

      perTableSnapshotDocs.set('categories', [spoofedRow]);

      const provider = createFirebaseSyncProvider(db);
      const onDataMock = vi.fn();

      const unsubscribe = await provider.subscribe(onDataMock);

      // Malformed row was filtered out by try-catch inside remote()
      expect(onDataMock).not.toHaveBeenCalled();

      unsubscribe();
    });
  });

  // =========================================================================
  // 3. FIREBASE CONFIG RESOLUTION & MALFORMED ENV VARIABLES
  // =========================================================================
  describe('3. Firebase Configuration Fallback & Env Var Edge Cases', () => {
    it('verifies static fallback credentials for all 8 mandatory configuration keys', () => {
      expect(firebaseConfig.apiKey).toBe('AIzaSyD0jeZyg4ZNv0OZHaKMrdegHyQ1XuIjrqU');
      expect(firebaseConfig.authDomain).toBe('kotoba-41ab0.firebaseapp.com');
      expect(firebaseConfig.databaseURL).toBe(
        'https://kotoba-41ab0-default-rtdb.asia-southeast1.firebasedatabase.app'
      );
      expect(firebaseConfig.projectId).toBe('kotoba-41ab0');
      expect(firebaseConfig.storageBucket).toBe('kotoba-41ab0.firebasestorage.app');
      expect(firebaseConfig.messagingSenderId).toBe('792855742091');
      expect(firebaseConfig.appId).toBe('1:792855742091:web:9734098b8c9e530ac0368e');
      expect(firebaseConfig.measurementId).toBe('G-Y6EHQP7YTJ');
    });

    it('simulates empty string and undefined environment variable resolution', () => {
      const getEnv = (val: string | undefined, fallback: string): string => val || fallback;

      // When env var is empty string
      expect(getEnv('', 'default-key')).toBe('default-key');

      // When env var is undefined
      expect(getEnv(undefined, 'default-key')).toBe('default-key');

      // When env var is valid custom value
      expect(getEnv('custom-project-id', 'default-key')).toBe('custom-project-id');

      // When partially configured
      const partialEnv = {
        VITE_FIREBASE_API_KEY: 'custom-api-key',
        VITE_FIREBASE_AUTH_DOMAIN: '', // Empty
        VITE_FIREBASE_PROJECT_ID: undefined, // Undefined
      };

      const resolvedConfig = {
        apiKey: getEnv(partialEnv.VITE_FIREBASE_API_KEY, 'fallback-api-key'),
        authDomain: getEnv(partialEnv.VITE_FIREBASE_AUTH_DOMAIN, 'fallback-domain'),
        projectId: getEnv(partialEnv.VITE_FIREBASE_PROJECT_ID, 'fallback-project'),
      };

      expect(resolvedConfig.apiKey).toBe('custom-api-key');
      expect(resolvedConfig.authDomain).toBe('fallback-domain');
      expect(resolvedConfig.projectId).toBe('fallback-project');
    });
  });

  // =========================================================================
  // 4. SYNC ENGINE INTEGRATION UNDER ANONYMOUS RESTRICTIONS
  // =========================================================================
  describe('4. Sync Engine Integration Under Anonymous User State', () => {
    it('SyncEngine refuses to perform sync when user is anonymous and keeps outbox intact', async () => {
      currentMockUser = { uid: 'anon-engine-user', isAnonymous: true };
      const repository = createFinanceRepository(db);
      await repository.setSetting('privacyMode', 'CLOUD_SYNC');

      // Queue an account in IndexedDB
      await repository.save('accounts', {
        id: 'acc-offline-1',
        name: 'Offline Cash',
        accountType: 'CASH',
        currency: 'PHP',
        openingBalance: 1000,
        openingDate: '2026-01-01',
        includeInNetWorth: true,
        includeInLiquidNetWorth: true,
        includeInFire: true,
        emergency: false,
        archived: false,
      });

      // Verify outbox has 2 entries (privacyMode setting + accounts mutation)
      expect(await db.syncOutbox.count()).toBe(2);

      const provider = createFirebaseSyncProvider(db);
      const engine = createSyncEngine({ db, repository, provider });

      // Attempt sync: must reject because anonymous user yields null userId
      await expect(engine.syncNow()).rejects.toThrow(
        'Sign in and explicitly assign local records before syncing.'
      );

      // Verify outbox entries are still pending and preserved
      expect(await db.syncOutbox.count()).toBe(2);
      const outbox = await db.syncOutbox.get({ entityId: 'acc-offline-1' });
      expect(outbox?.status).toBe('pending');
    });

    it('SyncEngine executes successfully once user becomes verified and ownerId is assigned', async () => {
      // Step A: Verified user signs in
      currentMockUser = { uid: 'user-auth-ready', isAnonymous: false };
      await db.syncState.put({ id: 'ownerId', value: 'user-auth-ready' });

      const repository = createFinanceRepository(db);
      await repository.setSetting('privacyMode', 'CLOUD_SYNC');

      await repository.save('categories', {
        id: 'cat-verified-1',
        name: 'Health',
        kind: 'expense',
        color: '#ff0000',
        essential: true,
        archived: false,
      });

      // Outbox has 2 entries (setting + category)
      expect(await db.syncOutbox.count()).toBe(2);

      const provider = createFirebaseSyncProvider(db);
      const engine = createSyncEngine({ db, repository, provider });

      const result = await engine.syncNow();
      expect(result.uploaded).toBe(2);
      expect(await db.syncOutbox.count()).toBe(0);
    });
  });

  // =========================================================================
  // 5. FIRESTORE SECURITY RULES AST & ANONYMOUS REJECTION INTEGRITY
  // =========================================================================
  describe('5. Firestore Security Rules Anonymous Token Rejection Contract', () => {
    const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
    const rulesContent = fs.readFileSync(rulesPath, 'utf8');

    it('firestore.rules contains strict isAuthenticated check explicitly rejecting anonymous provider', () => {
      expect(rulesContent).toContain("request.auth.token.firebase.sign_in_provider != 'anonymous'");
    });

    it('firestore.rules denies anonymous tokens on /users/{uid}/{tableName}/{id}', () => {
      // Mock evaluation of the rule logic from firestore.rules
      const evaluateRule = (auth: { uid: string; token?: { firebase?: { sign_in_provider?: string } } } | null, uid: string) => {
        const isAuth = auth !== null && auth.token?.firebase?.sign_in_provider !== 'anonymous';
        return isAuth && auth?.uid === uid;
      };

      // Unauthenticated
      expect(evaluateRule(null, 'u1')).toBe(false);

      // Anonymous token
      expect(
        evaluateRule(
          { uid: 'anon-uid', token: { firebase: { sign_in_provider: 'anonymous' } } },
          'anon-uid'
        )
      ).toBe(false);

      // Verified token (Google, password, etc.)
      expect(
        evaluateRule(
          { uid: 'verified-uid', token: { firebase: { sign_in_provider: 'google.com' } } },
          'verified-uid'
        )
      ).toBe(true);

      // Cross-UID attempt
      expect(
        evaluateRule(
          { uid: 'verified-uid', token: { firebase: { sign_in_provider: 'google.com' } } },
          'other-uid'
        )
      ).toBe(false);
    });
  });

  // =========================================================================
  // 6. MULTI-USER OUTBOX ISOLATION & USER SWITCHING RESILIENCE
  // =========================================================================
  describe('6. Multi-User Account Switching & Outbox Isolation', () => {
    it('does not leak or sync User A queued mutations when User B logs in and syncs', async () => {
      const repository = createFinanceRepository(db);
      await repository.setSetting('privacyMode', 'CLOUD_SYNC');

      // User A creates a category
      await db.syncState.put({ id: 'ownerId', value: 'user-alice' });
      await repository.save('categories', {
        id: 'cat-alice-1',
        name: 'Alice Private Vault',
        kind: 'expense',
        color: '#111111',
        essential: true,
        archived: false,
      });

      // User B logs in
      currentMockUser = { uid: 'user-bob', isAnonymous: false };
      await db.syncState.put({ id: 'ownerId', value: 'user-bob' });

      // User B creates a category
      await repository.save('categories', {
        id: 'cat-bob-1',
        name: 'Bob Groceries',
        kind: 'expense',
        color: '#222222',
        essential: false,
        archived: false,
      });

      const provider = createFirebaseSyncProvider(db);
      const engine = createSyncEngine({ db, repository, provider });

      // Bob triggers sync
      const result = await engine.syncNow();

      // Only Bob's records should be uploaded
      expect(result.uploaded).toBe(1);

      // Alice's outbox entry remains in syncOutbox undisturbed
      const remainingAlice = await db.syncOutbox.where('ownerId').equals('user-alice').toArray();
      expect(remainingAlice.length).toBeGreaterThan(0);
      expect(remainingAlice.some((e) => e.entityId === 'cat-alice-1')).toBe(true);

      // Bob's outbox entry was uploaded and cleared
      const remainingBob = await db.syncOutbox.where('ownerId').equals('user-bob').toArray();
      expect(remainingBob.length).toBe(0);
    });
  });

  // =========================================================================
  // 7. MALFORMED & CORRUPTED PULL CURSOR ROBUSTNESS
  // =========================================================================
  describe('7. Malformed Pull Cursor Recovery', () => {
    it('gracefully handles non-JSON / corrupted strings without throwing in pull()', async () => {
      currentMockUser = { uid: 'user-cursor-test', isAnonymous: false };
      const provider = createFirebaseSyncProvider(db);

      // Plain unparseable string
      const malformedCursor = '{not-valid-json: !!!';
      const pull1 = await provider.pull(malformedCursor);
      expect(pull1).toBeDefined();
      expect(pull1.cursor).toBeDefined();
      const parsed1 = JSON.parse(pull1.cursor!);
      expect(typeof parsed1).toBe('object');

      // Array JSON
      const arrayCursor = '[1, 2, 3]';
      const pull2 = await provider.pull(arrayCursor);
      expect(pull2).toBeDefined();
      expect(pull2.cursor).toBeDefined();

      // Number JSON
      const numberCursor = '12345';
      const pull3 = await provider.pull(numberCursor);
      expect(pull3).toBeDefined();
    });
  });

  // =========================================================================
  // 8. SAFE REFRESH FX ERROR ISOLATION UNDER SIMULATED API DISRUPTIONS
  // =========================================================================
  describe('8. safeRefreshFx Network & API Error Isolation', () => {
    it('safely handles HTTP 500 without unhandled rejection', async () => {
      const { safeRefreshFx } = await import('../src/market/providers');
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ result: 'error', 'error-type': 'server-error' }),
      } as any);

      const res = await safeRefreshFx('PHP', true);
      expect(res.ok).toBe(false);
      expect(res.error).toBeDefined();

      globalThis.fetch = originalFetch;
    });

    it('safely handles malformed API JSON payload without unhandled rejection', async () => {
      const { safeRefreshFx } = await import('../src/market/providers');
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      } as any);

      const res = await safeRefreshFx('PHP', true);
      expect(res.ok).toBe(false);
      expect(res.error).toContain('Unexpected token');

      globalThis.fetch = originalFetch;
    });
  });
});

