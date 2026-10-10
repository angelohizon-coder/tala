import type { FinanceTableName, OutboxEntry, SyncedEntity } from '../db/database';
export interface RemoteRecord { tableName: FinanceTableName; record: SyncedEntity; }
export interface SyncProvider {
  userId(): Promise<string | null>;
  push(entry: OutboxEntry): Promise<{ kind: 'applied' | 'conflict'; record: RemoteRecord }>;
  pull(cursor?: string): Promise<{ records: RemoteRecord[]; cursor?: string }>;
  subscribe(callback: (records: RemoteRecord[]) => void, onError?: (error: Error) => void): Promise<() => void>;
}
