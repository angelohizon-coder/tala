/**
 * scenario-cross-currency-transfer.test.mjs
 * Tier 4: Real-World Application Scenario — Cross-Currency Transfer with Fees & Missing FX
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePortfolioNetWorth,
  calculateCashFlow,
  buildLedger
} from '../helpers/financial-engine.mjs';

describe('Tier 4: Scenario — Cross-Currency Transfer Lifecycle', () => {
  it('T4.SCEN.2: Executes cross-currency transfer with fee segregation and missing FX exclusion', () => {
    // 1. Initial State: BDO PHP Checking (PHP 100k) and Wise USD ($0)
    const phpAccount = {
      id: 'acc_bdo',
      name: 'BDO Checking',
      currency: 'PHP',
      includeInNetWorth: true,
      openingBalances: { PHP: 10000000 } // PHP 100,000.00
    };
    const usdAccount = {
      id: 'acc_wise',
      name: 'Wise USD',
      currency: 'USD',
      includeInNetWorth: true,
      openingBalances: { USD: 0 }
    };
    const accounts = [phpAccount, usdAccount];

    const fxRate = {
      id: 'fx_56',
      fromCurrency: 'USD',
      toCurrency: 'PHP',
      rate: 56.0,
      asOf: '2026-10-01T00:00:00Z'
    };

    // 2. Transfer: Sent PHP 56,000, Received USD 995 (USD 5 fee deducted)
    const transferTx = {
      id: 'tx_remittance_wise',
      type: 'TRANSFER',
      date: '2026-10-05',
      accountId: 'acc_bdo',
      currency: 'PHP',
      amount: 5600000, // PHP 56,000.00 in centavos
      transferAccountId: 'acc_wise',
      transferCurrency: 'USD',
      transferAmount: 99500 // USD 995.00 in cents
    };

    // 3. Cash flow verification: must generate ZERO income and ZERO expense
    const cashFlow = calculateCashFlow([transferTx], accounts);
    assert.equal(cashFlow.income, 0);
    assert.equal(cashFlow.expenses, 0);
    assert.equal(cashFlow.net, 0);

    // 4. Ledger balance updates
    const ledger = buildLedger(accounts, [transferTx]);
    assert.equal(ledger.acc_bdo.PHP, 4400000); // 100,000 - 56,000 = PHP 44,000
    assert.equal(ledger.acc_wise.USD, 99500);   // USD 995.00

    // 5. Valuation with FX:
    // PHP 44,000 + (USD 995 * 56.0 = PHP 55,720) = PHP 99,720.00 (9,972,000 centavos)
    const valuationWithFx = calculatePortfolioNetWorth(accounts, [transferTx], [fxRate], 'PHP');
    assert.equal(valuationWithFx.netWorth, 9972000);
    assert.equal(valuationWithFx.complete, true);

    // 6. Valuation when FX is removed:
    // Foreign USD balance is excluded from aggregated net worth (knownNetWorth = PHP 44,000)
    // Not 1:1 fallback (which would erroneously produce 44,000 + 995 = 44,995 PHP)
    const valuationWithoutFx = calculatePortfolioNetWorth(accounts, [transferTx], [], 'PHP');
    assert.equal(valuationWithoutFx.netWorth, null);
    assert.equal(valuationWithoutFx.complete, false);
    assert.equal(valuationWithoutFx.knownNetWorth, 4400000);
    assert.notEqual(valuationWithoutFx.knownNetWorth, 4499500);
  });
});
