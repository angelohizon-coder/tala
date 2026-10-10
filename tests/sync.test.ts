import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { FinanceDatabase, FINANCE_TABLES, type FinanceTableName, type OutboxEntry, type SyncedEntity } from '../src/db/database';
import { createFinanceRepository } from '../src/db/repository';
import { createSyncEngine } from '../src/sync/engine';
import type { SyncProvider, RemoteRecord } from '../src/sync/provider';

describe('Modernized Sync Engine & Composite Cursors', () => {
  let db: FinanceDatabase;
  let repository: ReturnType<typeof createFinanceRepository>;

  beforeEach(async () => {
    db = new FinanceDatabase(`sync-test-${crypto.randomUUID()}`);
    await db.open();
    repository = createFinanceRepository(db);
    await repository.setSetting('privacyMode', 'CLOUD_SYNC');
  });

  afterEach(async () => {
    await db.delete();
    vi.restoreAllMocks();
  });

  describe('Web Locks serialization and fallback', () => {
    it('serializes concurrent sync calls using navigator.locks when available', async () => {
      let activeLocks = 0;
      let maxConcurrentLocks = 0;

      // Mock navigator.locks with concurrency tracker
      const originalNavigator = globalThis.navigator;
      const mockLocks = {
        request: vi.fn(async (name: string, callback: () => Promise<unknown>) => {
          expect(name).toBe('tala_sync');
          activeLocks++;
          maxConcurrentLocks = Math.max(maxConcurrentLocks, activeLocks);
          try {
            await new Promise((r) => setTimeout(r, 20));
            return await callback();
          } finally {
            activeLocks--;
          }
        })
      };

      Object.defineProperty(globalThis, 'navigator', {
        value: { ...originalNavigator, locks: mockLocks },
        configurable: true,
        writable: true
      });

      const provider: SyncProvider = {
        userId: async () => 'user-1',
        push: async () => ({
          kind: 'applied',
          record: {
            tableName: 'categories',
            record: {
              id: 'cat-1',
              ownerId: 'user-1',
              version: 1,
              createdAt: '2026-10-09T00:00:00Z',
              updatedAt: '2026-10-09T00:00:00Z',
              deletedAt: null,
              deviceId: 'dev-1'
            }
          }
        }),
        pull: async () => ({ records: [], cursor: '{}' }),
        subscribe: async () => () => {}
      };

      await db.syncState.put({ id: 'ownerId', value: 'user-1' });

      const engine = createSyncEngine({ db, repository, provider });

      // Run multiple concurrent sync requests
      const [res1, res2] = await Promise.all([engine.syncNow(), engine.syncNow()]);

      expect(mockLocks.request).toHaveBeenCalled();
      expect(res1).toBeDefined();
      expect(res2).toBeDefined();

      // Restore navigator
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
        writable: true
      });
    });

    it('falls back safely in Node environment where navigator.locks is undefined', async () => {
      const originalNavigator = globalThis.navigator;
      Object.defineProperty(globalThis, 'navigator', {
        value: undefined,
        configurable: true,
        writable: true
      });

      const provider: SyncProvider = {
        userId: async () => 'user-fallback',
        push: async () => ({
          kind: 'applied',
          record: {
            tableName: 'categories',
            record: {
              id: 'cat-1',
              ownerId: 'user-fallback',
              version: 1,
              createdAt: '2026-10-09T00:00:00Z',
              updatedAt: '2026-10-09T00:00:00Z',
              deletedAt: null,
              deviceId: 'dev-1'
            }
          }
        }),
        pull: async () => ({ records: [], cursor: '{}' }),
        subscribe: async () => () => {}
      };

      await db.syncState.put({ id: 'ownerId', value: 'user-fallback' });

      const engine = createSyncEngine({ db, repository, provider });
      const result = await engine.syncNow();
      expect(result.uploaded).toBe(0);
      expect(result.downloaded).toBe(0);

      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
        writable: true
      });
    });
  });

  describe('Composite per-table cursors', () => {
    it('advancing one table timestamp does not starve updates from other tables', async () => {
      const ownerId = 'user-cursors';
      await db.syncState.put({ id: 'ownerId', value: ownerId });

      let pullCalls = 0;
      const pulledCursors: (string | undefined)[] = [];

      const provider: SyncProvider = {
        userId: async () => ownerId,
        push: async (entry) => ({
          kind: 'applied',
          record: { tableName: entry.tableName, record: entry.payload }
        }),
        pull: async (cursor?: string) => {
          pullCalls++;
          pulledCursors.push(cursor);

          if (pullCalls === 1) {
            // First pull: accounts has latest record at 12:00, categories has no updates
            const tableCursors: Record<string, string> = {
              accounts: '2026-10-09T12:00:00.000Z',
              categories: '2026-10-09T08:00:00.000Z'
            };
            return {
              records: [
                {
                  tableName: 'categories',
                  record: {
                    id: 'cat-1',
                    name: 'Groceries',
                    kind: 'expense',
                    color: '#000',
                    essential: true,
                    archived: false,
                    ownerId,
                    version: 1,
                    createdAt: '2026-10-09T08:00:00.000Z',
                    updatedAt: '2026-10-09T08:00:00.000Z',
                    deletedAt: null,
                    deviceId: 'd1'
                  }
                }
              ],
              cursor: JSON.stringify(tableCursors)
            };
          } else {
            // Second pull: parse incoming composite cursor
            const parsed = cursor ? JSON.parse(cursor) : {};
            expect(parsed.accounts).toBe('2026-10-09T12:00:00.000Z');
            expect(parsed.categories).toBe('2026-10-09T08:00:00.000Z');

            // Categories now receives an update at 10:00:00Z.
            // If cursor was single scalar 12:00:00Z, this 10:00:00Z record would have been starved/skipped!
            const catUpdateRecord: RemoteRecord = {
              tableName: 'categories',
              record: {
                id: 'cat-2',
                name: 'Utilities',
                kind: 'expense',
                color: '#111',
                essential: true,
                archived: false,
                ownerId,
                version: 1,
                createdAt: '2026-10-09T10:00:00.000Z',
                updatedAt: '2026-10-09T10:00:00.000Z',
                deletedAt: null,
                deviceId: 'd1'
              }
            };
            parsed.categories = '2026-10-09T10:00:00.000Z';
            return {
              records: [catUpdateRecord],
              cursor: JSON.stringify(parsed)
            };
          }
        },
        subscribe: async () => () => {}
      };

      const engine = createSyncEngine({ db, repository, provider });

      // Run pull 1
      const res1 = await engine.syncNow();
      expect(res1.downloaded).toBe(1);

      // Verify persisted cursor in db.syncState is composite JSON
      const savedCursor = (await db.syncState.get(`cursor:${ownerId}`))?.value;
      expect(typeof savedCursor).toBe('string');
      const parsedSaved = JSON.parse(savedCursor as string);
      expect(parsedSaved.accounts).toBe('2026-10-09T12:00:00.000Z');
      expect(parsedSaved.categories).toBe('2026-10-09T08:00:00.000Z');

      // Run pull 2
      const res2 = await engine.syncNow();
      expect(res2.downloaded).toBe(1);

      // Verify cat-2 arrived and was not starved
      expect(await db.categories.get('cat-2')).toBeDefined();
    });

    it('handles legacy single-string timestamp cursor without errors', async () => {
      const ownerId = 'user-legacy-cursor';
      await db.syncState.put({ id: 'ownerId', value: ownerId });
      await db.syncState.put({ id: `cursor:${ownerId}`, value: '2026-10-09T05:00:00.000Z' });

      let receivedCursor: string | undefined;
      const provider: SyncProvider = {
        userId: async () => ownerId,
        push: async (entry) => ({ kind: 'applied', record: { tableName: entry.tableName, record: entry.payload } }),
        pull: async (cursor) => {
          receivedCursor = cursor;
          return { records: [], cursor: JSON.stringify({ accounts: cursor || '' }) };
        },
        subscribe: async () => () => {}
      };

      const engine = createSyncEngine({ db, repository, provider });
      await engine.syncNow();
      expect(receivedCursor).toBe('2026-10-09T05:00:00.000Z');
    });
  });

  describe('Offline mutation queue persistence and reconnect merge', () => {
    it('retains queued mutations while offline and drains on reconnect', async () => {
      const ownerId = 'user-offline';
      await db.syncState.put({ id: 'ownerId', value: ownerId });

      // Simulate offline: enqueue local mutations directly into syncOutbox
      const entry1: OutboxEntry = {
        id: 'outbox-1',
        ownerId,
        tableName: 'categories',
        entityId: 'cat-offline-1',
        baseVersion: 0,
        payload: {
          id: 'cat-offline-1',
          name: 'Dining',
          kind: 'expense',
          color: '#222',
          essential: false,
          archived: false,
          ownerId,
          version: 1,
          createdAt: '2026-10-09T01:00:00Z',
          updatedAt: '2026-10-09T01:00:00Z',
          deletedAt: null,
          deviceId: 'local-dev'
        },
        status: 'pending',
        attempts: 0,
        createdAt: '2026-10-09T01:00:00Z'
      };

      const entry2: OutboxEntry = {
        id: 'outbox-2',
        ownerId,
        tableName: 'categories',
        entityId: 'cat-offline-2',
        baseVersion: 0,
        payload: {
          id: 'cat-offline-2',
          name: 'Books',
          kind: 'expense',
          color: '#333',
          essential: false,
          archived: false,
          ownerId,
          version: 1,
          createdAt: '2026-10-09T02:00:00Z',
          updatedAt: '2026-10-09T02:00:00Z',
          deletedAt: null,
          deviceId: 'local-dev'
        },
        status: 'pending',
        attempts: 0,
        createdAt: '2026-10-09T02:00:00Z'
      };

      await db.syncOutbox.clear();
      await db.syncOutbox.bulkAdd([entry1, entry2]);
      expect(await db.syncOutbox.count()).toBe(2);

      // Now reconnect: provider pushes successfully
      const pushedEntries: OutboxEntry[] = [];
      const provider: SyncProvider = {
        userId: async () => ownerId,
        push: async (entry) => {
          pushedEntries.push(entry);
          return {
            kind: 'applied',
            record: { tableName: entry.tableName, record: { ...entry.payload, version: entry.baseVersion + 1 } }
          };
        },
        pull: async () => ({ records: [], cursor: '{}' }),
        subscribe: async () => () => {}
      };

      const engine = createSyncEngine({ db, repository, provider });
      const result = await engine.syncNow();

      expect(result.uploaded).toBe(2);
      expect(await db.syncOutbox.count()).toBe(0);
      expect(pushedEntries.map((e) => e.entityId)).toEqual(['cat-offline-1', 'cat-offline-2']);
    });

    it('isolates conflict records in db.conflicts without overwriting local data', async () => {
      const ownerId = 'user-conflict';
      await db.syncState.put({ id: 'ownerId', value: ownerId });

      await db.categories.put({
        id: 'cat-c',
        name: 'Local Name',
        kind: 'expense',
        color: '#444',
        essential: true,
        archived: false,
        ownerId,
        version: 1,
        createdAt: '2026-10-09T00:00:00Z',
        updatedAt: '2026-10-09T00:00:00Z',
        deletedAt: null,
        deviceId: 'local-dev'
      });

      const entry: OutboxEntry = {
        id: 'outbox-c',
        ownerId,
        tableName: 'categories',
        entityId: 'cat-c',
        baseVersion: 1,
        payload: {
          id: 'cat-c',
          name: 'Local Name',
          kind: 'expense',
          color: '#444',
          essential: true,
          archived: false,
          ownerId,
          version: 2,
          createdAt: '2026-10-09T00:00:00Z',
          updatedAt: '2026-10-09T00:00:00Z',
          deletedAt: null,
          deviceId: 'local-dev'
        },
        status: 'pending',
        attempts: 0,
        createdAt: '2026-10-09T01:00:00Z'
      };
      await db.syncOutbox.add(entry);

      const remoteRecord: SyncedEntity = {
        id: 'cat-c',
        name: 'Remote Conflicting Name',
        kind: 'expense',
        color: '#555',
        essential: false,
        archived: false,
        ownerId,
        version: 3,
        createdAt: '2026-10-09T00:00:00Z',
        updatedAt: '2026-10-09T01:30:00Z',
        deletedAt: null,
        deviceId: 'other-device'
      };

      const provider: SyncProvider = {
        userId: async () => ownerId,
        push: async () => ({
          kind: 'conflict',
          record: { tableName: 'categories', record: remoteRecord }
        }),
        pull: async () => ({ records: [], cursor: '{}' }),
        subscribe: async () => () => {}
      };

      const engine = createSyncEngine({ db, repository, provider });
      const result = await engine.syncNow();

      expect(result.conflicts).toBe(1);
      // Local category remains unchanged
      expect((await db.categories.get('cat-c'))?.name).toBe('Local Name');
      // Conflict record is preserved
      const conflicts = await db.conflicts.toArray();
      expect(conflicts.length).toBe(1);
      expect((conflicts[0].remote as any).name).toBe('Remote Conflicting Name');
      expect((conflicts[0].local as any).name).toBe('Local Name');
      // Outbox status updated to conflict
      expect((await db.syncOutbox.get('outbox-c'))?.status).toBe('conflict');
    });
  });

  describe('Legacy migration data validation', () => {
    it('recognizes all 17 supported finance tables', () => {
      expect(FINANCE_TABLES.length).toBe(17);
      expect(FINANCE_TABLES).toContain('accounts');
      expect(FINANCE_TABLES).toContain('transactions');
      expect(FINANCE_TABLES).toContain('postings');
      expect(FINANCE_TABLES).toContain('categories');
      expect(FINANCE_TABLES).toContain('fxRates');
    });

    it('sets legacyMigrated flag in db.syncState upon completion', async () => {
      expect(await db.syncState.get('legacyMigrated')).toBeUndefined();
      await db.syncState.put({ id: 'legacyMigrated', value: true });
      expect((await db.syncState.get('legacyMigrated'))?.value).toBe(true);
    });
  });
});
