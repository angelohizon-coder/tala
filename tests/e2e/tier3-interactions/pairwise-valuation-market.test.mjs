/**
 * pairwise-valuation-market.test.mjs
 * Tier 3: Cross-Feature Interactions — Valuation Layer & Market Gateway Integration
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinor,
  fromMinor,
  getFxRate,
  convertMoney,
  calculatePortfolioNetWorth
} from '../helpers/financial-engine.mjs';

describe('Tier 3: Pairwise Interaction — Valuation & Market Gateway', () => {
  const fxUsdPhp = {
    id: 'fx-usd-php',
    fromCurrency: 'USD',
    toCurrency: 'PHP',
    rate: 56.0,
    asOf: '2026-10-09T00:00:00Z'
  };

  it('T3.PAIR.4: Live market quote for US ETF converts through dated FX into base PHP net worth', () => {
    // 10 units of VOO ETF @ $450.00 USD
    const liveMarketQuote = {
      symbol: 'VOO',
      price: 450.00,
      currency: 'USD',
      asOf: '2026-10-09T08:00:00Z',
      isStale: false
    };

    const holdingUnits = 10;
    const valueUsdMajor = holdingUnits * liveMarketQuote.price; // $4,500.00
    const valueUsdMinor = toMinor(valueUsdMajor, 'USD'); // 450,000 cents

    // Investment brokerage account holding USD cash + VOO ETF
    const brokerageAccount = {
      id: 'acc_schwab',
      name: 'Charles Schwab US Portfolio',
      currency: 'PHP',
      includeInNetWorth: true,
      openingBalances: {
        USD: valueUsdMinor
      }
    };

    const summary = calculatePortfolioNetWorth([brokerageAccount], [], [fxUsdPhp], 'PHP');

    // Expected PHP value: $4,500 * 56.0 = PHP 252,000.00 (25,200,000 centavos)
    assert.equal(summary.netWorth, 25200000);
    assert.equal(summary.complete, true);
  });

  it('T3.PAIR.5: Market Gateway STALE quote preservation prevents investment value from collapsing to zero', () => {
    // Upstream market API failure triggers STALE quote preservation
    const staleQuote = {
      symbol: 'SM',
      price: 920.00, // Preserved last valid price
      currency: 'PHP',
      asOf: '2026-10-08T08:00:00Z',
      isStale: true
    };

    const holdingUnits = 100; // 100 shares of SM
    const valuePhpMajor = holdingUnits * staleQuote.price; // PHP 92,000.00
    const valuePhpMinor = toMinor(valuePhpMajor, 'PHP'); // 9,200,000 centavos

    const equityAccount = {
      id: 'acc_pse',
      name: 'BDO Securities PSE',
      currency: 'PHP',
      includeInNetWorth: true,
      openingBalances: {
        PHP: valuePhpMinor
      }
    };

    const summary = calculatePortfolioNetWorth([equityAccount], [], [], 'PHP');

    // Value is preserved at PHP 92,000 without collapsing to 0
    assert.equal(summary.netWorth, 9200000);
    assert.notEqual(summary.netWorth, 0);
  });

  it('T3.PAIR.6: Missing FX rate invalidates portfolio completeness even if live market quotes are fresh', () => {
    // Live quote for US stock
    const freshUsdPrice = 180.00;
    const valueUsdMinor = toMinor(freshUsdPrice * 5, 'USD'); // 5 shares @ $180 = $900.00 = 90,000 cents

    const usAccount = {
      id: 'acc_ibkr',
      name: 'Interactive Brokers USD',
      currency: 'PHP',
      includeInNetWorth: true,
      openingBalances: { USD: valueUsdMinor }
    };

    // No USD->PHP FX rate available (rates = [])
    const summary = calculatePortfolioNetWorth([usAccount], [], [], 'PHP');

    assert.equal(summary.netWorth, null, 'Net worth must be null when FX is missing');
    assert.equal(summary.complete, false);
    assert.equal(summary.knownNetWorth, 0);
  });
});
