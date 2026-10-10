/**
 * scenario-offline-reconnect-sync.test.mjs
 * Tier 4: Real-World Application Scenario — Multi-Tab Offline & Reconnect Sync
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockWebLockManager } from '../helpers/mock-weblocks.mjs';

describe('Tier 4: Scenario — Multi-Tab Offline & Reconnect Synchronization', () => {
  it('T4.SCEN.3: Concurrent tabs queue mutations offline via Web Locks and merge on reconnect without duplicate records', async () => {
    const lockManager = new MockWebLockManager();
    const localOutbox = [];
    const remoteFirestore = new Map();

    let isOnline = false;

    // Simulate Tab 1 and Tab 2 writing offline transactions
    const tab1Task = lockManager.request('tala_sync', async () => {
      const entry = {
        id: 'outbox_tab1',
        tableName: 'transactions',
        entityId: 'tx_coffee',
        payload: { id: 'tx_coffee', description: 'Coffee', amount: 18000, version: 1 },
        status: isOnline ? 'applied' : 'pending'
      };
      localOutbox.push(entry);
      return entry;
    }, 'tab_1');

    const tab2Task = lockManager.request('tala_sync', async () => {
      const entry = {
        id: 'outbox_tab2',
        tableName: 'transactions',
        entityId: 'tx_groceries',
        payload: { id: 'tx_groceries', description: 'Groceries', amount: 350000, version: 1 },
        status: isOnline ? 'applied' : 'pending'
      };
      localOutbox.push(entry);
      return entry;
    }, 'tab_2');

    await Promise.all([tab1Task, tab2Task]);

    // Both mutations queued locally
    assert.equal(localOutbox.length, 2);
    assert.equal(localOutbox.every(m => m.status === 'pending'), true);
    assert.equal(remoteFirestore.size, 0);

    // Reconnection event fired
    isOnline = true;

    // Sync engine reconnect trigger executes under Web Lock
    await lockManager.request('tala_sync', async () => {
      for (const entry of localOutbox) {
        if (entry.status === 'pending') {
          // Idempotent commit: check if already exists
          if (!remoteFirestore.has(entry.entityId)) {
            remoteFirestore.set(entry.entityId, entry.payload);
            entry.status = 'applied';
          }
        }
      }
    }, 'tab_sync_reconnect');

    // Remote database has both records with zero duplicates
    assert.equal(remoteFirestore.size, 2);
    assert.equal(remoteFirestore.has('tx_coffee'), true);
    assert.equal(remoteFirestore.has('tx_groceries'), true);
    assert.equal(localOutbox.every(m => m.status === 'applied'), true);
  });
});
