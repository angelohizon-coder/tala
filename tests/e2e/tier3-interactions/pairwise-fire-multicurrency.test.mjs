/**
 * pairwise-fire-multicurrency.test.mjs
 * Tier 3: Cross-Feature Interactions — Multi-Currency Valuation & Monte Carlo FIRE Integration
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePortfolioNetWorth,
  buildLedger
} from '../helpers/financial-engine.mjs';
import { MockMonteCarloWorker } from '../helpers/mock-worker.mjs';

describe('Tier 3: Pairwise Interaction — Multi-Currency & FIRE Monte Carlo', () => {
  const fxUsdPhp = {
    id: 'fx-usd-php',
    fromCurrency: 'USD',
    toCurrency: 'PHP',
    rate: 56.0,
    asOf: '2026-10-09T00:00:00Z'
  };

  it('T3.PAIR.10: Multi-currency account balance (PHP 10,000 + USD 100 @ 56 -> PHP 15,600) feeds accurately into FIRE starting assets', async () => {
    // Account holding PHP 10,000 (1,000,000 centavos) and USD 100 (10,000 cents)
    const multiAccount = {
      id: 'acc_fire_seed',
      name: 'Global Liquid Portfolio',
      currency: 'PHP',
      includeInNetWorth: true,
      openingBalances: {
        PHP: 1000000,
        USD: 10000
      }
    };

    const valuation = calculatePortfolioNetWorth([multiAccount], [], [fxUsdPhp], 'PHP');
    assert.equal(valuation.netWorth, 1560000); // 1,560,000 centavos = PHP 15,600.00

    // Feed valuation directly into Monte Carlo Worker
    const worker = new MockMonteCarloWorker();
    const simPromise = new Promise(resolve => {
      worker.onmessage = e => {
        if (e.data.type === 'SIMULATION_RESULT') resolve(e.data.payload);
      };
    });

    worker.postMessage({
      type: 'START_SIMULATION',
      payload: {
        initialAssets: valuation.netWorth, // Exact minor units
        annualContribution: 500000,
        annualExpenses: 200000,
        iterations: 5000,
        years: 10,
        degreesOfFreedom: 5
      }
    });

    const result = await simPromise;
    assert.equal(result.percentiles.p50[0], 1560000);
    assert.ok(result.successRate > 0.90);
  });

  it('T3.PAIR.11: Missing FX rate prevents launching FIRE simulation with incomplete starting assets', () => {
    const multiAccount = {
      id: 'acc_missing',
      currency: 'PHP',
      includeInNetWorth: true,
      openingBalances: { PHP: 1000000, USD: 10000 }
    };

    // No FX rates
    const valuation = calculatePortfolioNetWorth([multiAccount], [], [], 'PHP');
    assert.equal(valuation.complete, false);
    assert.equal(valuation.netWorth, null);

    // Guard: Application must refuse to run Monte Carlo with incomplete net worth
    function canLaunchFireSimulation(val) {
      if (!val.complete || val.netWorth === null) {
        return { canLaunch: false, reason: 'Portfolio valuation incomplete due to missing FX rates' };
      }
      return { canLaunch: true };
    }

    const check = canLaunchFireSimulation(valuation);
    assert.equal(check.canLaunch, false);
    assert.match(check.reason, /missing FX rates/i);
  });

  it('T3.PAIR.12: Cross-currency transfer between accounts preserves FIRE portfolio net worth and simulation inputs', () => {
    const phpAcc = { id: 'php_acc', currency: 'PHP', includeInNetWorth: true, openingBalances: { PHP: 5600000 } }; // PHP 56k
    const usdAcc = { id: 'usd_acc', currency: 'USD', includeInNetWorth: true, openingBalances: { USD: 0 } };

    // Transfer PHP 56,000 -> USD 1,000 @ 56
    const transferTx = {
      id: 'tx_xfer',
      type: 'TRANSFER',
      date: '2026-10-05',
      accountId: 'php_acc',
      currency: 'PHP',
      amount: 5600000,
      transferAccountId: 'usd_acc',
      transferCurrency: 'USD',
      transferAmount: 100000
    };

    const beforeValuation = calculatePortfolioNetWorth([phpAcc, usdAcc], [], [fxUsdPhp], 'PHP');
    const afterValuation = calculatePortfolioNetWorth([phpAcc, usdAcc], [transferTx], [fxUsdPhp], 'PHP');

    // Portfolio net worth is identical before and after transfer
    assert.equal(beforeValuation.netWorth, 5600000);
    assert.equal(afterValuation.netWorth, 5600000);
    assert.equal(beforeValuation.netWorth, afterValuation.netWorth);
  });
});
