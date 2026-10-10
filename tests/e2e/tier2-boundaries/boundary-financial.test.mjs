/**
 * boundary-financial.test.mjs
 * Tier 2: Boundary & Corner Cases — Requirement R2 Financial Integrity
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinor,
  fromMinor,
  getCurrencyScale,
  getFxRate,
  convertMoney,
  buildLedger,
  calculatePortfolioNetWorth,
  calculateCashFlow
} from '../helpers/financial-engine.mjs';

describe('Tier 2: Boundary & Corner Cases — Financial Integrity', () => {
  it('T2.FIN.1: Handles safe integer boundaries near Number.MAX_SAFE_INTEGER', () => {
    // 90 trillion PHP centavos: 90,000,000,000,000.00
    const hugeMinor = 9000000000000000;
    assert.ok(Number.isSafeInteger(hugeMinor));

    const converted = fromMinor(hugeMinor, 'PHP');
    assert.equal(converted, 90000000000000);
    assert.equal(toMinor(converted, 'PHP'), hugeMinor);

    // Minor unit exceeding MAX_SAFE_INTEGER must be rejected
    assert.throws(() => {
      toMinor(1e16, 'PHP');
    }, /exceeds safe integer range/i);
  });

  it('T2.FIN.2: Handles zero-amount transactions and zero-balance accounts gracefully', () => {
    const zeroAccount = {
      id: 'acc_zero',
      name: 'Zero Balance Wallet',
      currency: 'PHP',
      includeInNetWorth: true,
      openingBalances: { PHP: 0, USD: 0 }
    };

    const zeroTx = {
      id: 'tx_zero',
      type: 'INCOME',
      date: '2026-10-01',
      accountId: 'acc_zero',
      currency: 'PHP',
      amount: 0
    };

    const ledger = buildLedger([zeroAccount], [zeroTx]);
    assert.equal(ledger.acc_zero.PHP, 0);
    assert.equal(ledger.acc_zero.USD, 0);

    const summary = calculatePortfolioNetWorth([zeroAccount], [zeroTx], [], 'PHP');
    assert.equal(summary.netWorth, 0);
    assert.equal(summary.complete, true);
  });

  it('T2.FIN.3: Handles asymmetric currency decimal scales (JPY 0 decimals, KWD 3 decimals, BTC 8 decimals)', () => {
    // JPY (0 decimals, scale 1)
    assert.equal(getCurrencyScale('JPY'), 1);
    assert.equal(toMinor(2500, 'JPY'), 2500);
    assert.equal(fromMinor(2500, 'JPY'), 2500);

    // KWD (3 decimals, scale 1000)
    assert.equal(getCurrencyScale('KWD'), 1000);
    assert.equal(toMinor(12.35, 'KWD'), 12350);
    assert.equal(fromMinor(12350, 'KWD'), 12.35);

    // BTC (8 decimals, scale 100,000,000)
    assert.equal(getCurrencyScale('BTC'), 100000000);
    assert.equal(toMinor(0.00000001, 'BTC'), 1); // 1 Satoshi
    assert.equal(fromMinor(1, 'BTC'), 0.00000001);
  });

  it('T2.FIN.4: Multiple same-day exchange rate updates resolve strictly to latest timestamp', () => {
    const rates = [
      { id: 'r1', fromCurrency: 'USD', toCurrency: 'PHP', rate: 56.10, asOf: '2026-10-09T08:00:00Z' },
      { id: 'r2', fromCurrency: 'USD', toCurrency: 'PHP', rate: 56.45, asOf: '2026-10-09T14:30:00Z' },
      { id: 'r3', fromCurrency: 'USD', toCurrency: 'PHP', rate: 56.25, asOf: '2026-10-09T11:00:00Z' }
    ];

    // As of 12:00:00Z, latest is r3 (56.25)
    const rateAtNoon = getFxRate('USD', 'PHP', rates, '2026-10-09T12:00:00Z');
    assert.equal(rateAtNoon, 56.25);

    // As of 18:00:00Z, latest is r2 (56.45)
    const rateAtEvening = getFxRate('USD', 'PHP', rates, '2026-10-09T18:00:00Z');
    assert.equal(rateAtEvening, 56.45);
  });

  it('T2.FIN.5: Negative net worth correctly calculates when liabilities exceed assets', () => {
    const debtAccount = {
      id: 'acc_credit_card',
      name: 'Credit Card Debt',
      currency: 'PHP',
      includeInNetWorth: true,
      openingBalances: { PHP: 0 }
    };

    // Major expense exceeding assets
    const expenseTx = {
      id: 'tx_big_debt',
      type: 'EXPENSE',
      date: '2026-10-01',
      accountId: 'acc_credit_card',
      currency: 'PHP',
      amount: 5000000 // PHP 50,000.00 debt
    };

    const summary = calculatePortfolioNetWorth([debtAccount], [expenseTx], [], 'PHP');
    assert.equal(summary.netWorth, -5000000);
    assert.equal(summary.knownNetWorth, -5000000);
    assert.equal(summary.complete, true);
  });

  it('T2.FIN.6: Cross-currency transfer with separated processing fee accurately records balances and cash flow', () => {
    const sourceAcc = { id: 'php_acc', currency: 'PHP', includeInNetWorth: true, openingBalances: { PHP: 1000000 } };
    const destAcc = { id: 'usd_acc', currency: 'USD', includeInNetWorth: true, openingBalances: { USD: 0 } };

    // Transfer PHP 5,600, destination receives USD 95 (fee USD 5 deducted at recipient)
    const transferWithFee = {
      id: 'tx_remit_fee',
      type: 'TRANSFER',
      date: '2026-10-02',
      accountId: 'php_acc',
      currency: 'PHP',
      amount: 560000,
      transferAccountId: 'usd_acc',
      transferCurrency: 'USD',
      transferAmount: 9500
    };

    const flow = calculateCashFlow([transferWithFee], [sourceAcc, destAcc]);
    assert.equal(flow.income, 0);
    assert.equal(flow.expenses, 0);
    assert.equal(flow.net, 0);

    const ledger = buildLedger([sourceAcc, destAcc], [transferWithFee]);
    assert.equal(ledger.php_acc.PHP, 440000); // 10,000 - 5,600 = 4,400 PHP
    assert.equal(ledger.usd_acc.USD, 9500);   // USD 95.00
  });
});
