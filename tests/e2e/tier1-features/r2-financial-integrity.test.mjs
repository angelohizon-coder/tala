/**
 * r2-financial-integrity.test.mjs
 * Tier 1: Feature Coverage — Requirement R2 (Multi-Currency & Financial Integrity)
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinor,
  fromMinor,
  getFxRate,
  convertMoney,
  buildLedger,
  calculatePortfolioNetWorth,
  calculateCashFlow
} from '../helpers/financial-engine.mjs';
import { assertMinorEqual } from '../helpers/assertions.mjs';

describe('Tier 1: R2 Multi-Currency & Financial Integrity', () => {
  const fxUsdPhp = {
    id: 'fx-usd-php',
    fromCurrency: 'USD',
    toCurrency: 'PHP',
    rate: 56.0,
    asOf: '2026-01-01T00:00:00Z',
    source: 'BSP Reference'
  };

  it('T1.R2.1: Test account holding PHP 10,000 and USD 100 correctly converts to PHP 15,600 without double counting', () => {
    // PHP 10,000.00 = 1,000,000 centavos
    // USD 100.00 = 10,000 cents
    const multiAccount = {
      id: 'acc_multi_wallet',
      name: 'Global Multi-Currency Wallet',
      currency: 'PHP',
      includeInNetWorth: true,
      openingBalances: {
        PHP: 1000000,
        USD: 10000
      }
    };

    const summary = calculatePortfolioNetWorth(
      [multiAccount],
      [],
      [fxUsdPhp],
      'PHP',
      '2026-10-09'
    );

    // 1. Verify sub-ledger balances preserved
    const accountVal = summary.accountValues[0];
    assert.deepEqual(accountVal.cashBalances, {
      PHP: 1000000,
      USD: 10000
    });

    // 2. Converted total:
    // PHP 10,000 (1,000,000 centavos) + USD 100 @ 56 (560,000 centavos) = 1,560,000 centavos (PHP 15,600.00)
    assertMinorEqual(accountVal.baseValue, 1560000);
    assertMinorEqual(summary.netWorth, 1560000);
    assertMinorEqual(summary.assets, 1560000);
    assert.equal(summary.complete, true);
    assert.deepEqual(summary.issues, []);
  });

  it('T1.R2.2: Sub-ledgers model accounts with multiple fiat currencies (PHP, USD, EUR) simultaneously', () => {
    const multiAccount = {
      id: 'wise_global',
      name: 'Wise Multi-Currency Account',
      currency: 'PHP',
      includeInNetWorth: true,
      openingBalances: {
        PHP: 5000000, // PHP 50,000.00
        USD: 200000,  // USD 2,000.00
        EUR: 100000   // EUR 1,000.00
      }
    };

    const ledger = buildLedger([multiAccount], []);
    assert.equal(ledger.wise_global.PHP, 5000000);
    assert.equal(ledger.wise_global.USD, 200000);
    assert.equal(ledger.wise_global.EUR, 100000);
  });

  it('T1.R2.3: Cash amounts stored and calculated as integer minor units eliminate floating-point errors', () => {
    // In IEEE 754 float: 0.1 + 0.2 === 0.30000000000000004
    // In integer minor units (cents): 10 + 20 === 30
    const val1 = toMinor(0.1, 'USD'); // 10 cents
    const val2 = toMinor(0.2, 'USD'); // 20 cents
    const sum = val1 + val2;

    assert.equal(sum, 30);
    assert.equal(fromMinor(sum, 'USD'), 0.3);
    assert.equal(Number.isInteger(sum), true);
  });

  it('T1.R2.4: Cross-currency transfers reflect zero generated income or expense', () => {
    const sourceAccount = {
      id: 'bdo_php',
      name: 'BDO Checking',
      currency: 'PHP',
      includeInNetWorth: true,
      openingBalances: { PHP: 10000000 } // PHP 100,000.00
    };

    const destAccount = {
      id: 'wise_usd',
      name: 'Wise USD',
      currency: 'USD',
      includeInNetWorth: true,
      openingBalances: { USD: 0 }
    };

    // Remittance: Send PHP 56,000 to receive USD 1,000
    const transferTx = {
      id: 'tx_remit_1',
      type: 'TRANSFER',
      date: '2026-10-05',
      accountId: 'bdo_php',
      currency: 'PHP',
      amount: 5600000, // 56,000.00 PHP in centavos
      transferAccountId: 'wise_usd',
      transferCurrency: 'USD',
      transferAmount: 100000 // 1,000.00 USD in cents
    };

    const flow = calculateCashFlow([transferTx], [sourceAccount, destAccount]);

    assert.equal(flow.income, 0, 'Cross-currency transfer must not generate income');
    assert.equal(flow.expenses, 0, 'Cross-currency transfer must not generate expense');
    assert.equal(flow.net, 0, 'Cross-currency transfer must produce zero net cash flow change');

    // Verify sub-ledger balance updates
    const ledger = buildLedger([sourceAccount, destAccount], [transferTx]);
    assert.equal(ledger.bdo_php.PHP, 4400000); // 100,000 - 56,000 = 44,000 PHP
    assert.equal(ledger.wise_usd.USD, 100000);  // 0 + 1,000 = 1,000 USD
  });

  it('T1.R2.5: Removing an exchange rate excludes foreign balance from aggregated net worth instead of 1:1 fallback', () => {
    const multiAccount = {
      id: 'acc_foreign',
      name: 'Expat Wallet',
      currency: 'PHP',
      includeInNetWorth: true,
      openingBalances: {
        PHP: 1000000, // PHP 10,000.00 (1,000,000 centavos)
        USD: 10000    // USD 100.00 (10,000 cents)
      }
    };

    // No FX rates provided (simulating removed/missing rate)
    const summary = calculatePortfolioNetWorth([multiAccount], [], [], 'PHP', '2026-10-09');

    // Completeness invalidation
    assert.equal(summary.netWorth, null, 'Net worth must be null when foreign rate is missing');
    assert.equal(summary.assets, null);
    assert.equal(summary.complete, false);

    // Known net worth contains STRICTLY the known convertible PHP balance (PHP 10,000 = 1,000,000 centavos)
    // It must NOT fallback to 1:1 (which would be 1,010,000 centavos)
    assert.equal(summary.knownNetWorth, 1000000);
    assert.notEqual(summary.knownNetWorth, 1010000, 'Must never treat USD 100 as PHP 100 (1:1 fallback)');

    // Issue recorded
    assert.deepEqual(summary.issues, [
      { code: 'missing_fx', accountId: 'acc_foreign', currency: 'USD' }
    ]);
  });

  it('T1.R2.6: Historical dated exchange rate resolution does not leak future rates into past dates', () => {
    const historicalRates = [
      { id: 'rate_old', fromCurrency: 'USD', toCurrency: 'PHP', rate: 50.0, asOf: '2025-01-01T00:00:00Z' },
      { id: 'rate_mid', fromCurrency: 'USD', toCurrency: 'PHP', rate: 55.0, asOf: '2025-06-01T00:00:00Z' },
      { id: 'rate_new', fromCurrency: 'USD', toCurrency: 'PHP', rate: 60.0, asOf: '2025-12-01T00:00:00Z' }
    ];

    // On 2025-03-01: only rate_old (50.0) is visible
    assert.equal(getFxRate('USD', 'PHP', historicalRates, '2025-03-01T00:00:00Z'), 50.0);

    // On 2025-08-01: rate_mid (55.0) is visible
    assert.equal(getFxRate('USD', 'PHP', historicalRates, '2025-08-01T00:00:00Z'), 55.0);

    // On 2026-01-01: rate_new (60.0) is visible
    assert.equal(getFxRate('USD', 'PHP', historicalRates, '2026-01-01T00:00:00Z'), 60.0);
  });
});
