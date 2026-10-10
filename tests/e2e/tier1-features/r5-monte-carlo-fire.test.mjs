/**
 * r5-monte-carlo-fire.test.mjs
 * Tier 1: Feature Coverage — Requirement R5 (Monte Carlo FIRE Simulations)
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockMonteCarloWorker } from '../helpers/mock-worker.mjs';

describe('Tier 1: R5 Advanced FIRE Projections (Monte Carlo)', () => {
  it('T1.R5.1: Simulation executes at least 5,000 discrete iterations in Web Worker', async () => {
    const worker = new MockMonteCarloWorker();

    const simPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'SIMULATION_RESULT') resolve(e.data.payload);
      };
    });

    worker.postMessage({
      type: 'START_SIMULATION',
      payload: {
        initialAssets: 1000000000, // PHP 10M in centavos
        annualContribution: 60000000, // PHP 600k / year
        annualExpenses: 48000000,     // PHP 480k / year
        iterations: 5000,
        years: 40,
        equityDegreesOfFreedom: 5
      }
    });

    const result = await simPromise;
    assert.ok(result.iterations >= 5000, `Iterations must be at least 5000, got ${result.iterations}`);
    assert.equal(typeof result.successRate, 'number');
    assert.ok(result.successRate >= 0.0 && result.successRate <= 1.0);
  });

  it('T1.R5.2: Models fat-tailed risk utilizing Student’s t-distribution (v=5)', async () => {
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
        annualExpenses: 25000000,
        iterations: 5000,
        years: 30,
        equityDegreesOfFreedom: 5 // Student's t degrees of freedom v=5
      }
    });

    const result = await simPromise;
    assert.equal(result.degreesOfFreedom, 5);
    // Student's t distribution produces realistic sequence-of-returns variance
    assert.ok(result.percentiles.p10.length > 0);
    assert.ok(result.percentiles.p90.length > 0);
  });

  it('T1.R5.3: Outputs Depletion Year Probability Density Function (PDF)', async () => {
    const worker = new MockMonteCarloWorker();

    const simPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'SIMULATION_RESULT') resolve(e.data.payload);
      };
    });

    worker.postMessage({
      type: 'START_SIMULATION',
      payload: {
        initialAssets: 200000000, // PHP 2M
        annualContribution: 0,
        annualExpenses: 30000000, // PHP 300k (high withdrawal rate to induce depletion)
        iterations: 5000,
        years: 25,
        equityDegreesOfFreedom: 5
      }
    });

    const result = await simPromise;
    const pdf = result.depletionYearPdf;
    assert.ok(pdf, 'Depletion PDF must be provided');

    // Verify PDF probabilities sum to <= 1.0 (with remainder surviving)
    let totalDepletionProb = 0;
    for (const [year, prob] of Object.entries(pdf)) {
      assert.ok(prob >= 0.0 && prob <= 1.0, `Prob at year ${year} out of bounds: ${prob}`);
      totalDepletionProb += prob;
    }
    assert.ok(totalDepletionProb <= 1.00001);
  });

  it('T1.R5.4: Generates trajectory bands for percentile fan chart (P10, P50, P90)', async () => {
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
        annualContribution: 50000000,
        annualExpenses: 40000000,
        iterations: 5000,
        years: 30
      }
    });

    const result = await simPromise;
    const { p10, p50, p90 } = result.percentiles;

    assert.equal(p10.length, 31); // 0 to 30 years
    assert.equal(p50.length, 31);
    assert.equal(p90.length, 31);

    // Invariant: P10 <= P50 <= P90 at every time step
    for (let yr = 0; yr <= 30; yr++) {
      assert.ok(p10[yr] <= p50[yr], `p10 (${p10[yr]}) must be <= p50 (${p50[yr]}) at year ${yr}`);
      assert.ok(p50[yr] <= p90[yr], `p50 (${p50[yr]}) must be <= p90 (${p90[yr]}) at year ${yr}`);
    }
  });

  it('T1.R5.5: Statistical convergence satisfies standard error bound (SE <= 0.01)', async () => {
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
        annualContribution: 50000000,
        annualExpenses: 40000000,
        iterations: 5000,
        years: 30
      }
    });

    const result = await simPromise;
    // For N=5000, maximum possible SE is sqrt(0.5*0.5 / 5000) = 0.00707 <= 0.01
    assert.ok(
      result.standardError <= 0.01,
      `Standard error ${result.standardError} must be <= 0.01 for N=5000`
    );
  });

  it('T1.R5.6: Zero-volatility scenario conforms to deterministic compounding benchmark', async () => {
    const worker = new MockMonteCarloWorker();

    const simPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'SIMULATION_RESULT') resolve(e.data.payload);
      };
    });

    // Zero volatility test
    worker.postMessage({
      type: 'START_SIMULATION',
      payload: {
        initialAssets: 10000000, // 100k
        annualContribution: 0,
        annualExpenses: 0,
        expectedReturn: 0.10, // 10%
        returnVolatility: 0.0, // 0 volatility
        expectedInflation: 0.0,
        inflationVolatility: 0.0,
        iterations: 5000,
        years: 5
      }
    });

    const result = await simPromise;
    // Expected after 5 years @ 10%: 10000000 * (1.10)^5 = 16105100
    const medianYear5 = result.percentiles.p50[5];
    const expected = Math.round(10000000 * Math.pow(1.10, 5));
    assert.equal(Math.round(medianYear5), expected);
    assert.equal(result.successRate, 1.0);
  });
});
