import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as auth from 'firebase/auth';
import { createFirebaseSyncProvider } from '../src/sync/firebase';
import { firebaseConfig } from '../src/firebase';
import { FinanceDatabase } from '../src/db/database';
import { initializeFinanceDatabase, DEFAULT_FX_SEEDS } from '../src/db/repository';
import { safeRefreshFx } from '../src/market/providers';

// Mock firebase/auth
vi.mock('firebase/auth', () => {
  let mockUser: { uid: string; isAnonymous: boolean; email?: string } | null = null;
  return {
    getAuth: vi.fn(() => ({
      get currentUser() {
        return mockUser;
      },
    })),
    signOut: vi.fn(async () => {
      mockUser = null;
    }),
    signInWithPopup: vi.fn(async () => {
      mockUser = { uid: 'user-google-1', isAnonymous: false, email: 'test@example.com' };
      return { user: mockUser };
    }),
    GoogleAuthProvider: vi.fn(),
    __setMockUser: (user: typeof mockUser) => {
      mockUser = user;
    },
  };
});

// Mock firebase/firestore
vi.mock('firebase/firestore', () => {
  return {
    getFirestore: vi.fn(() => ({})),
    doc: vi.fn((_fs, ...parts) => ({ path: parts.join('/') })),
    collection: vi.fn((_fs, ...parts) => ({ path: parts.join('/') })),
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
    onSnapshot: vi.fn((_q, onNext, onError) => {
      if ((globalThis as any).__simulateSnapshotError && onError) {
        onError(new Error('Simulated network disconnect'));
      }
      return vi.fn(); // unsubscribe
    }),
  };
});

describe('Firebase Configuration & Security Hardening (M1 / R7)', () => {
  let db: FinanceDatabase;
  const authModule = auth as any;

  beforeEach(async () => {
    (globalThis as any).__simulateSnapshotError = false;
    db = new FinanceDatabase(`fb-test-${crypto.randomUUID()}`);
    await db.open();
  });

  afterEach(async () => {
    authModule.__setMockUser(null);
    await db.delete();
  });

  describe('R7.1: Anonymous & Unauthenticated Token Rejection', () => {
    it('throws explicit error when push is attempted without authenticated user', async () => {
      authModule.__setMockUser(null);
      const provider = createFirebaseSyncProvider(db);

      await expect(
        provider.push({
          id: 'outbox-1',
          ownerId: 'u1',
          tableName: 'accounts',
          entityId: 'acc-1',
          baseVersion: 0,
          payload: { id: 'acc-1', ownerId: 'u1' } as any,
          status: 'pending',
          attempts: 0,
          createdAt: new Date().toISOString(),
        })
      ).rejects.toThrow('Sign in with a verified account before enabling cloud synchronization.');
    });

    it('throws explicit error when push is attempted with anonymous user', async () => {
      authModule.__setMockUser({ uid: 'anon-123', isAnonymous: true });
      const provider = createFirebaseSyncProvider(db);

      await expect(
        provider.push({
          id: 'outbox-2',
          ownerId: 'anon-123',
          tableName: 'accounts',
          entityId: 'acc-2',
          baseVersion: 0,
          payload: { id: 'acc-2', ownerId: 'anon-123' } as any,
          status: 'pending',
          attempts: 0,
          createdAt: new Date().toISOString(),
        })
      ).rejects.toThrow('Sign in with a verified account before enabling cloud synchronization.');
    });

    it('returns null userId when currentUser is anonymous', async () => {
      authModule.__setMockUser({ uid: 'anon-456', isAnonymous: true });
      const provider = createFirebaseSyncProvider(db);
      expect(await provider.userId()).toBeNull();
    });

    it('returns verified uid when currentUser is non-anonymous', async () => {
      authModule.__setMockUser({ uid: 'verified-user-789', isAnonymous: false });
      const provider = createFirebaseSyncProvider(db);
      expect(await provider.userId()).toBe('verified-user-789');
    });
  });

  describe('R7.2: Environment Configuration Fallback', () => {
    it('provides valid default config values matching project credentials', () => {
      expect(firebaseConfig.apiKey).toBe('AIzaSyD0jeZyg4ZNv0OZHaKMrdegHyQ1XuIjrqU');
      expect(firebaseConfig.authDomain).toBe('kotoba-41ab0.firebaseapp.com');
      expect(firebaseConfig.projectId).toBe('kotoba-41ab0');
      expect(firebaseConfig.databaseURL).toBe('https://kotoba-41ab0-default-rtdb.asia-southeast1.firebasedatabase.app');
    });
  });

  describe('R7.3: Snapshot Listener Resilience', () => {
    it('catches listener errors, notifies onError, and records lastSyncError in db.syncState', async () => {
      authModule.__setMockUser({ uid: 'user-sub-1', isAnonymous: false });
      (globalThis as any).__simulateSnapshotError = true;

      const provider = createFirebaseSyncProvider(db);
      const onErrorMock = vi.fn();

      const unsubscribe = await provider.subscribe(vi.fn(), onErrorMock);
      expect(onErrorMock).toHaveBeenCalled();

      const syncError = await db.syncState.get('lastSyncError');
      expect(syncError?.value).toContain('Cloud listener error on');
      expect(syncError?.value).toContain('Simulated network disconnect');

      unsubscribe();
    });
  });

  describe('R1: Default FX Rate Seeding in Dexie', () => {
    it('seeds 15 baseline rates with 2020-01-01 historical floor on database initialization', async () => {
      const testDb = new FinanceDatabase(`seed-test-${crypto.randomUUID()}`);
      await initializeFinanceDatabase(testDb);

      const count = await testDb.fxRates.count();
      expect(count).toBe(DEFAULT_FX_SEEDS.length);
      expect(count).toBe(15);

      const usdPhp = await testDb.fxRates.get('fx:seed:USD:PHP');
      expect(usdPhp).toBeDefined();
      expect(usdPhp?.rate).toBe(57.0);
      expect(usdPhp?.asOf).toBe('2020-01-01T00:00:00.000Z');

      const eurUsd = await testDb.fxRates.get('fx:seed:EUR:USD');
      expect(eurUsd).toBeDefined();
      expect(eurUsd?.rate).toBe(1.087);

      // Subsequent initialization should not duplicate seeds
      await initializeFinanceDatabase(testDb);
      expect(await testDb.fxRates.count()).toBe(15);

      await testDb.delete();
    });
  });

  describe('R1: safeRefreshFx Functionality', () => {
    it('returns error result gracefully on network failure without throwing uncaught rejection', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Network offline'));

      const result = await safeRefreshFx('PHP', true);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Network offline');

      globalThis.fetch = originalFetch;
    });
  });
});
