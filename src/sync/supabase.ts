import { createClient } from '@supabase/supabase-js';
import { financeDb, FINANCE_TABLES, type FinanceDatabase, type FinanceTableName, type OutboxEntry, type SyncedEntity } from '../db/database';
import { validateFinanceRecord } from '../db/repository';
import type { RemoteRecord, SyncProvider } from './provider';

function publicKey(key: string) {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/u.test(key)) return true;
  try { const payload = key.split('.')[1]; return key.split('.').length === 3 && JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))).role === 'anon'; } catch { return false; }
}
export function validateSupabaseConfiguration(url: string, publishableKey: string) {
  let target: URL;
  try { target = new URL(url); } catch { throw new Error('A valid HTTPS Supabase URL is required.'); }
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || !publicKey(publishableKey)) throw new Error('Use an HTTPS Supabase endpoint and its browser publishable or anon key. Private keys are prohibited.');
  return target.origin;
}
function remote(row: Record<string, unknown>, ownerId: string): RemoteRecord {
  const tableName = row.entity_type as FinanceTableName, record = row.payload as SyncedEntity;
  if (!FINANCE_TABLES.includes(tableName) || !record || record.ownerId !== ownerId || row.owner_id !== ownerId || record.id !== row.id || record.version !== row.version) throw new Error('Cloud data failed ownership or version validation.');
  validateFinanceRecord(tableName, record); return { tableName, record };
}

/** No client or auth network operation exists until the user configures this provider. */
export function createSupabaseSyncProvider({ url, publishableKey, db = financeDb }: { url: string; publishableKey: string; db?: FinanceDatabase }) {
  const endpoint = validateSupabaseConfiguration(url, publishableKey);
  const client = createClient(endpoint, publishableKey, { auth: {
    persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
    storage: {
      getItem: async (key: string) => { const value = (await db.syncState.get(`auth:${key}`))?.value; return typeof value === 'string' ? value : null; },
      setItem: async (key: string, value: string) => { await db.syncState.put({ id: `auth:${key}`, value }); },
      removeItem: async (key: string) => { await db.syncState.delete(`auth:${key}`); },
    },
  } });
  const requireOwner = async () => { const { data, error } = await client.auth.getUser(); if (error || !data.user) throw new Error('Sign in before enabling cloud synchronization.'); return data.user.id; };
  const provider: SyncProvider = {
    async userId() { const { data, error } = await client.auth.getUser(); return error ? null : data.user?.id ?? null; },
    async push(entry: OutboxEntry) {
      const ownerId = await requireOwner();
      if (entry.ownerId !== ownerId || entry.payload.ownerId !== ownerId) throw new Error('The queued change belongs to another account.');
      const { data, error } = await client.rpc('apply_finance_mutation', { p_entity_type: entry.tableName, p_id: entry.entityId, p_expected_version: entry.baseVersion, p_payload: entry.payload });
      if (error || !data || !['applied', 'conflict'].includes(data.kind)) throw new Error('The cloud write failed; the local change remains queued.');
      return { kind: data.kind as 'applied' | 'conflict', record: remote(data.record, ownerId) };
    },
    async pull(cursor?: string) {
      const ownerId = await requireOwner();
      if (cursor && !Number.isFinite(Date.parse(cursor))) throw new Error('Cloud cursor is invalid.');
      const { data: boundary, error: clockError } = await client.rpc('finance_server_time');
      if (clockError || typeof boundary !== 'string' || !Number.isFinite(Date.parse(boundary))) throw new Error('Cloud connectivity could not be verified.');
      const records: RemoteRecord[] = []; let latest = cursor;
      for (let offset = 0; offset < 500000; offset += 1000) {
        let query = client.from('finance_entities').select('*').eq('owner_id', ownerId).lte('updated_at', boundary).order('updated_at').order('entity_type').order('id').range(offset, offset + 999);
        if (cursor) query = query.gte('updated_at', cursor);
        const { data, error } = await query;
        if (error || !data) throw new Error('The cloud read failed; local records remain available.');
        for (const row of data) { records.push(remote(row, ownerId)); latest = row.updated_at as string; }
        if (data.length < 1000) return { records, cursor: latest };
      }
      throw new Error('Cloud download exceeds the supported batch size.');
    },
    async subscribe(callback) {
      const ownerId = await requireOwner(), { data } = await client.auth.getSession();
      if (!data.session) throw new Error('An authenticated session is required.');
      await client.realtime.setAuth(data.session.access_token);
      const channel = client.channel(`finance:${ownerId}`, { config: { private: true } });
      for (const event of ['INSERT', 'UPDATE', 'DELETE']) channel.on('broadcast', { event }, message => {
        const row = message.payload?.record ?? message.payload?.new;
        if (!row) return;
        try { callback([remote(row, ownerId)]); } catch { /* Ownership/schema failures are not applied. */ }
      });
      channel.subscribe();
      return () => { void client.removeChannel(channel); };
    },
  };
  return Object.assign(provider, {
    client,
    signIn: async (email: string, password: string) => { const result = await client.auth.signInWithPassword({ email, password }); if (result.error) throw new Error('Sign-in failed. Check your credentials.'); return result.data; },
    signUp: async (email: string, password: string) => { const result = await client.auth.signUp({ email, password }); if (result.error) throw new Error('Account registration failed.'); return result.data; },
    signOut: async () => { const result = await client.auth.signOut(); if (result.error) throw new Error('Sign-out failed.'); },
  });
}
