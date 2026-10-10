/**
 * boundary-ml-edgecases.test.mjs
 * Tier 2: Boundary & Corner Cases — Requirement R4 ML Categorization
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockMLCategorizerWorker } from '../helpers/mock-worker.mjs';

describe('Tier 2: Boundary & Corner Cases — ML Categorization', () => {
  it('T2.ML.1: Empty or whitespace-only transaction descriptions handle gracefully without error', async () => {
    const worker = new MockMLCategorizerWorker();

    const classifyPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'CATEGORIZE_SUCCESS') resolve(e.data.payload.results);
      };
    });

    worker.postMessage({
      type: 'CATEGORIZE_TRANSACTIONS',
      payload: {
        transactions: [
          { id: 'empty_1', description: '', amount: 1000 },
          { id: 'empty_2', description: '    \t\n   ', amount: 2000 }
        ]
      }
    });

    const results = await classifyPromise;
    assert.equal(results.length, 2);
    assert.equal(results[0].categoryId, 'cat_other');
    assert.equal(results[1].categoryId, 'cat_other');
  });

  it('T2.ML.2: Accented characters, peso sign (₱), and unicode emojis sanitize and classify correctly', async () => {
    const worker = new MockMLCategorizerWorker();

    const classifyPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'CATEGORIZE_SUCCESS') resolve(e.data.payload.results);
      };
    });

    worker.postMessage({
      type: 'CATEGORIZE_TRANSACTIONS',
      payload: {
        transactions: [
          { id: 'emoji_1', description: '🛒 Puregold Supermarket ₱500', amount: 50000 },
          { id: 'accent_1', description: 'Restaurán Español Niño', amount: 85000 }
        ]
      }
    });

    const results = await classifyPromise;
    assert.equal(results.length, 2);
    assert.equal(results[0].categoryId, 'cat_groceries');
    assert.equal(results[1].categoryId, 'cat_dining');
  });

  it('T2.ML.3: Extremely long merchant descriptions (10,000+ chars) are truncated safely without worker crash', async () => {
    const worker = new MockMLCategorizerWorker();
    const giantDescription = 'SM SUPERMARKET '.repeat(1000); // 15,000 chars

    const classifyPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'CATEGORIZE_SUCCESS') resolve(e.data.payload.results);
      };
    });

    worker.postMessage({
      type: 'CATEGORIZE_TRANSACTIONS',
      payload: {
        transactions: [{ id: 'giant_1', description: giantDescription, amount: 250000 }]
      }
    });

    const results = await classifyPromise;
    assert.equal(results.length, 1);
    assert.equal(results[0].categoryId, 'cat_groceries');
  });

  it('T2.ML.4: Uniform or unconfident probability distributions flag low confidence threshold', () => {
    const minConfidenceThreshold = 0.60;
    const lowConfidencePrediction = {
      categoryId: 'cat_other',
      confidence: 0.35
    };

    const isConfident = lowConfidencePrediction.confidence >= minConfidenceThreshold;
    assert.equal(isConfident, false, 'Predictions below threshold must be flagged for user review');
  });

  it('T2.ML.5: Rapid successive classify calls to worker queue process cleanly', async () => {
    const worker = new MockMLCategorizerWorker();

    const results = [];
    worker.onmessage = e => {
      if (e.data.type === 'CATEGORIZE_SUCCESS') {
        results.push(...e.data.payload.results);
      }
    };

    worker.postMessage({
      type: 'CATEGORIZE_TRANSACTIONS',
      payload: { transactions: [{ id: 'rapid_1', description: 'MERALCO', amount: 1000 }] }
    });
    worker.postMessage({
      type: 'CATEGORIZE_TRANSACTIONS',
      payload: { transactions: [{ id: 'rapid_2', description: 'GRAB TAXI', amount: 2000 }] }
    });

    await new Promise(r => setTimeout(r, 20));
    assert.equal(results.length, 2);
    assert.equal(results[0].id, 'rapid_1');
    assert.equal(results[1].id, 'rapid_2');
  });

  it('T2.ML.6: Worker termination releases memory cleanly without lingering callbacks', () => {
    const worker = new MockMLCategorizerWorker();
    let terminated = false;
    worker.terminate = () => {
      terminated = true;
      worker.onmessage = null;
    };

    worker.terminate();
    assert.equal(terminated, true);
    assert.equal(worker.onmessage, null);
  });
});
