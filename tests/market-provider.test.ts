/**
 * tests/market-provider.test.ts
 *
 * Test suite for Market Quote Property Mapping, Normalization & Dexie Stale Cache Fallback (Milestone M2 / R2).
 * Verifies:
 * 1. normalizeQuote schema mapping { price, provider } -> { value, source }
 * 2. Critical Zero-Price Defense & validation
 * 3. Dexie IndexedDB stale price fallback via getStalePriceFromDb
 * 4. marketProvider.latestPrice live fetching, suffix matching, and offline fallback
 * 5. refreshInstrumentPrice persistence into Dexie
 */

import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { financeDb } from '../src/db/database';
import { financeRepository } from '../src/db/repository';
import type { Instrument, Price } from '../src/core/types';
import {
  normalizeQuote,
  getStalePriceFromDb,
  marketProvider,
  refreshInstrumentPrice,
  type MarketQuote,
} from '../src/market/providers';

describe('Market Quote Normalization & Stale Cache Fallback (R2)', () => {
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

  describe('1. normalizeQuote Schema Mapping & Defense', () => {
    it('maps gateway schema { price, provider } to client schema { value, source }', () => {
      const gatewayRaw = {
        symbol: 'BDO.PS',
        price: 155.0,
        currency: 'PHP',
        provider: 'yahoo',
        freshness: 'delayed',
        isStale: false,
        asOf: '2026-10-10T13:00:00.000Z',
        name: 'BDO Unibank, Inc.',
        change: 0.5,
        changePercent: 0.32,
      };

      const normalized = normalizeQuote(gatewayRaw);

      expect(normalized.symbol).toBe('BDO.PS');
      expect(normalized.value).toBe(155.0);
      expect(normalized.source).toBe('Gateway (yahoo)');
      expect(normalized.currency).toBe('PHP');
      expect(normalized.freshness).toBe('delayed');
      expect(normalized.isStale).toBe(false);
      expect(normalized.name).toBe('BDO Unibank, Inc.');
      expect(normalized.assetType).toBe('stock');
      expect(normalized.change).toBe(0.5);
      expect(normalized.changePercent).toBe(0.32);
    });

    it('maps gateway cache stale quotes properly with isStale: true and source notice', () => {
      const cacheRaw = {
        symbol: 'ALI.PS',
        price: 29.5,
        currency: 'PHP',
        provider: 'cache',
        freshness: 'stale',
        isStale: true,
        asOf: '2026-10-09T08:00:00.000Z',
      };

      const normalized = normalizeQuote(cacheRaw);

      expect(normalized.value).toBe(29.5);
      expect(normalized.source).toBe('Gateway Cache (Stale)');
      expect(normalized.freshness).toBe('stale');
      expect(normalized.isStale).toBe(true);
    });

    it('preserves native client schema { value, source } without alteration', () => {
      const clientRaw: MarketQuote = {
        symbol: 'US:AAPL',
        name: 'Apple Inc.',
        currency: 'USD',
        assetType: 'stock',
        value: 230.5,
        source: 'Crible daily mirror · yfinance',
        asOf: '2026-10-09',
        freshness: 'eod',
        changePercent: 1.096,
      };

      const normalized = normalizeQuote(clientRaw);

      expect(normalized.symbol).toBe('US:AAPL');
      expect(normalized.value).toBe(230.5);
      expect(normalized.source).toBe('Crible daily mirror · yfinance');
      expect(normalized.currency).toBe('USD');
      expect(normalized.asOf).toBe('2026-10-09');
      expect(normalized.freshness).toBe('eod');
    });

    it('enforces Critical Zero-Price Defense: rejects zero, negative, or NaN prices', () => {
      expect(() => normalizeQuote({ symbol: 'SMPH', price: 0 })).toThrow(/Invalid market price/);
      expect(() => normalizeQuote({ symbol: 'SMPH', price: -10 })).toThrow(/Invalid market price/);
      expect(() => normalizeQuote({ symbol: 'SMPH', price: NaN })).toThrow(/Invalid market price/);
      expect(() => normalizeQuote({ symbol: 'SMPH', value: 0 })).toThrow(/Invalid market price/);
      expect(() => normalizeQuote({ symbol: 'SMPH', value: -5 })).toThrow(/Invalid market price/);
    });

    it('enforces valid 3-letter uppercase ISO currency code', () => {
      expect(() => normalizeQuote({ symbol: 'BDO', price: 155, currency: 'TOOLONG' })).toThrow(/Invalid currency code/);
      expect(() => normalizeQuote({ symbol: 'BDO', price: 155, currency: '12' })).toThrow(/Invalid currency code/);
    });

    it('uses fallbackSymbol when raw quote omits symbol', () => {
      const rawWithoutSym = { price: 155, currency: 'PHP', provider: 'yahoo' };
      const normalized = normalizeQuote(rawWithoutSym, 'BDO');
      expect(normalized.symbol).toBe('BDO');
    });

    it('guards against clock skew in the future (> 5 min ahead)', () => {
      const futureDate = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const raw = { symbol: 'BDO', price: 155, asOf: futureDate };
      const normalized = normalizeQuote(raw);
      expect(Date.parse(normalized.asOf)).toBeLessThanOrEqual(Date.now() + 5000);
    });
  });

  describe('2. getStalePriceFromDb Dexie Fallback', () => {
    it('retrieves the most recent price from financeDb.prices for a symbol', async () => {
      const instrument: Instrument = {
        id: 'inst-bdo',
        name: 'BDO Unibank',
        symbol: 'BDO',
        sourceSymbol: 'BDO',
        instrumentType: 'PSE_STOCK',
        currency: 'PHP',
        valuationMethod: 'LIVE_MARKET',
      };
      await financeRepository.save('instruments', instrument);

      const oldPrice: Price = {
        id: 'p-old',
        instrumentId: 'inst-bdo',
        sourceSymbol: 'BDO',
        value: 150.0,
        currency: 'PHP',
        asOf: '2026-10-01T00:00:00Z',
        fetchedAt: '2026-10-01T00:00:00Z',
        source: 'Gateway (yahoo)',
        staleAfter: '2026-10-04T00:00:00Z',
        status: 'stale',
      };
      const recentPrice: Price = {
        id: 'p-recent',
        instrumentId: 'inst-bdo',
        sourceSymbol: 'BDO',
        value: 155.0,
        currency: 'PHP',
        asOf: '2026-10-08T00:00:00Z',
        fetchedAt: '2026-10-08T00:00:00Z',
        source: 'Gateway (yahoo)',
        staleAfter: '2026-10-11T00:00:00Z',
        status: 'fresh',
      };

      await financeRepository.save('prices', oldPrice);
      await financeRepository.save('prices', recentPrice);

      const stale = await getStalePriceFromDb('BDO');
      expect(stale).not.toBeNull();
      expect(stale?.value).toBe(155.0);
      expect(stale?.freshness).toBe('stale');
      expect(stale?.isStale).toBe(true);
      expect(stale?.source).toContain('(Stale cache)');
      expect(stale?.asOf).toBe('2026-10-08T00:00:00Z');
    });

    it('matches tickers across .PS suffix variations (e.g. BDO.PS matches query BDO)', async () => {
      const instrument: Instrument = {
        id: 'inst-ali',
        name: 'Ayala Land',
        symbol: 'ALI.PS',
        sourceSymbol: 'ALI.PS',
        instrumentType: 'PSE_STOCK',
        currency: 'PHP',
        valuationMethod: 'LIVE_MARKET',
      };
      await financeRepository.save('instruments', instrument);

      const price: Price = {
        id: 'p-ali',
        instrumentId: 'inst-ali',
        sourceSymbol: 'ALI.PS',
        value: 29.8,
        currency: 'PHP',
        asOf: '2026-10-08T00:00:00Z',
        fetchedAt: '2026-10-08T00:00:00Z',
        source: 'Gateway (yahoo)',
        staleAfter: '2026-10-11T00:00:00Z',
        status: 'fresh',
      };
      await financeRepository.save('prices', price);

      const stale = await getStalePriceFromDb('ALI');
      expect(stale).not.toBeNull();
      expect(stale?.value).toBe(29.8);
      expect(stale?.symbol).toBe('ALI.PS');
    });

    it('ignores soft-deleted price records', async () => {
      const instrument: Instrument = {
        id: 'inst-deleted',
        name: 'Deleted Test',
        symbol: 'DEL',
        sourceSymbol: 'DEL',
        instrumentType: 'PSE_STOCK',
        currency: 'PHP',
        valuationMethod: 'LIVE_MARKET',
      };
      await financeRepository.save('instruments', instrument);

      const price: Price = {
        id: 'p-del',
        instrumentId: 'inst-deleted',
        sourceSymbol: 'DEL',
        value: 100.0,
        currency: 'PHP',
        asOf: '2026-10-08T00:00:00Z',
        fetchedAt: '2026-10-08T00:00:00Z',
        source: 'Test',
        staleAfter: '2026-10-11T00:00:00Z',
        status: 'stale',
      };
      await financeRepository.save('prices', price);
      await financeRepository.remove('prices', 'p-del');

      const stale = await getStalePriceFromDb('DEL');
      expect(stale).toBeNull();
    });

    it('returns null when no matching price exists', async () => {
      const stale = await getStalePriceFromDb('NONEXISTENT');
      expect(stale).toBeNull();
    });
  });

  describe('3. marketProvider.latestPrice Live and Fallback Flow', () => {
    it('successfully processes gateway response with property mapping', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quotes: [
            {
              symbol: 'BDO.PS',
              price: 155.0,
              currency: 'PHP',
              provider: 'yahoo',
              freshness: 'delayed',
              isStale: false,
              asOf: '2026-10-10T13:00:00.000Z',
              name: 'BDO Unibank',
            },
          ],
        }),
      } as any);

      const quote = await marketProvider.latestPrice('BDO');
      expect(quote.value).toBe(155.0);
      expect(quote.source).toBe('Gateway (yahoo)');
      expect(quote.freshness).toBe('delayed');
      expect(quote.isStale).toBe(false);

      globalThis.fetch = originalFetch;
    });

    it('falls back to Dexie stale cache when gateway network throws', async () => {
      // Seed a cached price into Dexie
      const instrument: Instrument = {
        id: 'inst-bdo',
        name: 'BDO Unibank',
        symbol: 'BDO',
        sourceSymbol: 'BDO',
        instrumentType: 'PSE_STOCK',
        currency: 'PHP',
        valuationMethod: 'LIVE_MARKET',
      };
      await financeRepository.save('instruments', instrument);
      await financeRepository.save('prices', {
        id: 'p-bdo-stale',
        instrumentId: 'inst-bdo',
        sourceSymbol: 'BDO',
        value: 154.2,
        currency: 'PHP',
        asOf: '2026-10-07T00:00:00Z',
        fetchedAt: '2026-10-07T00:00:00Z',
        source: 'Gateway (yahoo)',
        staleAfter: '2026-10-10T00:00:00Z',
        status: 'fresh',
      });

      // Simulate network disruption
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Network offline or Gateway 503'));

      const quote = await marketProvider.latestPrice('BDO');
      expect(quote.value).toBe(154.2);
      expect(quote.freshness).toBe('stale');
      expect(quote.isStale).toBe(true);
      expect(quote.source).toContain('(Stale cache)');

      globalThis.fetch = originalFetch;
    });

    it('throws descriptive error when both gateway network and Dexie cache fail', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Network offline'));

      await expect(marketProvider.latestPrice('UNKNOWN')).rejects.toThrow(/Network offline|No recent verified quote/);

      globalThis.fetch = originalFetch;
    });
  });

  describe('4. refreshInstrumentPrice End-to-End Integration', () => {
    it('refreshes price, normalizes properties, and persists to Dexie', async () => {
      const instrument: Instrument = {
        id: 'inst-tel',
        name: 'PLDT Inc.',
        symbol: 'TEL',
        sourceSymbol: 'TEL',
        instrumentType: 'PSE_STOCK',
        currency: 'PHP',
        valuationMethod: 'LIVE_MARKET',
      };
      await financeRepository.save('instruments', instrument);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quotes: [
            {
              symbol: 'TEL.PS',
              price: 1340.0,
              currency: 'PHP',
              provider: 'yahoo',
              freshness: 'delayed',
              asOf: '2026-10-10T12:00:00.000Z',
              name: 'PLDT',
            },
          ],
        }),
      } as any);

      const savedPrice = await refreshInstrumentPrice(instrument);
      expect(savedPrice.value).toBe(1340.0);
      expect(savedPrice.source).toBe('Gateway (yahoo)');
      expect(savedPrice.instrumentId).toBe('inst-tel');

      // Verify stored in Dexie prices table
      const stored = await financeDb.prices.get(savedPrice.id);
      expect(stored).toBeDefined();
      expect(stored?.value).toBe(1340.0);

      globalThis.fetch = originalFetch;
    });
  });
});
