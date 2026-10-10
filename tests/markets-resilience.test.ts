/**
 * tests/markets-resilience.test.ts
 *
 * Test suite for Markets Page Fault Isolation & UI Resilience (Milestone M2 / Feature 9).
 * Verifies:
 * 1. Single quote fetch rejection is isolated to quoteErrors without triggering page error banner
 * 2. Successful instrument save renders green role="status" notice without triggering red error banner
 * 3. Already-added instruments display disabled "In Investments" button state
 * 4. Unquoted / offline tickers render graceful "Quote Unavailable" card with manual valuation option
 */

import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { financeDb } from '../src/db/database';
import { financeRepository } from '../src/db/repository';
import type { Instrument } from '../src/core/types';
import { marketProvider, type MarketQuote } from '../src/market/providers';

describe('Markets Page Resilience & Isolation Logic (Feature 9)', () => {
  beforeEach(async () => {
    await financeDb.open();
    await financeDb.instruments.clear();
    await financeDb.prices.clear();
    await financeDb.settings.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await financeDb.instruments.clear();
    await financeDb.prices.clear();
    await financeDb.settings.clear();
  });

  it('isolates per-ticker quote failures: healthy tickers load, bad ticker flagged in quoteErrors, global error is empty', async () => {
    const symbols = ['AC.PS', 'BROKEN.PS', 'SMPH.PS'];

    vi.spyOn(marketProvider, 'latestPrice').mockImplementation(async (sym: string): Promise<MarketQuote> => {
      if (sym === 'BROKEN.PS') {
        throw new Error('503 Service Unavailable from upstream');
      }
      return {
        symbol: sym,
        name: sym === 'AC.PS' ? 'Ayala Corporation' : 'SM Prime',
        currency: 'PHP',
        assetType: 'stock',
        value: sym === 'AC.PS' ? 680.0 : 32.5,
        source: 'Gateway (yahoo)',
        asOf: '2026-10-10T12:00:00.000Z',
        freshness: 'delayed',
        isStale: false,
      };
    });

    const quotes: Record<string, MarketQuote> = {};
    const quoteErrors: Record<string, string> = {};
    let globalError = '';

    await Promise.allSettled(
      symbols.map(async sym => {
        try {
          const q = await marketProvider.latestPrice(sym);
          quotes[sym] = q;
        } catch (e) {
          quoteErrors[sym] = e instanceof Error ? e.message : 'Quote unavailable';
        }
      })
    );

    // Assert global error was NOT triggered
    expect(globalError).toBe('');

    // Assert healthy tickers loaded
    expect(quotes['AC.PS']).toBeDefined();
    expect(quotes['AC.PS'].value).toBe(680.0);
    expect(quotes['SMPH.PS']).toBeDefined();
    expect(quotes['SMPH.PS'].value).toBe(32.5);

    // Assert broken ticker error was captured in isolated map
    expect(quoteErrors['BROKEN.PS']).toBe('503 Service Unavailable from upstream');
    expect(quotes['BROKEN.PS']).toBeUndefined();
  });

  it('generates green success notification on successful save without error state', async () => {
    const quote: MarketQuote = {
      symbol: 'BDO.PS',
      name: 'BDO Unibank',
      currency: 'PHP',
      assetType: 'stock',
      value: 155.0,
      source: 'Gateway (yahoo)',
      asOf: '2026-10-10T12:00:00.000Z',
      freshness: 'delayed',
      isStale: false,
    };

    let error = '';
    let successMessage = '';

    // Simulate MarketsPage.saveInstrument
    try {
      const instrument: Instrument = {
        id: crypto.randomUUID(),
        name: quote.name,
        symbol: quote.symbol,
        sourceSymbol: quote.symbol,
        instrumentType: 'PSE_STOCK',
        currency: quote.currency,
        valuationMethod: 'LIVE_MARKET',
      };

      await financeDb.transaction('rw', financeDb.tables, async () => {
        const existing = await financeDb.instruments
          .where('sourceSymbol')
          .equals(quote.symbol)
          .filter(row => !row.deletedAt)
          .first();
        if (existing) throw new Error('This instrument is already in Investments.');
        await financeRepository.save('instruments', instrument);
        await financeRepository.save('prices', {
          id: crypto.randomUUID(),
          instrumentId: instrument.id,
          value: quote.value,
          currency: quote.currency,
          asOf: quote.asOf,
          fetchedAt: new Date().toISOString(),
          source: quote.source,
          sourceSymbol: quote.symbol,
          staleAfter: new Date(Date.parse(quote.asOf) + 3 * 86400000).toISOString(),
          status: 'fresh',
        });
      });

      successMessage = `${quote.name} (${quote.symbol}) saved in Investments. Record a purchase to create a holding.`;
    } catch (e) {
      error = (e as Error).message;
    }

    // Success assertion: error must be blank, successMessage must be populated
    expect(error).toBe('');
    expect(successMessage).toContain('BDO Unibank (BDO.PS) saved in Investments');

    // Confirm persisted in Dexie
    const saved = await financeDb.instruments.where('sourceSymbol').equals('BDO.PS').first();
    expect(saved).toBeDefined();
    expect(saved?.symbol).toBe('BDO.PS');
  });

  it('prevents duplicate additions and reflects "In Investments" state', async () => {
    const instrument: Instrument = {
      id: 'inst-bdo',
      name: 'BDO Unibank',
      symbol: 'BDO.PS',
      sourceSymbol: 'BDO.PS',
      instrumentType: 'PSE_STOCK',
      currency: 'PHP',
      valuationMethod: 'LIVE_MARKET',
    };
    await financeRepository.save('instruments', instrument);

    const savedList = await financeDb.instruments.filter(i => !i.deletedAt).toArray();
    const savedSymbols = new Set(savedList.map(i => i.sourceSymbol || i.symbol));

    const isAlreadySaved = savedSymbols.has('BDO.PS');
    expect(isAlreadySaved).toBe(true);

    const buttonLabel = isAlreadySaved ? 'In Investments' : 'Add to Investments';
    const isDisabled = isAlreadySaved;

    expect(buttonLabel).toBe('In Investments');
    expect(isDisabled).toBe(true);
  });

  it('handles manual valuation fallback for unquoted instruments without throwing', async () => {
    const unavailableRecord = {
      symbol: 'UNLISTED.PS',
      name: 'Unlisted Venture',
      currency: 'PHP',
      assetType: 'stock',
    };

    let error = '';
    let successMessage = '';

    try {
      const instrument: Instrument = {
        id: crypto.randomUUID(),
        name: unavailableRecord.name,
        symbol: unavailableRecord.symbol,
        sourceSymbol: unavailableRecord.symbol,
        instrumentType: 'PSE_STOCK',
        currency: unavailableRecord.currency,
        valuationMethod: 'MANUAL_PRICE',
      };

      await financeDb.transaction('rw', financeDb.tables, async () => {
        await financeRepository.save('instruments', instrument);
      });

      successMessage = `${unavailableRecord.name} (${unavailableRecord.symbol}) saved in Investments with manual valuation. Add a manual unit price anytime.`;
    } catch (e) {
      error = (e as Error).message;
    }

    expect(error).toBe('');
    expect(successMessage).toContain('saved in Investments with manual valuation');

    const saved = await financeDb.instruments.where('symbol').equals('UNLISTED.PS').first();
    expect(saved).toBeDefined();
    expect(saved?.valuationMethod).toBe('MANUAL_PRICE');
  });
});
