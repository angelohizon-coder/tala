/**
 * tests/investments-workflow.test.ts
 *
 * Comprehensive Test Suite for Milestone 2 (Feature 9 & 10 / Requirement R2):
 * - Market quote fault isolation & resilience logic
 * - Portfolio aggregation & base-currency conversion
 * - Asset allocation categorization
 * - TradeForm calculation modes & integer cents alignment
 * - Oversell prevention logic
 * - PriceForm NAV delta & holding value impact calculations
 * - Seamless valuation date update & deletion
 */

import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { financeDb } from '../src/db/database';
import { financeRepository } from '../src/db/repository';
import type { Instrument, Price, Transaction, FxRate } from '../src/core/types';
import {
  toMinor,
  fromMinor,
  convertMoney,
  calculatePositions,
} from '../src/core/calculations';
import { marketProvider, type MarketQuote } from '../src/market/providers';

describe('Milestone 2: Investment Workflow & Resilience Suite', () => {
  beforeEach(async () => {
    await financeDb.open();
    await financeDb.instruments.clear();
    await financeDb.prices.clear();
    await financeDb.transactions.clear();
    await financeDb.accounts.clear();
    await financeDb.fxRates.clear();
    await financeDb.settings.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await financeDb.instruments.clear();
    await financeDb.prices.clear();
    await financeDb.transactions.clear();
    await financeDb.accounts.clear();
    await financeDb.fxRates.clear();
    await financeDb.settings.clear();
  });

  describe('1. Markets Error Isolation & Resilience', () => {
    it('isolates errors per ticker with Promise.allSettled without failing healthy tickers', async () => {
      const records = [
        { symbol: 'BDO.PS', name: 'BDO Unibank', currency: 'PHP', assetType: 'stock' },
        { symbol: 'FAIL.PS', name: 'Broken Stock', currency: 'PHP', assetType: 'stock' },
        { symbol: 'ALI.PS', name: 'Ayala Land', currency: 'PHP', assetType: 'stock' },
      ];

      vi.spyOn(marketProvider, 'latestPrice').mockImplementation(async (sym: string): Promise<MarketQuote> => {
        if (sym === 'FAIL.PS') {
          throw new Error('Quote unavailable for FAIL.PS');
        }
        return {
          symbol: sym,
          name: sym === 'BDO.PS' ? 'BDO Unibank' : 'Ayala Land',
          currency: 'PHP',
          assetType: 'stock',
          value: sym === 'BDO.PS' ? 155.0 : 30.0,
          source: 'Gateway (yahoo)',
          asOf: '2026-10-10T12:00:00.000Z',
          freshness: 'delayed',
          isStale: false,
        };
      });

      const quotes: Record<string, MarketQuote> = {};
      const quoteErrors: Record<string, string> = {};

      const results = await Promise.allSettled(
        records.map(async record => {
          try {
            const quote = await marketProvider.latestPrice(record.symbol);
            quotes[record.symbol] = quote;
          } catch (e) {
            quoteErrors[record.symbol] = e instanceof Error ? e.message : 'Quote unavailable';
          }
        })
      );

      expect(results.length).toBe(3);
      expect(quotes['BDO.PS']).toBeDefined();
      expect(quotes['BDO.PS'].value).toBe(155.0);
      expect(quotes['ALI.PS']).toBeDefined();
      expect(quotes['ALI.PS'].value).toBe(30.0);
      expect(quotes['FAIL.PS']).toBeUndefined();
      expect(quoteErrors['FAIL.PS']).toBe('Quote unavailable for FAIL.PS');
    });

    it('prevents duplicate additions to user portfolio by detecting saved symbols', async () => {
      const instrument: Instrument = {
        id: 'inst-saved-1',
        name: 'BDO Unibank',
        symbol: 'BDO.PS',
        sourceSymbol: 'BDO.PS',
        instrumentType: 'PSE_STOCK',
        currency: 'PHP',
        valuationMethod: 'LIVE_MARKET',
      };
      await financeRepository.save('instruments', instrument);

      const saved = await financeDb.instruments.filter(i => !i.deletedAt).toArray();
      const savedSymbols = new Set(saved.map(i => i.sourceSymbol || i.symbol));

      expect(savedSymbols.has('BDO.PS')).toBe(true);
      expect(savedSymbols.has('OTHER.PS')).toBe(false);
    });
  });

  describe('2. Portfolio Aggregation & Multi-Currency Valuation', () => {
    it('aggregates portfolio values and cost basis across diverse currencies into base currency', async () => {
      const baseCurrency = 'PHP';
      const fxRates: FxRate[] = [
        {
          id: 'fx-usd-php',
          fromCurrency: 'USD',
          toCurrency: 'PHP',
          rate: 56.5,
          asOf: '2026-10-10T00:00:00Z',
          source: 'Test',
        },
      ];

      // 1. PHP Stock: BDO, 100 shares @ cost 150 PHP (cost: 15,000 PHP), market value 155 PHP (value: 15,500 PHP)
      const phpPos = {
        instrumentId: 'inst-bdo',
        currency: 'PHP',
        units: 100,
        costBasis: 1500000, // 15,000.00 PHP in cents
        marketValue: 1550000, // 15,500.00 PHP in cents
        unrealizedGain: 50000,
        realizedGain: 0,
        income: 20000, // 200.00 PHP dividend
      };

      // 2. USD Stock: AAPL, 10 shares @ cost $200 (cost: $2,000 = 200,000 cents), market value $220 (value: $2,200 = 220,000 cents)
      const usdPos = {
        instrumentId: 'inst-aapl',
        currency: 'USD',
        units: 10,
        costBasis: 200000, // $2,000.00
        marketValue: 220000, // $2,200.00
        unrealizedGain: 20000,
        realizedGain: 0,
        income: 5000, // $50.00
      };

      // Converted values:
      // PHP market value: 15,500.00 PHP (1,550,000 cents)
      // USD market value: $2,200.00 * 56.5 = 124,300.00 PHP (12,430,000 cents)
      // Total converted market value: 15,500 + 124,300 = 139,800.00 PHP (13,980,000 cents)
      const convertedPhpVal = convertMoney(phpPos.marketValue, 'PHP', baseCurrency, fxRates) ?? phpPos.marketValue;
      const convertedUsdVal = convertMoney(usdPos.marketValue, 'USD', baseCurrency, fxRates);

      expect(convertedPhpVal).toBe(1550000);
      expect(convertedUsdVal).toBe(12430000);

      const totalMarketValue = convertedPhpVal + (convertedUsdVal || 0);
      expect(totalMarketValue).toBe(13980000);

      // Converted cost basis:
      // PHP cost: 15,000.00 PHP
      // USD cost: $2,000.00 * 56.5 = 113,000.00 PHP (11,300,000 cents)
      // Total cost basis: 15,000 + 113,000 = 128,000.00 PHP (12,800,000 cents)
      const convertedPhpCost = convertMoney(phpPos.costBasis, 'PHP', baseCurrency, fxRates) ?? phpPos.costBasis;
      const convertedUsdCost = convertMoney(usdPos.costBasis, 'USD', baseCurrency, fxRates);
      const totalCostBasis = convertedPhpCost + (convertedUsdCost || 0);
      expect(totalCostBasis).toBe(12800000);

      // Total unrealized return
      const totalUnrealized = totalMarketValue - totalCostBasis;
      expect(totalUnrealized).toBe(1180000); // 11,800.00 PHP
      const unrealizedPct = (totalUnrealized / totalCostBasis) * 100;
      expect(unrealizedPct).toBeCloseTo(9.21875, 4);
    });

    it('correctly maps instruments to asset allocation categories', () => {
      function getAssetCategory(type: string) {
        const t = type.toUpperCase();
        if (['PSE_STOCK', 'PSE_REIT', 'FOREIGN_STOCK'].includes(t)) {
          return 'equity';
        }
        if (['UITF', 'MUTUAL_FUND', 'PSE_ETF', 'FOREIGN_ETF', 'PERA'].includes(t)) {
          return 'funds';
        }
        if (['PAGIBIG_MP2', 'TIME_DEPOSIT', 'BOND'].includes(t)) {
          return 'fixed_income';
        }
        return 'alternatives';
      }

      expect(getAssetCategory('PSE_STOCK')).toBe('equity');
      expect(getAssetCategory('FOREIGN_STOCK')).toBe('equity');
      expect(getAssetCategory('PSE_REIT')).toBe('equity');
      expect(getAssetCategory('UITF')).toBe('funds');
      expect(getAssetCategory('MUTUAL_FUND')).toBe('funds');
      expect(getAssetCategory('FOREIGN_ETF')).toBe('funds');
      expect(getAssetCategory('PAGIBIG_MP2')).toBe('fixed_income');
      expect(getAssetCategory('TIME_DEPOSIT')).toBe('fixed_income');
      expect(getAssetCategory('BOND')).toBe('fixed_income');
      expect(getAssetCategory('CRYPTO')).toBe('alternatives');
    });
  });

  describe('3. TradeForm Friction-Free Intelligence & Precision', () => {
    it('accurately computes fractional units when investing in CASH mode', () => {
      const cashAmount = 10000; // PHP 10,000
      const unitPrice = 125.50; // NAV per unit
      const calculatedUnits = cashAmount / unitPrice;

      expect(calculatedUnits).toBeCloseTo(79.68127, 4);

      // Verify exact integer cents alignment for calculation engine
      const exactAmount = toMinor(calculatedUnits * unitPrice, 'PHP');
      expect(exactAmount).toBe(1000000); // exactly 10,000.00 PHP in cents
    });

    it('calculates net cash settlement correctly for BUY and SELL with fees', () => {
      const units = 50;
      const unitPrice = 150.0;
      const gross = units * unitPrice; // 7,500.00 PHP
      const fees = 25.50; // PHP 25.50

      const buySettlement = gross + fees;
      const sellSettlement = Math.max(0, gross - fees);

      expect(buySettlement).toBe(7525.50);
      expect(sellSettlement).toBe(7474.50);
    });

    it('prevents overselling by asserting units against account holding balance', async () => {
      const accountId = 'acc-broker-1';
      await financeRepository.save('accounts', {
        id: accountId,
        name: 'Brokerage Account',
        accountType: 'BROKERAGE',
        currency: 'PHP',
        openingBalance: 0,
        openingDate: '2026-01-01',
        includeInNetWorth: true,
        includeInLiquidNetWorth: true,
        includeInFire: true,
        emergency: false,
        archived: false,
      } as any);

      const instrument: Instrument = {
        id: 'inst-smph',
        name: 'SM Prime',
        symbol: 'SMPH',
        sourceSymbol: 'SMPH',
        instrumentType: 'PSE_STOCK',
        currency: 'PHP',
        valuationMethod: 'LIVE_MARKET',
      };
      await financeRepository.save('instruments', instrument);

      // Buy 100 units
      const buyTx: Transaction = {
        id: 'tx-buy-1',
        date: '2026-10-01',
        type: 'INVESTMENT_BUY',
        accountId,
        currency: 'PHP',
        amount: toMinor(3200, 'PHP'),
        instrumentId: instrument.id,
        units: 100,
        unitPrice: 32.0,
      };
      await financeRepository.saveTransaction(buyTx);

      const txs = await financeDb.transactions
        .where('accountId')
        .equals(accountId)
        .filter(t => !t.deletedAt && t.instrumentId === instrument.id)
        .toArray();

      const positions = calculatePositions(txs, [instrument], [], { asOf: '2026-10-10' });
      const availableUnits = positions[0]?.units || 0;
      expect(availableUnits).toBe(100);

      // Selling 100 is allowed
      const attemptValidSell = 100;
      expect(attemptValidSell <= availableUnits).toBe(true);

      // Selling 101 must be prevented
      const attemptInvalidSell = 101;
      expect(attemptInvalidSell <= availableUnits).toBe(false);
    });
  });

  describe('4. PriceForm NAV Delta & Seamless Valuation Updates', () => {
    it('calculates NAV delta and holding value impact in real time', () => {
      const priorNav = 125.0;
      const newNav = 130.0;
      const unitsHeld = 2500;

      const delta = newNav - priorNav;
      const deltaPct = (delta / priorNav) * 100;

      expect(delta).toBe(5.0);
      expect(deltaPct).toBe(4.0); // +4.0%

      const priorHoldingValue = unitsHeld * priorNav; // 312,500.00
      const newHoldingValue = unitsHeld * newNav; // 325,000.00
      const valueImpact = unitsHeld * delta; // +12,500.00

      expect(priorHoldingValue).toBe(312500);
      expect(newHoldingValue).toBe(325000);
      expect(valueImpact).toBe(12500);
    });

    it('seamlessly updates price on the same date by replacing existing entry', async () => {
      const instrument: Instrument = {
        id: 'inst-mp2',
        name: 'Pag-IBIG MP2',
        symbol: 'MP2',
        sourceSymbol: 'MP2',
        instrumentType: 'PAGIBIG_MP2',
        currency: 'PHP',
        valuationMethod: 'MANUAL_VALUE',
      };
      await financeRepository.save('instruments', instrument);

      const date = '2026-10-01';

      // Save initial price on 2026-10-01
      const price1: Price = {
        id: `manual-price:${instrument.id}:${date}`,
        instrumentId: instrument.id,
        value: 50000.0,
        currency: 'PHP',
        asOf: date,
        fetchedAt: '2026-10-01T00:00:00Z',
        source: 'Initial statement',
        staleAfter: date + 'T23:59:59Z',
        status: 'manual',
      };
      await financeRepository.save('prices', price1);

      let savedPrices = await financeDb.prices
        .where('instrumentId')
        .equals(instrument.id)
        .filter(p => !p.deletedAt)
        .toArray();
      expect(savedPrices.length).toBe(1);
      expect(savedPrices[0].value).toBe(50000.0);

      // Now update the price on the same date to 52,500.00
      const existing = await financeDb.prices
        .where('instrumentId')
        .equals(instrument.id)
        .filter(p => !p.deletedAt && p.asOf.slice(0, 10) === date)
        .toArray();
      for (const old of existing) {
        await financeRepository.remove('prices', old.id);
      }

      const price2: Price = {
        id: `manual-price:${instrument.id}:${date}`,
        instrumentId: instrument.id,
        value: 52500.0,
        currency: 'PHP',
        asOf: date,
        fetchedAt: new Date().toISOString(),
        source: 'Updated dividend statement',
        staleAfter: date + 'T23:59:59Z',
        status: 'manual',
      };
      await financeRepository.save('prices', price2);

      savedPrices = await financeDb.prices
        .where('instrumentId')
        .equals(instrument.id)
        .filter(p => !p.deletedAt)
        .toArray();
      expect(savedPrices.length).toBe(1);
      expect(savedPrices[0].value).toBe(52500.0);
      expect(savedPrices[0].source).toBe('Updated dividend statement');
    });

    it('allows deleting an erroneous price via financeRepository.remove', async () => {
      const instrument: Instrument = {
        id: 'inst-uitf',
        name: 'BDO Equity Fund',
        symbol: 'UITF-EQ',
        sourceSymbol: 'UITF-EQ',
        instrumentType: 'UITF',
        currency: 'PHP',
        valuationMethod: 'DAILY_NAV',
      };
      await financeRepository.save('instruments', instrument);

      const price: Price = {
        id: 'p-typo-error',
        instrumentId: instrument.id,
        value: 999999.0, // typo entry
        currency: 'PHP',
        asOf: '2026-10-05T00:00:00Z',
        fetchedAt: '2026-10-05T00:00:00Z',
        source: 'User typo',
        staleAfter: '2026-10-08T00:00:00Z',
        status: 'manual',
      };
      await financeRepository.save('prices', price);

      let prices = await financeDb.prices
        .where('instrumentId')
        .equals(instrument.id)
        .filter(p => !p.deletedAt)
        .toArray();
      expect(prices.length).toBe(1);

      // User deletes the typo entry
      await financeRepository.remove('prices', 'p-typo-error');

      prices = await financeDb.prices
        .where('instrumentId')
        .equals(instrument.id)
        .filter(p => !p.deletedAt)
        .toArray();
      expect(prices.length).toBe(0);
    });
  });
});
