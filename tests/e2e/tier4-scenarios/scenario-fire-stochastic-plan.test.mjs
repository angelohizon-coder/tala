/**
 * scenario-fire-stochastic-plan.test.mjs
 * Tier 4: Real-World Application Scenario — Full FIRE Monte Carlo Planning Lifecycle
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePortfolioNetWorth } from '../helpers/financial-engine.mjs';
import { MockMonteCarloWorker } from '../helpers/mock-worker.mjs';

describe('Tier 4: Scenario — Stochastic FIRE Retirement Planning', () => {
  it('T4.SCEN.6: Full retirement plan lifecycle runs 5,000 Student’s t-distribution runs, converges statistically, and outputs PDF distribution', async () => {
    // 1. Portfolio Setup: Savings Account (PHP 5M) + Foreign Investment (USD 50k @ 56 = PHP 2.8M)
    const accounts = [
      { id: 'acc_php_savings', currency: 'PHP', includeInNetWorth: true, openingBalances: { PHP: 500000000 } },
      { id: 'acc_usd_stocks', currency: 'USD', includeInNetWorth: true, openingBalances: { USD: 5000000 } }
    ];

    const fxRate = { id: 'fx', fromCurrency: 'USD', toCurrency: 'PHP', rate: 56.0, asOf: '2026-10-09T00:00:00Z' };

    // Portfolio net worth = PHP 5M + (USD 50k * 56 = PHP 2.8M) = PHP 7.8M (780,000,000 centavos)
    const valuation = calculatePortfolioNetWorth(accounts, [], [fxRate], 'PHP');
    assert.equal(valuation.netWorth, 780000000);
    assert.equal(valuation.complete, true);

    // 2. Launch 5,000 iteration simulation with Student's t fat tails (v=5)
    const worker = new MockMonteCarloWorker();
    const simPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'SIMULATION_RESULT') resolve(e.data.payload);
      };
    });

    worker.postMessage({
      type: 'START_SIMULATION',
      payload: {
        initialAssets: valuation.netWorth, // PHP 7.8M starting wealth
        annualContribution: 60000000,     // PHP 600k / year savings
        annualExpenses: 36000000,         // PHP 360k / year living expenses
        expectedReturn: 0.08,             // 8% equity return
        returnVolatility: 0.16,           // 16% volatility
        equityDegreesOfFreedom: 5,        // Student's t v=5
        expectedInflation: 0.035,         // 3.5% inflation
        inflationVolatility: 0.015,
        iterations: 5000,
        years: 40
      }
    });

    const result = await simPromise;

    // 3. Statistical Verification
    assert.ok(result.iterations >= 5000, 'Must run >= 5000 iterations');
    assert.equal(result.degreesOfFreedom, 5, 'Must use Student’s t-distribution with df=5');
    assert.ok(result.standardError <= 0.01, 'Standard error must be <= 0.01 for statistical convergence');
    assert.ok(result.successRate > 0.85, 'Plan success rate must be high given healthy savings rate');

    // 4. Probability Density Function (PDF) Verification
    const pdf = result.depletionYearPdf;
    assert.ok(pdf, 'Depletion PDF must be provided');
    assert.equal(typeof pdf[0], 'number');
    assert.equal(typeof pdf[40], 'number');

    // 5. Percentile Trajectory Fan Chart Verification
    const { p10, p50, p90 } = result.percentiles;
    assert.equal(p10.length, 41);
    assert.equal(p50.length, 41);
    assert.equal(p90.length, 41);

    // Initial wealth matches valuation
    assert.equal(p50[0], 780000000);

    // P10 <= P50 <= P90 across every single year
    for (let yr = 0; yr <= 40; yr++) {
      assert.ok(p10[yr] <= p50[yr]);
      assert.ok(p50[yr] <= p90[yr]);
    }
  });
});
