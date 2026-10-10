/**
 * scenario-onboarding-local.test.mjs
 * Tier 4: Real-World Application Scenario — Local-Only User Onboarding
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockNetworkGate } from '../helpers/mock-network.mjs';
import { calculatePortfolioNetWorth, buildLedger } from '../helpers/financial-engine.mjs';
import { assertMinorEqual } from '../helpers/assertions.mjs';

describe('Tier 4: Scenario — Local-Only Privacy Onboarding', () => {
  it('T4.SCEN.1: Executes complete local-only onboarding workflow with zero outbound network calls', async () => {
    // Step 1: Initialize local privacy mode
    const network = new MockNetworkGate('LOCAL_ONLY');
    assert.equal(network.getOutboundCount(), 0);

    // Step 2: Honest Empty State Check (no fake initial transactions)
    const initialAccounts = [];
    const initialTransactions = [];
    assert.equal(initialAccounts.length, 0);
    assert.equal(initialTransactions.length, 0);

    // Step 3: User adds their multi-currency account with PHP 10,000 and USD 100
    const userAccount = {
      id: 'acc_my_wallet',
      name: 'Primary Multi-Currency Account',
      currency: 'PHP',
      includeInNetWorth: true,
      openingBalances: {
        PHP: 1000000, // PHP 10,000.00 in centavos
        USD: 10000    // USD 100.00 in cents
      }
    };
    initialAccounts.push(userAccount);

    // Step 4: User configures dated exchange rate of PHP 56/USD
    const fxRate = {
      id: 'fx_user_entry',
      fromCurrency: 'USD',
      toCurrency: 'PHP',
      rate: 56.0,
      asOf: '2026-10-09T00:00:00Z',
      source: 'User Manual Entry'
    };

    // Step 5: Calculate portfolio valuation in PHP
    const summary = calculatePortfolioNetWorth(
      initialAccounts,
      initialTransactions,
      [fxRate],
      'PHP',
      '2026-10-09'
    );

    // Step 6: Verify exact financial integrity total (PHP 15,600 = 1,560,000 centavos)
    assertMinorEqual(summary.netWorth, 1560000);
    assertMinorEqual(summary.assets, 1560000);
    assert.equal(summary.complete, true);
    assert.deepEqual(summary.issues, []);

    // Step 7: Strict verification that zero outbound network calls were made
    assert.equal(network.getOutboundCount(), 0, 'Local-only onboarding must make zero outbound requests');
  });
});
