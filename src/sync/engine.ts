import { financeDb, type FinanceDatabase } from '../db/database';
import { financeRepository, type createFinanceRepository } from '../db/repository';
import type { SyncProvider, RemoteRecord } from './provider';
import type { FinanceSettings } from '../core/types';

export function createSyncEngine({ db = financeDb, repository = financeRepository, provider }: { db?: FinanceDatabase; repository?: ReturnType<typeof createFinanceRepository>; provider: SyncProvider }) {
  let running: Promise<{ uploaded: number; downloaded: number; conflicts: number; disabled?: boolean }> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null, unsubscribe: (() => void) | null = null, started = false;
  async function enabled() { const finance = await repository.getSetting<FinanceSettings>('finance'); return (await repository.getSetting('privacyMode', finance?.privacyMode ?? 'LOCAL_ONLY')) === 'CLOUD_SYNC'; }
  async function incoming(records: RemoteRecord[], ownerId: string) { if (await enabled()) await repository.applyRemoteRecords(records, ownerId); }
  async function perform() {
    if (!await enabled()) return { uploaded: 0, downloaded: 0, conflicts: 0, disabled: true };
    const ownerId = await provider.userId(); if (!ownerId || (await db.syncState.get('ownerId'))?.value !== ownerId) throw new Error('Sign in and explicitly assign local records before syncing.');
    let uploaded = 0, conflicts = 0;
    const entries = await db.syncOutbox.where('ownerId').equals(ownerId).filter(row => row.status !== 'conflict').toArray();
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.baseVersion - b.baseVersion);
    for (const entry of entries) {
      if ((await db.syncOutbox.get(entry.id))?.status === 'conflict') continue;
      if (!await enabled()) return { uploaded, downloaded: 0, conflicts, disabled: true };
      try {
        const response = await provider.push(entry);
        if (response.record.record.ownerId !== ownerId || response.record.tableName !== entry.tableName || response.record.record.id !== entry.entityId) throw new Error('Cloud response ownership mismatch.');
        if (response.kind === 'conflict') {
          await db.transaction('rw', db.conflicts, db.syncOutbox, db.table(entry.tableName), async () => {
            const local = await db.table(entry.tableName).get(entry.entityId);
            await db.conflicts.put({ id: `conflict:${entry.tableName}:${entry.entityId}:${response.record.record.version}`, tableName: entry.tableName, entityId: entry.entityId, ownerId, local: local ?? entry.payload, remote: response.record.record, createdAt: new Date().toISOString() });
            await db.syncOutbox.where('[tableName+entityId]').equals([entry.tableName, entry.entityId]).modify({ status: 'conflict' });
          }); conflicts++;
        } else { await db.syncOutbox.delete(entry.id); uploaded++; }
      } catch {
        await db.syncOutbox.update(entry.id, { status: 'failed', attempts: entry.attempts + 1, error: 'Cloud request failed; the local mutation is retained.' });
        await db.syncState.put({ id: 'lastSyncError', value: 'Cloud request failed. Retry when reachable.' });
        throw new Error('Cloud synchronization failed; local changes remain queued.');
      }
    }
    if (!await enabled()) return { uploaded, downloaded: 0, conflicts, disabled: true };
    const cursor = (await db.syncState.get(`cursor:${ownerId}`))?.value;
    const pulled = await provider.pull(typeof cursor === 'string' ? cursor : undefined);
    await incoming(pulled.records, ownerId);
    if (pulled.cursor) await db.syncState.put({ id: `cursor:${ownerId}`, value: pulled.cursor });
    await db.syncState.put({ id: 'lastSyncAt', value: new Date().toISOString() }); await db.syncState.delete('lastSyncError');
    if (started && !unsubscribe && await enabled()) unsubscribe = await provider.subscribe(records => { void incoming(records, ownerId).catch(() => db.syncState.put({ id: 'lastSyncError', value: 'A cloud update needs review; local data was retained.' })); });
    return { uploaded, downloaded: pulled.records.length, conflicts };
  }
  function syncNow() { if (running) return running; running = perform().finally(() => { running = null; }); return running; }
  const retry = () => { void syncNow().catch(() => {}); };
  function start() { if (started) return; started = true; globalThis.addEventListener?.('online', retry); timer = setInterval(retry, 60000); retry(); }
  function stop() { started = false; globalThis.removeEventListener?.('online', retry); if (timer) clearInterval(timer); timer = null; unsubscribe?.(); unsubscribe = null; }
  return { syncNow, start, stop };
}
