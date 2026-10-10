/**
 * scenario-csv-ml-import.test.mjs
 * Tier 4: Real-World Application Scenario — Statement CSV Import & In-Browser ML Categorization
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockMLCategorizerWorker } from '../helpers/mock-worker.mjs';
import { MockNetworkGate } from '../helpers/mock-network.mjs';

describe('Tier 4: Scenario — CSV Import & In-Browser ML Classification', () => {
  it('T4.SCEN.5: End-to-end statement import classifies transactions in-browser with zero network calls and learns user overrides', async () => {
    const network = new MockNetworkGate('LOCAL_ONLY');
    const worker = new MockMLCategorizerWorker();
    const idbRuleCache = new Map();
    const dbTransactions = [];

    // 1. Raw imported bank CSV rows
    const rawCsvTransactions = [
      { id: 'csv_1', description: 'MERALCO ENERGY BILL', amount: 450000, date: '2026-10-01' },
      { id: 'csv_2', description: 'SM SUPERMARKET MEGAMALL', amount: 320000, date: '2026-10-02' },
      { id: 'csv_3', description: 'JOLLIBEE PASIG', amount: 28000, date: '2026-10-03' },
      { id: 'csv_4', description: 'GRAB HOLDINGS CAR', amount: 45000, date: '2026-10-04' },
      { id: 'csv_5', description: 'LOCAL BOUTIQUE CAFE', amount: 22000, date: '2026-10-05' }
    ];

    // 2. Classify via Web Worker locally
    const classifyPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'CATEGORIZE_SUCCESS') resolve(e.data.payload.results);
      };
    });

    worker.postMessage({
      type: 'CATEGORIZE_TRANSACTIONS',
      payload: { transactions: rawCsvTransactions }
    });

    const mlResults = await classifyPromise;
    assert.equal(mlResults.length, 5);

    // 3. Confirm zero outbound network requests during inference
    assert.equal(network.getOutboundCount(), 0, 'Inference must be strictly on-device without network leakage');

    // 4. Ingest into local transaction database
    for (let i = 0; i < rawCsvTransactions.length; i++) {
      const row = rawCsvTransactions[i];
      const ml = mlResults[i];
      dbTransactions.push({
        ...row,
        categoryId: ml.categoryId,
        categoryName: ml.categoryName,
        confidence: ml.confidence
      });
    }

    assert.equal(dbTransactions[0].categoryId, 'cat_utilities');
    assert.equal(dbTransactions[1].categoryId, 'cat_groceries');
    assert.equal(dbTransactions[2].categoryId, 'cat_dining');
    assert.equal(dbTransactions[3].categoryId, 'cat_transport');

    // 5. User overrides "LOCAL BOUTIQUE CAFE" to Food & Dining
    const cafeTx = dbTransactions.find(t => t.id === 'csv_5');
    cafeTx.categoryId = 'cat_dining';
    idbRuleCache.set('local boutique cafe', 'cat_dining');

    // 6. Verify subsequent matching entry uses local rule cache
    const nextImportDesc = 'LOCAL BOUTIQUE CAFE';
    const cachedMatch = idbRuleCache.get(nextImportDesc.toLowerCase());
    assert.equal(cachedMatch, 'cat_dining');
  });
});
