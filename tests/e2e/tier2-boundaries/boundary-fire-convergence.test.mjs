/**
 * boundary-fire-convergence.test.mjs
 * Tier 2: Boundary & Corner Cases — Requirement R5 Monte Carlo FIRE Convergence
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockMonteCarloWorker } from '../helpers/mock-worker.mjs';

describe('Tier 2: Boundary & Corner Cases — Monte Carlo FIRE Convergence', () => {
  it('T2.FIRE.1: Long time horizon (80 years) executes without memory exhaustion', async () => {
    const worker = new MockMonteCarloWorker();

    const simPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'SIMULATION_RESULT') resolve(e.data.payload);
      };
    });

    worker.postMessage({
      type: 'START_SIMULATION',
      payload: {
        initialAssets: 1000000000,
        annualContribution: 20000000,
        annualExpenses: 25000000,
        iterations: 5000,
        years: 80,
        degreesOfFreedom: 5
      }
    });

    const result = await simPromise;
    assert.equal(result.percentiles.p50.length, 81);
    assert.ok(result.iterations >= 5000);
  });

  it('T2.FIRE.2: Heavy tail risk modeling with v=3 degrees of freedom handles extreme variances', async () => {
    const worker = new MockMonteCarloWorker();

    const simPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'SIMULATION_RESULT') resolve(e.data.payload);
      };
    });

    worker.postMessage({
      type: 'START_SIMULATION',
      payload: {
        initialAssets: 500000000,
        annualContribution: 0,
        annualExpenses: 20000000,
        iterations: 5000,
        years: 30,
        degreesOfFreedom: 3 // Heavy tails
      }
    });

    const result = await simPromise;
    assert.equal(result.degreesOfFreedom, 3);
    assert.ok(Number.isFinite(result.successRate));
  });

  it('T2.FIRE.3: Rapid depletion boundary condition yields 0% success rate with early depletion peak in PDF', async () => {
    const worker = new MockMonteCarloWorker();

    const simPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'SIMULATION_RESULT') resolve(e.data.payload);
      };
    });

    // Initial PHP 100k, spending PHP 1M/yr -> guaranteed depletion within 1-2 years
    worker.postMessage({
      type: 'START_SIMULATION',
      payload: {
        initialAssets: 10000000,
        annualContribution: 0,
        annualExpenses: 100000000,
        iterations: 5000,
        years: 30,
        degreesOfFreedom: 5
      }
    });

    const result = await simPromise;
    assert.equal(result.successRate, 0.0);
    // Depletion year 1 or 2 should have near 100% probability
    const earlyDepletion = (result.depletionYearPdf[0] || 0) + (result.depletionYearPdf[1] || 0);
    assert.ok(earlyDepletion > 0.95);
  });

  it('T2.FIRE.4: Perpetual endowment boundary condition yields 100% success rate with 0% depletion PDF', async () => {
    const worker = new MockMonteCarloWorker();

    const simPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'SIMULATION_RESULT') resolve(e.data.payload);
      };
    });

    // Initial PHP 1B, spending PHP 10k/yr -> guaranteed survival for low-volatility endowment
    worker.postMessage({
      type: 'START_SIMULATION',
      payload: {
        initialAssets: 100000000000,
        annualContribution: 0,
        annualExpenses: 1000000,
        expectedReturn: 0.07,
        returnVolatility: 0.05,
        iterations: 5000,
        years: 30,
        degreesOfFreedom: 5
      }
    });

    const result = await simPromise;
    assert.equal(result.successRate, 1.0);
    for (const prob of Object.values(result.depletionYearPdf)) {
      assert.equal(prob, 0);
    }
  });

  it('T2.FIRE.5: Hyperinflation scenario (mean 15%, vol 5%) models purchasing power erosion', async () => {
    const worker = new MockMonteCarloWorker();

    const simPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'SIMULATION_RESULT') resolve(e.data.payload);
      };
    });

    worker.postMessage({
      type: 'START_SIMULATION',
      payload: {
        initialAssets: 1000000000,
        annualContribution: 0,
        annualExpenses: 40000000,
        inflationMean: 0.15, // 15% inflation
        inflationStd: 0.05,
        iterations: 5000,
        years: 25
      }
    });

    const result = await simPromise;
    // Hyperinflation dramatically lowers survival compared to normal 3% inflation
    assert.ok(result.successRate < 0.60);
  });

  it('T2.FIRE.6: Zero starting assets with steady contribution models accumulation phase growth', async () => {
    const worker = new MockMonteCarloWorker();

    const simPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'SIMULATION_RESULT') resolve(e.data.payload);
      };
    });

    worker.postMessage({
      type: 'START_SIMULATION',
      payload: {
        initialAssets: 0, // Starts at 0
        annualContribution: 100000000, // PHP 1M / year
        annualExpenses: 0,
        iterations: 5000,
        years: 10,
        expectedReturn: 0.08,
        returnVolatility: 0.10
      }
    });

    const result = await simPromise;
    assert.equal(result.percentiles.p50[0], 0);
    // At year 10, median wealth should have grown substantially above cumulative contributions (10M)
    assert.ok(result.percentiles.p50[10] > 1000000000);
    assert.equal(result.successRate, 1.0);
  });
});
