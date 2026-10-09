import { app } from '../firebase';
import { getAuth, signOut } from 'firebase/auth';
import { getFirestore, doc, runTransaction, query, collection, where, orderBy, limit, getDocs, onSnapshot } from 'firebase/firestore';
import { financeDb, FINANCE_TABLES, type FinanceDatabase, type FinanceTableName, type OutboxEntry, type SyncedEntity } from '../db/database';
import { validateFinanceRecord } from '../db/repository';
import type { RemoteRecord, SyncProvider } from './provider';

function remote(row: Record<string, unknown>, ownerId: string): RemoteRecord {
  const tableName = row.entity_type as FinanceTableName, record = row.payload as SyncedEntity;
  if (!FINANCE_TABLES.includes(tableName) || !record || record.ownerId !== ownerId || row.owner_id !== ownerId || record.id !== row.id || record.version !== row.version) throw new Error('Cloud data failed ownership or version validation.');
  validateFinanceRecord(tableName, record);
  return { tableName, record };
}

export function createFirebaseSyncProvider(db: FinanceDatabase = financeDb) {
  const auth = getAuth(app);
  const firestore = getFirestore(app);

  const requireOwner = async () => { 
    const user = auth.currentUser; 
    if (!user) throw new Error('Sign in before enabling cloud synchronization.'); 
    return user.uid; 
  };

  const provider: SyncProvider = {
    async userId() { 
      return auth.currentUser?.uid ?? null; 
    },
    async push(entry: OutboxEntry) {
      const ownerId = await requireOwner();
      if (entry.ownerId !== ownerId || entry.payload.ownerId !== ownerId) throw new Error('The queued change belongs to another account.');
      
      const docId = `${entry.tableName}_${entry.entityId}`;
      const docRef = doc(firestore, 'finance_entities', docId);
      
      const result = await runTransaction(firestore, async (transaction) => {
        const docSnap = await transaction.get(docRef);
        const existing = docSnap.data();
        
        if (existing) {
          if (existing.owner_id !== ownerId) throw new Error('Ownership mismatch');
          if (existing.version !== entry.baseVersion) {
            // A lost HTTP response may replay the exact mutation after it already committed.
            if (existing.version === entry.baseVersion + 1 && JSON.stringify(existing.payload) === JSON.stringify(entry.payload)) {
              return { kind: 'applied', record: remote(existing, ownerId) };
            }
            return { kind: 'conflict', record: remote(existing, ownerId) };
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
        return { kind: 'applied', record: remote(writePayload, ownerId) };
      });
      
      return result as { kind: 'applied' | 'conflict'; record: RemoteRecord };
    },
    async pull(cursor?: string) {
      const ownerId = await requireOwner();
      
      // Get current local time to act as the boundary for this pull
      const boundary = new Date().toISOString();
      
      const records: RemoteRecord[] = [];
      let latest = cursor;
      
      let q = query(
        collection(firestore, 'finance_entities'),
        where('owner_id', '==', ownerId),
        where('updated_at', '<=', boundary),
        orderBy('updated_at', 'asc')
      );
      
      if (cursor) {
        q = query(q, where('updated_at', '>=', cursor));
      }
      
      q = query(q, limit(1000));
      
      // In Firestore, we must use pagination with startAfter if we want multiple pages
      // For simplicity, we just fetch up to 1000. If we got 1000, the next pull will get the rest.
      const snapshot = await getDocs(q);
      
      for (const docSnap of snapshot.docs) {
        const row = docSnap.data();
        // If cursor was used, it might include the exact same document. We shouldn't fail, but let's just pass it to the engine.
        records.push(remote(row, ownerId));
        latest = row.updated_at as string;
      }
      
      return { records, cursor: latest };
    },
    async subscribe(callback) {
      const ownerId = await requireOwner();
      
      const q = query(
        collection(firestore, 'finance_entities'),
        where('owner_id', '==', ownerId)
        // We could filter by updated_at > now, but Firestore onSnapshot provides changes natively.
      );
      
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const records: RemoteRecord[] = [];
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added' || change.type === 'modified') {
            const row = change.doc.data();
            try {
              records.push(remote(row, ownerId));
            } catch {
              // Ownership/schema failures are not applied.
            }
          }
        });
        if (records.length > 0) {
          callback(records);
        }
      });
      
      return () => unsubscribe();
    },
  };
  
  return Object.assign(provider, {
    signInWithGoogle: async () => {
      const { signInWithPopup, GoogleAuthProvider } = await import('firebase/auth');
      const authProvider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, authProvider);
      return { user: { email: result.user.email } };
    },
    signOut: async () => { 
      await signOut(auth); 
    },
  });
}

