import { app } from '../firebase';
import { getAuth, signOut, signInWithPopup, GoogleAuthProvider } from 'firebase/auth';
import {
  getFirestore,
  doc,
  runTransaction,
  query,
  collection,
  where,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
  writeBatch,
  startAfter,
  type DocumentSnapshot,
  type DocumentData
} from 'firebase/firestore';
import { financeDb, FINANCE_TABLES, type FinanceDatabase, type FinanceTableName, type OutboxEntry, type SyncedEntity } from '../db/database';
import { validateFinanceRecord } from '../db/repository';
import type { RemoteRecord, SyncProvider } from './provider';

function remote(row: Record<string, unknown>, ownerId: string, providedTableName?: FinanceTableName): RemoteRecord {
  const tableName = providedTableName ?? (row.entity_type as FinanceTableName);
  const rawRecord = (row.payload ? row.payload : row) as Record<string, unknown>;
  const record = {
    ...rawRecord,
    id: rawRecord.id ?? row.id,
    ownerId: rawRecord.ownerId ?? row.owner_id,
    version: rawRecord.version ?? row.version
  } as SyncedEntity;

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
  validateFinanceRecord(tableName, record);
  return { tableName, record };
}

export function createFirebaseSyncProvider(db: FinanceDatabase = financeDb) {
  const auth = getAuth(app);
  const firestore = getFirestore(app);

  const requireOwner = async () => {
    const user = auth.currentUser;
    if (!user || user.isAnonymous) {
      throw new Error('Sign in with a verified account before enabling cloud synchronization.');
    }
    return user.uid;
  };

  async function migrateLegacyData(ownerId: string) {
    const flag = await db.syncState.get('legacyMigrated');
    if (flag?.value === true) return;

    let lastDoc: DocumentSnapshot<DocumentData> | null = null;
    let hasMore = true;

    while (hasMore) {
      let q = query(
        collection(firestore, 'finance_entities'),
        where('owner_id', '==', ownerId),
        orderBy('updated_at', 'asc'),
        limit(500)
      );
      if (lastDoc) {
        q = query(
          collection(firestore, 'finance_entities'),
          where('owner_id', '==', ownerId),
          orderBy('updated_at', 'asc'),
          startAfter(lastDoc),
          limit(500)
        );
      }

      const snapshot = await getDocs(q);
      if (snapshot.empty) {
        hasMore = false;
        break;
      }

      let batch = writeBatch(firestore);
      let batchCount = 0;

      for (const docSnap of snapshot.docs) {
        const row = docSnap.data();
        const tableName = row.entity_type as FinanceTableName;
        if (!FINANCE_TABLES.includes(tableName)) continue;

        const normalizedPayload: SyncedEntity = {
          ...(typeof row.payload === 'object' && row.payload !== null ? row.payload : {}),
          id: row.id as string,
          ownerId: ownerId,
          version: (row.version as number) ?? 1,
          createdAt: (row.created_at as string) || new Date().toISOString(),
          updatedAt: (row.updated_at as string) || new Date().toISOString(),
          deletedAt: (row.deleted_at as string) || null,
          deviceId: (row.device_id as string) || 'legacy-migration'
        } as SyncedEntity;

        const writeDoc = {
          owner_id: ownerId,
          entity_type: tableName,
          id: row.id,
          payload: normalizedPayload,
          version: normalizedPayload.version,
          deleted_at: normalizedPayload.deletedAt,
          device_id: normalizedPayload.deviceId,
          created_at: normalizedPayload.createdAt,
          updated_at: normalizedPayload.updatedAt
        };

        const newRef = doc(firestore, 'users', ownerId, tableName, row.id as string);
        batch.set(newRef, writeDoc);
        batchCount++;
      }

      if (batchCount > 0) {
        await batch.commit();
      }

      if (snapshot.docs.length < 500) {
        hasMore = false;
      } else {
        lastDoc = snapshot.docs[snapshot.docs.length - 1];
      }
    }

    await db.syncState.put({ id: 'legacyMigrated', value: true });
  }

  const provider: SyncProvider = {
    async userId() {
      const user = auth.currentUser;
      if (!user || user.isAnonymous) return null;
      return user.uid;
    },
    async push(entry: OutboxEntry) {
      const ownerId = await requireOwner();
      if (entry.ownerId !== ownerId || entry.payload.ownerId !== ownerId) {
        throw new Error('The queued change belongs to another account.');
      }

      const docRef = doc(firestore, 'users', ownerId, entry.tableName, entry.entityId);

      const result = await runTransaction(firestore, async (transaction) => {
        const docSnap = await transaction.get(docRef);
        const existing = docSnap.data();

        if (existing) {
          if (existing.owner_id !== ownerId) throw new Error('Ownership mismatch');
          if (existing.version !== entry.baseVersion) {
            if (
              existing.version === entry.baseVersion + 1 &&
              JSON.stringify(existing.payload) === JSON.stringify(entry.payload)
            ) {
              return { kind: 'applied', record: remote(existing, ownerId, entry.tableName) };
            }
            return { kind: 'conflict', record: remote(existing, ownerId, entry.tableName) };
          }
        } else if (entry.baseVersion !== 0) {
          throw new Error('Missing version history');
        }

        const timestamp = new Date().toISOString();
        const writePayload = {
          owner_id: ownerId,
          entity_type: entry.tableName,
          id: entry.entityId,
          payload: entry.payload,
          version: entry.baseVersion + 1,
          deleted_at: entry.payload.deletedAt || null,
          device_id: entry.payload.deviceId,
          created_at: entry.payload.createdAt,
          updated_at: timestamp
        };

        transaction.set(docRef, writePayload);
        return { kind: 'applied', record: remote(writePayload, ownerId, entry.tableName) };
      });

      return result as { kind: 'applied' | 'conflict'; record: RemoteRecord };
    },
    async pull(cursor?: string) {
      const ownerId = await requireOwner();
      await migrateLegacyData(ownerId);

      const boundary = new Date().toISOString();
      const records: RemoteRecord[] = [];

      // Parse composite per-table cursors or backward-compatible ISO timestamp string
      let tableCursors: Record<string, string> = {};
      if (cursor) {
        try {
          const parsed = JSON.parse(cursor);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            tableCursors = parsed as Record<string, string>;
          } else if (typeof parsed === 'string') {
            for (const t of FINANCE_TABLES) tableCursors[t] = parsed;
          }
        } catch {
          // Plain ISO timestamp string fallback
          for (const t of FINANCE_TABLES) tableCursors[t] = cursor;
        }
      }

      for (const tableName of FINANCE_TABLES) {
        const tableCursor = tableCursors[tableName];
        let q = query(
          collection(firestore, 'users', ownerId, tableName),
          where('updated_at', '<=', boundary),
          orderBy('updated_at', 'asc')
        );

        if (tableCursor) {
          q = query(q, where('updated_at', '>', tableCursor));
        }

        q = query(q, limit(1000));
        const snapshot = await getDocs(q);

        let maxTableUpdated = tableCursor || '1970-01-01T00:00:00.000Z';
        for (const docSnap of snapshot.docs) {
          const row = docSnap.data();
          records.push(remote(row, ownerId, tableName));
          const rowUpdated = (row.updated_at as string) || (row.payload as Record<string, unknown>)?.updatedAt as string;
          if (rowUpdated && rowUpdated > maxTableUpdated) {
            maxTableUpdated = rowUpdated;
          }
        }
        tableCursors[tableName] = maxTableUpdated;
      }

      return { records, cursor: JSON.stringify(tableCursors) };
    },
    async subscribe(callback, onError) {
      const ownerId = await requireOwner();
      const unsubscribes: (() => void)[] = [];

      for (const tableName of FINANCE_TABLES) {
        const q = query(collection(firestore, 'users', ownerId, tableName));

        const unsubscribe = onSnapshot(
          q,
          (snapshot) => {
            const records: RemoteRecord[] = [];
            snapshot.docChanges().forEach((change) => {
              if (change.type === 'added' || change.type === 'modified') {
                const row = change.doc.data();
                try {
                  records.push(remote(row, ownerId, tableName));
                } catch {
                  // Ignore ownership/schema failures
                }
              }
            });
            if (records.length > 0) {
              callback(records);
            }
          },
          (error) => {
            console.warn(`Firestore snapshot subscription error for table ${tableName}:`, error);
            void db.syncState.put({
              id: 'lastSyncError',
              value: `Cloud listener error on ${tableName}: ${error.message || 'connection interrupted'}`
            }).catch(() => {});
            onError?.(error);
          }
        );
        unsubscribes.push(unsubscribe);
      }

      return () => unsubscribes.forEach((u) => u());
    }
  };

  return Object.assign(provider, {
    signInWithGoogle: async () => {
      const authProvider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, authProvider);
      return { user: { email: result.user.email } };
    },
    signOut: async () => {
      await signOut(auth);
    }
  });
}
