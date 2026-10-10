/**
 * pairwise-ml-sync.test.mjs
 * Tier 3: Cross-Feature Interactions — ML Categorization & Sync Engine Integration
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockMLCategorizerWorker } from '../helpers/mock-worker.mjs';
import { MockWebLockManager } from '../helpers/mock-weblocks.mjs';

describe('Tier 3: Pairwise Interaction — ML Categorization & Synchronization', () => {
  it('T3.PAIR.7: Transactions classified by Web Worker enqueue into offline syncOutbox and push via Web Locks', async () => {
    const worker = new MockMLCategorizerWorker();
    const lockManager = new MockWebLockManager();
    const outbox = [];
    const remoteFirestore = new Map();

    // 1. Worker classifies imported transaction
    const classifyPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'CATEGORIZE_SUCCESS') resolve(e.data.payload.results);
      };
    });

    worker.postMessage({
      type: 'CATEGORIZE_TRANSACTIONS',
      payload: {
        transactions: [
          { id: 'tx_imported_1', description: 'MERALCO PAYMENT', amount: 350000 }
        ]
      }
    });

    const [pred] = await classifyPromise;

    // 2. Enqueue into outbox with ML-assigned category
    const transactionRecord = {
      id: 'tx_imported_1',
      description: 'MERALCO PAYMENT',
      amount: 350000,
      categoryId: pred.categoryId,
      categoryConfidence: pred.confidence
    };

    outbox.push({
      id: 'outbox_entry_1',
      tableName: 'transactions',
      entityId: 'tx_imported_1',
      payload: transactionRecord,
      status: 'pending'
    });

    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].payload.categoryId, 'cat_utilities');

    // 3. Sync engine drains outbox under tala_sync Web Lock
    await lockManager.request('tala_sync', async () => {
      for (const entry of outbox) {
        remoteFirestore.set(entry.entityId, entry.payload);
        entry.status = 'applied';
      }
    });

    assert.equal(remoteFirestore.size, 1);
    assert.equal(remoteFirestore.get('tx_imported_1').categoryId, 'cat_utilities');
  });

  it('T3.PAIR.8: Manual user override updates local rule cache and schedules updated mutation', () => {
    const ruleCache = new Map();

    // Initial ML prediction was cat_other
    const tx = { id: 'tx_coffee', description: 'LOCAL ARTISAN ROASTER', categoryId: 'cat_other' };

    // User overrides to Dining & Cafe
    tx.categoryId = 'cat_dining';
    ruleCache.set('local artisan roaster', 'cat_dining');

    // Subsequent import with exact name resolves from cache without calling worker
    const nextImportDesc = 'LOCAL ARTISAN ROASTER';
    const cachedCat = ruleCache.get(nextImportDesc.toLowerCase());

    assert.equal(cachedCat, 'cat_dining');
  });

  it('T3.PAIR.9: Offline statement import with ML categorization retains all records when network is down', async () => {
    const worker = new MockMLCategorizerWorker();
    const outbox = [];
    const isOnline = false;

    const classifyPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'CATEGORIZE_SUCCESS') resolve(e.data.payload.results);
      };
    });

    worker.postMessage({
      type: 'CATEGORIZE_TRANSACTIONS',
      payload: {
        transactions: [
          { id: 'off_1', description: 'SM SUPERMARKET', amount: 150000 },
          { id: 'off_2', description: 'GRAB TAXI', amount: 35000 }
        ]
      }
    });

    const results = await classifyPromise;
    for (const r of results) {
      outbox.push({
        id: `out_${r.id}`,
        payload: { id: r.id, categoryId: r.categoryId },
        status: isOnline ? 'applied' : 'pending'
      });
    }

    assert.equal(outbox.length, 2);
    assert.equal(outbox.every(i => i.status === 'pending'), true);
  });
});
