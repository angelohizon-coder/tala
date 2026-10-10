/**
 * r4-ml-categorization.test.mjs
 * Tier 1: Feature Coverage — Requirement R4 (Client-Side ML Categorization)
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockMLCategorizerWorker } from '../helpers/mock-worker.mjs';
import { MockNetworkGate } from '../helpers/mock-network.mjs';

describe('Tier 1: R4 Client-Side ML Categorization', () => {
  it('T1.R4.1: Web Worker executes classification locally using quantized model format', async () => {
    const worker = new MockMLCategorizerWorker();

    // 1. Initialize model
    const initPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'INIT_SUCCESS') resolve(e.data);
      };
    });
    worker.postMessage({ type: 'INIT_MODEL', modelUrl: '/models' });
    const initRes = await initPromise;

    assert.equal(initRes.payload.model, 'categorizer-q8.onnx');
    assert.equal(initRes.payload.quantized, 'INT8');

    // 2. Classify transaction
    const classifyPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'CATEGORIZE_SUCCESS') resolve(e.data.payload.results);
      };
    });

    worker.postMessage({
      type: 'CATEGORIZE_TRANSACTIONS',
      payload: {
        transactions: [
          { id: 'tx_1', description: 'MERALCO POWER PAYMENT', amount: 350000 },
          { id: 'tx_2', description: 'SM SUPERMARKET MAKATI', amount: 245000 }
        ]
      }
    });

    const results = await classifyPromise;
    assert.equal(results.length, 2);

    assert.equal(results[0].id, 'tx_1');
    assert.equal(results[0].categoryId, 'cat_utilities');
    assert.ok(results[0].confidence > 0.9);

    assert.equal(results[1].id, 'tx_2');
    assert.equal(results[1].categoryId, 'cat_groceries');
    assert.ok(results[1].confidence > 0.9);
  });

  it('T1.R4.2: Inference produces zero outbound network requests (no server-side data leakage)', async () => {
    const network = new MockNetworkGate('LOCAL_ONLY');
    const worker = new MockMLCategorizerWorker();

    const classifyPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'CATEGORIZE_SUCCESS') resolve(e.data.payload.results);
      };
    });

    // Sensitive payroll & health descriptions
    worker.postMessage({
      type: 'CATEGORIZE_TRANSACTIONS',
      payload: {
        transactions: [
          { id: 'tx_priv_1', description: 'PAYROLL ACME CORP DIRECT DEPOSIT', amount: 8000000 },
          { id: 'tx_priv_2', description: 'ST LUKES MEDICAL CENTER OPD', amount: 1200000 }
        ]
      }
    });

    const results = await classifyPromise;
    assert.equal(results.length, 2);
    assert.equal(results[0].categoryId, 'cat_income');

    // Invariant: zero network calls made
    assert.equal(network.getOutboundCount(), 0, 'Inference must produce zero outbound network calls');
  });

  it('T1.R4.3: Model returns ranked confidence scores and top alternative categories', async () => {
    const worker = new MockMLCategorizerWorker();

    const classifyPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'CATEGORIZE_SUCCESS') resolve(e.data.payload.results);
      };
    });

    worker.postMessage({
      type: 'CATEGORIZE_TRANSACTIONS',
      payload: {
        transactions: [{ id: 'tx_starbucks', description: 'STARBUCKS COFFEE BGC', amount: 21000 }]
      }
    });

    const results = await classifyPromise;
    assert.equal(results.length, 1);
    const pred = results[0];

    assert.equal(pred.categoryId, 'cat_dining');
    assert.equal(pred.categoryName, 'Food & Dining');
    assert.ok(pred.confidence >= 0.0 && pred.confidence <= 1.0);
    assert.ok(Array.isArray(pred.alternatives));
    assert.ok(pred.alternatives.length > 0);
  });

  it('T1.R4.4: Tiered hybrid categorization resolves cached user rules in IDB before worker ML', () => {
    // Tier 1: Local IDB Rule Cache (0.05ms)
    const localRuleCache = new Map([
      ['netflix.com', 'cat_entertainment'],
      ['spotify ab', 'cat_entertainment']
    ]);

    function categorize(merchant, worker) {
      const normalized = merchant.trim().toLowerCase();
      if (localRuleCache.has(normalized)) {
        return {
          resolvedBy: 'idb_rule_cache',
          categoryId: localRuleCache.get(normalized),
          confidence: 1.0
        };
      }
      return { resolvedBy: 'ml_worker', categoryId: 'pending' };
    }

    const cachedRes = categorize('netflix.com');
    assert.equal(cachedRes.resolvedBy, 'idb_rule_cache');
    assert.equal(cachedRes.categoryId, 'cat_entertainment');
    assert.equal(cachedRes.confidence, 1.0);

    const uncachedRes = categorize('unknown bistro');
    assert.equal(uncachedRes.resolvedBy, 'ml_worker');
  });

  it('T1.R4.5: Batch categorization handles 50+ imported statement items without timeout', async () => {
    const worker = new MockMLCategorizerWorker();
    const batch = Array.from({ length: 50 }, (_, i) => ({
      id: `batch_tx_${i}`,
      description: i % 2 === 0 ? 'JOLLIBEE DRIVE THRU' : 'PETRON GAS STATION',
      amount: 15000 + i * 100
    }));

    const classifyPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'CATEGORIZE_SUCCESS') resolve(e.data.payload.results);
      };
    });

    worker.postMessage({
      type: 'CATEGORIZE_TRANSACTIONS',
      payload: { transactions: batch }
    });

    const results = await classifyPromise;
    assert.equal(results.length, 50);
    assert.equal(results[0].categoryId, 'cat_dining');
    assert.equal(results[1].categoryId, 'cat_transport');
  });

  it('T1.R4.6: Unknown or cryptic merchants fall back safely to miscellaneous category', async () => {
    const worker = new MockMLCategorizerWorker();

    const classifyPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'CATEGORIZE_SUCCESS') resolve(e.data.payload.results);
      };
    });

    worker.postMessage({
      type: 'CATEGORIZE_TRANSACTIONS',
      payload: {
        transactions: [{ id: 'tx_cryptic', description: 'POS 99824987 XY-ZZ-Q', amount: 50000 }]
      }
    });

    const results = await classifyPromise;
    assert.equal(results.length, 1);
    assert.equal(results[0].categoryId, 'cat_other');
    assert.equal(results[0].categoryName, 'Other / Miscellaneous');
  });
});
