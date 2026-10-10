import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  FinanceDatabase,
  FINANCE_TABLES,
  type FinanceTableName,
  type OutboxEntry,
  type SyncedEntity,
  type AccountEntity,
  type CategoryEntity,
  type TransactionEntity
} from '../src/db/database';
import { createFinanceRepository } from '../src/db/repository';
import { createSyncEngine } from '../src/sync/engine';
import type { SyncProvider, RemoteRecord } from '../src/sync/provider';

/**
 * Standard-compliant Web Locks simulator with FIFO queue and strict mutual exclusion.
 */
class WebLockSimulator {
  private activeLocks = new Map<string, number>();
  private maxActiveLocks = new Map<string, number>();
  private lockQueues = new Map<string, Promise<unknown>>();
  public executionLog: Array<{ name: string; tabId?: string; event: 'acquire' | 'release'; active: number; time: number }> = [];

  async request<T>(name: string, callback: () => Promise<T>, tabId?: string): Promise<T> {
    const prev = this.lockQueues.get(name) || Promise.resolve();

    let releaseLock: () => void = () => {};
    const lockWait = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    // Enqueue behind previous holders
    this.lockQueues.set(name, prev.then(() => lockWait, () => lockWait));

    await prev.catch(() => {});

    // Acquired
    const current = (this.activeLocks.get(name) || 0) + 1;
    this.activeLocks.set(name, current);
    const max = Math.max(this.maxActiveLocks.get(name) || 0, current);
    this.maxActiveLocks.set(name, max);
    this.executionLog.push({ name, tabId, event: 'acquire', active: current, time: Date.now() });

    try {
      return await callback();
    } finally {
      const remaining = (this.activeLocks.get(name) || 1) - 1;
      this.activeLocks.set(name, remaining);
      this.executionLog.push({ name, tabId, event: 'release', active: remaining, time: Date.now() });
      releaseLock();
    }
  }

  getMaxActive(name: string): number {
    return this.maxActiveLocks.get(name) || 0;
  }

  clear() {
    this.activeLocks.clear();
    this.maxActiveLocks.clear();
    this.lockQueues.clear();
    this.executionLog = [];
  }
}

describe('Adversarial Verification of Sync Engine Concurrency & Reliability', () => {
  let db: FinanceDatabase;
  let lockSim: WebLockSimulator;
  const originalNavigator = globalThis.navigator;

  beforeEach(async () => {
    db = new FinanceDatabase(`adversarial-test-${crypto.randomUUID()}`);
    await db.open();
    lockSim = new WebLockSimulator();

    // Attach lockSim to globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        ...originalNavigator,
        locks: {
          request: (name: string, cb: () => Promise<unknown>) => lockSim.request(name, cb)
        }
      },
      configurable: true,
      writable: true
    });
  });

  afterEach(async () => {
    await db.delete();
    lockSim.clear();
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true
    });
    vi.restoreAllMocks();
  });

  describe('1. Concurrent Multi-Tab Writes with navigator.locks', () => {
    it('serializes 5 concurrent tabs, strictly limiting lock concurrency to 1 and preventing duplicate uploads', async () => {
      const ownerId = 'user-multitab';
      await db.syncState.put({ id: 'ownerId', value: ownerId });
      await db.settings.put({
        id: 'finance',
        key: 'finance',
        value: { baseCurrency: 'PHP', privacyMode: 'CLOUD_SYNC' } as any
      });

      // Track all remote push calls
      const pushedEntries: { tabId: number; entryId: string; entityId: string; version: number }[] = [];
      const remoteState = new Map<string, any>();

      // Shared mock remote provider
      const createTabProvider = (tabId: number): SyncProvider => ({
        userId: async () => ownerId,
        push: async (entry: OutboxEntry) => {
          // Record push
          pushedEntries.push({
            tabId,
            entryId: entry.id,
            entityId: entry.entityId,
            version: entry.baseVersion + 1
          });
          // Artificial network latency
          await new Promise((r) => setTimeout(r, 15));
          remoteState.set(entry.entityId, { ...entry.payload, version: entry.baseVersion + 1 });
          return {
            kind: 'applied',
            record: { tableName: entry.tableName, record: { ...entry.payload, version: entry.baseVersion + 1 } }
          };
        },
        pull: async () => ({ records: [], cursor: '{}' }),
        subscribe: async () => () => {}
      });

      // Create 5 tab instances sharing the same DB but with their own engine instances
      const TAB_COUNT = 5;
      const tabs = Array.from({ length: TAB_COUNT }, (_, i) => {
        const repo = createFinanceRepository(db);
        const provider = createTabProvider(i + 1);
        const engine = createSyncEngine({ db, repository: repo, provider });
        return { tabId: i + 1, repo, provider, engine };
      });

      // Each tab saves a distinct category into the shared DB
      for (const tab of tabs) {
        await tab.repo.save('categories', {
          id: `cat-tab-${tab.tabId}`,
          name: `Category Tab ${tab.tabId}`,
          kind: 'expense',
          color: `#00000${tab.tabId}`,
          essential: false,
          archived: false
        });
      }

      // Verify outbox currently has 5 entries before sync
      expect(await db.syncOutbox.count()).toBe(5);

      // Concurrently trigger syncNow across all 5 tabs
      const results = await Promise.all(tabs.map((t) => t.engine.syncNow()));

      // 1. Verify that navigator.locks never had more than 1 concurrent holder
      expect(lockSim.getMaxActive('tala_sync')).toBe(1);

      // 2. Verify all 5 entries were uploaded without ANY duplicate push attempts
      expect(pushedEntries.length).toBe(5);
      const pushedEntityIds = pushedEntries.map((p) => p.entityId);
      expect(new Set(pushedEntityIds).size).toBe(5);
      expect(pushedEntityIds.sort()).toEqual([
        'cat-tab-1',
        'cat-tab-2',
        'cat-tab-3',
        'cat-tab-4',
        'cat-tab-5'
      ]);

      // 3. Verify outbox is completely drained
      expect(await db.syncOutbox.count()).toBe(0);

      // 4. Total uploaded across all tabs should sum to 5 (the first tab gets all 5, subsequent tabs get 0)
      const totalUploaded = results.reduce((sum, r) => sum + r.uploaded, 0);
      expect(totalUploaded).toBe(5);
    });

    it('demonstrates failure mode: bypassing navigator.locks causes concurrent duplicate pushes', async () => {
      // Temporarily remove locks to prove the adversarial failure mode without locks
      Object.defineProperty(globalThis, 'navigator', {
        value: {
          ...originalNavigator,
          locks: undefined
        },
        configurable: true,
        writable: true
      });

      const ownerId = 'user-nolock';
      await db.syncState.put({ id: 'ownerId', value: ownerId });
      await db.settings.put({
        id: 'finance',
        key: 'finance',
        value: { baseCurrency: 'PHP', privacyMode: 'CLOUD_SYNC' } as any
      });

      const pushLog: string[] = [];
      const createNoLockProvider = (tabId: number): SyncProvider => ({
        userId: async () => ownerId,
        push: async (entry: OutboxEntry) => {
          pushLog.push(`tab-${tabId}:${entry.entityId}`);
          await new Promise((r) => setTimeout(r, 20));
          return {
            kind: 'applied',
            record: { tableName: entry.tableName, record: { ...entry.payload, version: entry.baseVersion + 1 } }
          };
        },
        pull: async () => ({ records: [], cursor: '{}' }),
        subscribe: async () => () => {}
      });

      const tab1Repo = createFinanceRepository(db);
      const tab2Repo = createFinanceRepository(db);
      const engine1 = createSyncEngine({ db, repository: tab1Repo, provider: createNoLockProvider(1) });
      const engine2 = createSyncEngine({ db, repository: tab2Repo, provider: createNoLockProvider(2) });

      // Add a single category to the shared DB
      await tab1Repo.save('categories', {
        id: 'cat-race',
        name: 'Race Cat',
        kind: 'expense',
        color: '#ff0000',
        essential: false,
        archived: false
      });

      // Run both engines simultaneously without locks
      await Promise.all([engine1.syncNow(), engine2.syncNow()]);

      // Without locks, BOTH tab1 and tab2 read the outbox before either deletes it, resulting in duplicate push!
      expect(pushLog.length).toBe(2);
      expect(pushLog).toContain('tab-1:cat-race');
      expect(pushLog).toContain('tab-2:cat-race');
    });

    it('safely queues mutations arriving while another tab is actively syncing', async () => {
      const ownerId = 'user-interleaved';
      await db.syncState.put({ id: 'ownerId', value: ownerId });
      await db.settings.put({
        id: 'finance',
        key: 'finance',
        value: { baseCurrency: 'PHP', privacyMode: 'CLOUD_SYNC' } as any
      });

      const uploaded: string[] = [];
      let tab1MidPushResolve: () => void = () => {};
      const tab1MidPushPromise = new Promise<void>((r) => { tab1MidPushResolve = r; });

      const provider: SyncProvider = {
        userId: async () => ownerId,
        push: async (entry) => {
          uploaded.push(entry.entityId);
          if (entry.entityId === 'item-tab-1') {
            // Signal that tab 1 is mid-push and pause
            tab1MidPushResolve();
            await new Promise((r) => setTimeout(r, 30));
          }
          return {
            kind: 'applied',
            record: { tableName: entry.tableName, record: { ...entry.payload, version: 1 } }
          };
        },
        pull: async () => ({ records: [], cursor: '{}' }),
        subscribe: async () => () => {}
      };

      const repo1 = createFinanceRepository(db);
      const repo2 = createFinanceRepository(db);
      const engine1 = createSyncEngine({ db, repository: repo1, provider });
      const engine2 = createSyncEngine({ db, repository: repo2, provider });

      // Tab 1 queues item 1
      await repo1.save('categories', {
        id: 'item-tab-1',
        name: 'Item 1',
        kind: 'expense',
        color: '#111',
        essential: false,
        archived: false
      });

      // Start Tab 1 sync
      const sync1Promise = engine1.syncNow();

      // Wait until Tab 1 has acquired lock and is mid-push
      await tab1MidPushPromise;

      // While Tab 1 is mid-push, Tab 2 saves item 2 and calls syncNow()
      await repo2.save('categories', {
        id: 'item-tab-2',
        name: 'Item 2',
        kind: 'expense',
        color: '#222',
        essential: false,
        archived: false
      });
      const sync2Promise = engine2.syncNow();

      // Both complete
      const [res1, res2] = await Promise.all([sync1Promise, sync2Promise]);

      expect(res1.uploaded).toBe(1);
      expect(res2.uploaded).toBe(1);
      expect(uploaded).toEqual(['item-tab-1', 'item-tab-2']);
      expect(await db.syncOutbox.count()).toBe(0);
    });
  });

  describe('2. Offline Mutation Queueing in Dexie & Reconnect Merge', () => {
    it('queues a multi-table financial graph offline, retains status on failed sync, and merges cleanly on reconnect', async () => {
      const ownerId = 'user-offline-full';
      await db.syncState.put({ id: 'ownerId', value: ownerId });
      await db.settings.put({
        id: 'finance',
        key: 'finance',
        value: { baseCurrency: 'PHP', privacyMode: 'CLOUD_SYNC' } as any
      });

      let isOnline = false;
      const remotePushed: OutboxEntry[] = [];
      const remoteRecords: RemoteRecord[] = [];

      const provider: SyncProvider = {
        userId: async () => ownerId,
        push: async (entry) => {
          if (!isOnline) {
            throw new Error('Network offline (503 Service Unavailable)');
          }
          remotePushed.push(entry);
          return {
            kind: 'applied',
            record: {
              tableName: entry.tableName,
              record: { ...entry.payload, version: entry.baseVersion + 1 }
            }
          };
        },
        pull: async () => {
          if (!isOnline) {
            throw new Error('Network offline (503 Service Unavailable)');
          }
          return { records: remoteRecords, cursor: JSON.stringify({ accounts: '1', categories: '1' }) };
        },
        subscribe: async () => () => {}
      };

      const repository = createFinanceRepository(db);
      const engine = createSyncEngine({ db, repository, provider });

      // --- PHASE 1: Offline mutations across multiple financial tables ---
      isOnline = false;

      // 1. Account
      const account: AccountEntity = {
        id: 'acc-offline-1',
        name: 'Offline Checking',
        accountType: 'CHECKING',
        currency: 'PHP',
        openingDate: '2026-01-01',
        openingBalance: 1000000,
        includeInNetWorth: true,
        includeInLiquidNetWorth: true,
        includeInFire: true,
        emergency: false,
        archived: false
      };
      await repository.save('accounts', account);

      // 2. Category
      const category: CategoryEntity = {
        id: 'cat-offline-1',
        name: 'Supplies',
        kind: 'expense',
        color: '#555555',
        essential: true,
        archived: false
      };
      await repository.save('categories', category);

      // 3. Transaction (which generates postings)
      const transaction: TransactionEntity = {
        id: 'tx-offline-1',
        accountId: 'acc-offline-1',
        date: '2026-10-09',
        currency: 'PHP',
        amount: 50000,
        type: 'EXPENSE',
        categoryId: 'cat-offline-1',
        notes: 'Office supplies'
      };
      await repository.saveTransaction(transaction);

      // Verify offline mutations are present in Dexie outbox
      const outboxBefore = await db.syncOutbox.toArray();
      // Expect account, category, transaction, and generated postings
      expect(outboxBefore.length).toBeGreaterThanOrEqual(3);

      // Verify local calculations work seamlessly while offline
      const balances = await repository.accountBalances();
      expect(balances['acc-offline-1']['PHP']).toBe(1000000 - 50000);

      // Attempt sync while offline -> must throw and NOT drop outbox records
      await expect(engine.syncNow()).rejects.toThrow(/Cloud synchronization failed/);

      // Outbox records are still retained, marked as 'failed'
      const outboxAfterFail = await db.syncOutbox.toArray();
      expect(outboxAfterFail.length).toBe(outboxBefore.length);
      expect(outboxAfterFail.some((e) => e.status === 'failed')).toBe(true);

      // --- PHASE 2: Remote mutations occur while client was offline ---
      const remoteAccount: RemoteRecord = {
        tableName: 'accounts',
        record: {
          id: 'acc-remote-2',
          name: 'Remote Savings',
          accountType: 'SAVINGS',
          currency: 'PHP',
          openingDate: '2026-01-01',
          openingBalance: 500000,
          includeInNetWorth: true,
          includeInLiquidNetWorth: true,
          includeInFire: true,
          emergency: true,
          archived: false,
          ownerId,
          version: 1,
          createdAt: '2026-10-09T05:00:00Z',
          updatedAt: '2026-10-09T05:00:00Z',
          deletedAt: null,
          deviceId: 'remote-phone'
        }
      };
      remoteRecords.push(remoteAccount);

      // --- PHASE 3: Reconnect and synchronize ---
      isOnline = true;
      const syncResult = await engine.syncNow();

      // Verify all offline outbox mutations were pushed
      expect(syncResult.uploaded).toBe(outboxBefore.length);
      expect(await db.syncOutbox.count()).toBe(0);

      // Verify remote record was pulled and integrated locally
      expect(syncResult.downloaded).toBe(1);
      const localRemoteAcc = await db.accounts.get('acc-remote-2');
      expect(localRemoteAcc).toBeDefined();
      expect(localRemoteAcc?.name).toBe('Remote Savings');

      // Verify local calculations include BOTH local and remote accounts
      const mergedBalances = await repository.accountBalances();
      expect(mergedBalances['acc-offline-1']['PHP']).toBe(950000);
      expect(mergedBalances['acc-remote-2']['PHP']).toBe(500000);
    });
  });

  describe('3. Stress Testing Composite Per-Table Cursors', () => {
    it('prevents starvation: high-frequency updates on transactions do not skip or starve updates on other tables', async () => {
      const ownerId = 'user-cursor-stress';
      await db.syncState.put({ id: 'ownerId', value: ownerId });
      await db.settings.put({
        id: 'finance',
        key: 'finance',
        value: { baseCurrency: 'PHP', privacyMode: 'CLOUD_SYNC' } as any
      });

      // Prepare simulated dataset across multiple tables:
      // - transactions: 50 updates at timestamps t = 1..50
      // - categories: updates at t = 5, t = 25
      // - accounts: updates at t = 12, t = 40
      // - fxRates: update at t = 2
      // - budgets: update at t = 30

      interface RemoteMockItem {
        tableName: FinanceTableName;
        id: string;
        updatedAt: string;
        payload: SyncedEntity;
      }

      const allRemoteItems: RemoteMockItem[] = [];

      // Generate 50 transaction updates
      for (let t = 1; t <= 50; t++) {
        const sec = String(t).padStart(2, '0');
        const ts = `2026-10-09T12:00:${sec}.000Z`;
        allRemoteItems.push({
          tableName: 'transactions',
          id: `tx-hf-${t}`,
          updatedAt: ts,
          payload: {
            id: `tx-hf-${t}`,
            accountId: 'acc-base',
            date: '2026-10-09',
            currency: 'PHP',
            amount: t * 100,
            type: 'EXPENSE',
            ownerId,
            version: 1,
            createdAt: ts,
            updatedAt: ts,
            deletedAt: null,
            deviceId: 'dev-hf'
          } as any
        });
      }

      // Generate low-frequency updates
      const addLowFreq = (tableName: FinanceTableName, id: string, sec: number, extra: any) => {
        const s = String(sec).padStart(2, '0');
        const ts = `2026-10-09T12:00:${s}.000Z`;
        allRemoteItems.push({
          tableName,
          id,
          updatedAt: ts,
          payload: {
            id,
            ownerId,
            version: 1,
            createdAt: ts,
            updatedAt: ts,
            deletedAt: null,
            deviceId: 'dev-lf',
            ...extra
          }
        });
      };

      addLowFreq('categories', 'cat-lf-1', 5, { name: 'Cat 1', kind: 'expense', color: '#111', essential: true, archived: false });
      addLowFreq('categories', 'cat-lf-2', 25, { name: 'Cat 2', kind: 'expense', color: '#222', essential: false, archived: false });
      addLowFreq('accounts', 'acc-lf-1', 12, { name: 'Acc 1', accountType: 'CHECKING', currency: 'PHP', openingDate: '2026-01-01', openingBalance: 1000, includeInNetWorth: true, includeInLiquidNetWorth: true, includeInFire: true, emergency: false, archived: false });
      addLowFreq('accounts', 'acc-lf-2', 40, { name: 'Acc 2', accountType: 'SAVINGS', currency: 'PHP', openingDate: '2026-01-01', openingBalance: 2000, includeInNetWorth: true, includeInLiquidNetWorth: true, includeInFire: true, emergency: false, archived: false });
      addLowFreq('fxRates', 'fx-lf-1', 2, { fromCurrency: 'USD', toCurrency: 'PHP', rate: 56.5, asOf: '2026-10-09T12:00:02.000Z', source: 'test' });
      addLowFreq('budgets', 'b-lf-1', 30, { categoryId: 'cat-lf-1', amount: 50000, currency: 'PHP', periodType: 'monthly', period: '2026-10' });

      // Seed account so transactions can validate
      await db.accounts.put({
        id: 'acc-base',
        name: 'Base Acc',
        accountType: 'CHECKING',
        currency: 'PHP',
        openingDate: '2026-01-01',
        openingBalance: 1000000,
        includeInNetWorth: true,
        includeInLiquidNetWorth: true,
        includeInFire: true,
        emergency: false,
        archived: false,
        ownerId,
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        deletedAt: null,
        deviceId: 'd1'
      });

      // Composite cursor pull simulation matching src/sync/firebase.ts algorithm
      let currentBoundarySec = 10; // start simulation at t = 10 sec

      const provider: SyncProvider = {
        userId: async () => ownerId,
        push: async () => ({ kind: 'applied', record: {} as any }),
        pull: async (cursor?: string) => {
          let tableCursors: Record<string, string> = {};
          if (cursor) {
            try {
              tableCursors = JSON.parse(cursor);
            } catch {
              for (const t of FINANCE_TABLES) tableCursors[t] = cursor;
            }
          }

          const boundary = `2026-10-09T12:00:${String(currentBoundarySec).padStart(2, '0')}.000Z`;
          const records: RemoteRecord[] = [];

          for (const tableName of FINANCE_TABLES) {
            const tableCursor = tableCursors[tableName];
            const matching = allRemoteItems
              .filter((item) => item.tableName === tableName)
              .filter((item) => item.updatedAt <= boundary)
              .filter((item) => (tableCursor ? item.updatedAt > tableCursor : true))
              .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

            let maxTableUpdated = tableCursor || '1970-01-01T00:00:00.000Z';
            for (const item of matching) {
              records.push({ tableName, record: item.payload });
              if (item.updatedAt > maxTableUpdated) {
                maxTableUpdated = item.updatedAt;
              }
            }
            tableCursors[tableName] = maxTableUpdated;
          }

          return { records, cursor: JSON.stringify(tableCursors) };
        },
        subscribe: async () => () => {}
      };

      const repository = createFinanceRepository(db);
      const engine = createSyncEngine({ db, repository, provider });

      // Run multiple sequential sync pulls as time advances
      // Pull 1: t = 10
      currentBoundarySec = 10;
      const pull1 = await engine.syncNow();
      expect(pull1.downloaded).toBeGreaterThan(0);
      expect(await db.fxRates.get('fx-lf-1')).toBeDefined(); // fx rate at t=2 arrived!
      expect(await db.categories.get('cat-lf-1')).toBeDefined(); // cat 1 at t=5 arrived!

      // Pull 2: t = 20
      currentBoundarySec = 20;
      await engine.syncNow();
      expect(await db.accounts.get('acc-lf-1')).toBeDefined(); // acc 1 at t=12 arrived!

      // Pull 3: t = 35
      currentBoundarySec = 35;
      await engine.syncNow();
      expect(await db.categories.get('cat-lf-2')).toBeDefined(); // cat 2 at t=25 arrived!
      expect(await db.budgets.get('b-lf-1')).toBeDefined(); // budget at t=30 arrived!

      // Pull 4: t = 50 (all records)
      currentBoundarySec = 50;
      await engine.syncNow();
      expect(await db.accounts.get('acc-lf-2')).toBeDefined(); // acc 2 at t=40 arrived!

      // Verify final counts
      // High-frequency transactions: all 50 must be present
      const txCount = await db.transactions.count();
      expect(txCount).toBe(50);

      // Low-frequency items must all be present (none starved or skipped)
      expect(await db.categories.count()).toBe(2);
      expect(await db.accounts.count()).toBe(3); // base + 2 lf
      expect(await db.fxRates.count()).toBe(1);
      expect(await db.budgets.count()).toBe(1);

      // Verify the persisted composite cursor in db.syncState
      const finalCursor = (await db.syncState.get(`cursor:${ownerId}`))?.value;
      expect(typeof finalCursor).toBe('string');
      const parsedCursor = JSON.parse(finalCursor as string);
      expect(parsedCursor.transactions).toBe('2026-10-09T12:00:50.000Z');
      expect(parsedCursor.categories).toBe('2026-10-09T12:00:25.000Z');
      expect(parsedCursor.accounts).toBe('2026-10-09T12:00:40.000Z');
      expect(parsedCursor.fxRates).toBe('2026-10-09T12:00:02.000Z');
      expect(parsedCursor.budgets).toBe('2026-10-09T12:00:30.000Z');
    });

    it('recovers gracefully from corrupt non-JSON cursor string without crashing', async () => {
      const ownerId = 'user-corrupt-cursor';
      await db.syncState.put({ id: 'ownerId', value: ownerId });
      await db.settings.put({
        id: 'finance',
        key: 'finance',
        value: { baseCurrency: 'PHP', privacyMode: 'CLOUD_SYNC' } as any
      });
      // Store corrupt non-JSON cursor
      await db.syncState.put({ id: `cursor:${ownerId}`, value: 'MALFORMED{NOT_JSON' });

      let receivedCursor: string | undefined;
      const provider: SyncProvider = {
        userId: async () => ownerId,
        push: async () => ({ kind: 'applied', record: {} as any }),
        pull: async (cursor) => {
          receivedCursor = cursor;
          return { records: [], cursor: '{}' };
        },
        subscribe: async () => () => {}
      };

      const repository = createFinanceRepository(db);
      const engine = createSyncEngine({ db, repository, provider });

      // Must not crash
      await expect(engine.syncNow()).resolves.toBeDefined();
      expect(receivedCursor).toBe('MALFORMED{NOT_JSON');
    });
  });

  describe('4. Local-Only Mode Privacy Boundary', () => {
    it('produces zero sync activity when privacyMode is LOCAL_ONLY', async () => {
      const ownerId = 'user-local-only';
      await db.syncState.put({ id: 'ownerId', value: ownerId });
      await db.settings.put({
        id: 'finance',
        key: 'finance',
        value: { baseCurrency: 'PHP', privacyMode: 'LOCAL_ONLY' } as any
      });

      const pushFn = vi.fn();
      const pullFn = vi.fn();
      const provider: SyncProvider = {
        userId: async () => ownerId,
        push: pushFn,
        pull: pullFn,
        subscribe: async () => () => {}
      };

      const repository = createFinanceRepository(db);
      const engine = createSyncEngine({ db, repository, provider });

      // Save an account locally
      await repository.save('accounts', {
        id: 'acc-privacy-1',
        name: 'Private Checking',
        accountType: 'CHECKING',
        currency: 'PHP',
        openingDate: '2026-01-01',
        openingBalance: 1000,
        includeInNetWorth: true,
        includeInLiquidNetWorth: true,
        includeInFire: true,
        emergency: false,
        archived: false
      });

      const result = await engine.syncNow();

      expect(result.disabled).toBe(true);
      expect(result.uploaded).toBe(0);
      expect(result.downloaded).toBe(0);
      expect(pushFn).not.toHaveBeenCalled();
      expect(pullFn).not.toHaveBeenCalled();
    });
  });
});
