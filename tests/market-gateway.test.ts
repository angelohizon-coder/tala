/**
 * tests/market-gateway.test.ts
 * Unit and Integration Test Suite for Tala Market Data Gateway Cloud Function (Milestone M3 / R3).
 *
 * Verifies:
 * 1. Strict CORS restriction and OPTIONS preflight handling
 * 2. Symbol parameter sanitization and injection rejection
 * 3. Standardized NormalizedMarketQuote schema compliance
 * 4. Multi-tier fallback hierarchy (Yahoo -> FCS -> Firestore Cache)
 * 5. STALE quote preservation and Critical Zero-Price Defense (NEVER return price: 0)
 * 6. Cache persistence safety rules (never cache zero or stale data)
 * 7. Batch symbol query processing
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ALLOWED_ORIGINS,
  isOriginAllowed,
  isValidSymbol,
  NormalizedMarketQuote,
  resolveMarketQuote,
  handleMarketQuoteRequest,
  saveCachedQuote,
  getCachedQuote,
  getMarketQuote
} from '../functions/src/index';

// In-memory mock Firestore database for deterministic cache testing
function createMockFirestore(initialData: Record<string, any> = {}) {
  const store = new Map<string, any>(Object.entries(initialData));

  return {
    collection: (collName: string) => {
      if (collName !== 'marketCache') {
        throw new Error(`Unexpected collection access: ${collName}`);
      }
      return {
        doc: (docId: string) => ({
          get: async () => ({
            exists: store.has(docId),
            data: () => store.get(docId)
          }),
          set: async (data: any) => {
            store.set(docId, data);
          }
        })
      };
    },
    _getStore: () => store
  };
}

// Mock HTTP Response builder for Express/Cloud Functions
function createMockResponse() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    ended: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    send(data: any) {
      res.body = data;
      res.ended = true;
      return res;
    },
    json(data: any) {
      res.body = data;
      res.ended = true;
      return res;
    },
    end() {
      res.ended = true;
      return res;
    }
  };
  return res;
}

describe('Market Data Gateway — CORS Policy Enforcement', () => {
  it('allows canonical GitHub Pages production origin', () => {
    expect(isOriginAllowed('https://angelohizon-coder.github.io')).toBe(true);
  });

  it('allows standard local development origins on ports 5173 and 5174', () => {
    expect(isOriginAllowed('http://localhost:5173')).toBe(true);
    expect(isOriginAllowed('http://localhost:5174')).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:5173')).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:5174')).toBe(true);
  });

  it('allows same-origin / server-to-server requests without Origin header', () => {
    expect(isOriginAllowed(undefined)).toBe(true);
    expect(isOriginAllowed(null)).toBe(true);
    expect(isOriginAllowed('')).toBe(true);
  });

  it('strictly rejects arbitrary or malicious origins with 403 Forbidden', async () => {
    const maliciousOrigins = [
      'https://malicious-site.com',
      'http://localhost:3000',
      'http://localhost:8080',
      'https://phishing-tala.com',
      'null'
    ];

    for (const origin of maliciousOrigins) {
      expect(isOriginAllowed(origin)).toBe(false);

      const req = {
        method: 'GET',
        headers: { origin },
        query: { symbol: 'BDO.PS' }
      };
      const res = createMockResponse();

      await handleMarketQuoteRequest(req, res);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'CORS origin not allowed' });
      expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    }
  });

  it('sets Access-Control-Allow-Origin header and handles OPTIONS preflight', async () => {
    const req = {
      method: 'OPTIONS',
      headers: { origin: 'https://angelohizon-coder.github.io' }
    };
    const res = createMockResponse();

    await handleMarketQuoteRequest(req, res);

    expect(res.statusCode).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://angelohizon-coder.github.io');
    expect(res.headers['Access-Control-Allow-Methods']).toContain('GET, POST, OPTIONS');
    expect(res.ended).toBe(true);
  });
});

describe('Market Data Gateway — Input Sanitization & Symbol Validation', () => {
  it('accepts valid ticker symbols of various formats', () => {
    const validSymbols = [
      'BDO.PS',
      'ALI.PS',
      'AAPL',
      'BRK.B',
      '0700.HK',
      'ALI-PA.PS',
      'BTC-USD',
      'SMC2K.PS'
    ];

    for (const sym of validSymbols) {
      expect(isValidSymbol(sym)).toBe(true);
    }
  });

  it('rejects path traversal, script injection, and SQL injection payloads with 400', async () => {
    const attackPayloads = [
      '../../etc/passwd',
      '<script>alert(1)</script>',
      'AAPL; DROP TABLE quotes;',
      'SYM/../../SECRET',
      'TOOLONGSYMBOLNAMETHATEXCEEDS15CHARS',
      '',
      '   '
    ];

    for (const payload of attackPayloads) {
      expect(isValidSymbol(payload)).toBe(false);

      const req = {
        method: 'GET',
        headers: { origin: 'http://localhost:5173' },
        query: { symbol: payload }
      };
      const res = createMockResponse();

      await handleMarketQuoteRequest(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid symbol parameter' });
    }
  });

  it('rejects missing symbol parameter with 400', async () => {
    const req = {
      method: 'GET',
      headers: { origin: 'http://localhost:5173' },
      query: {}
    };
    const res = createMockResponse();

    await handleMarketQuoteRequest(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid symbol parameter' });
  });
});

describe('Market Data Gateway — Standardized Schema & Multi-Tier Resolution', () => {
  it('Tier 1: Returns normalized quote from primary Yahoo Finance provider', async () => {
    const mockDb = createMockFirestore();

    const yahooFetcher = vi.fn().mockResolvedValue({
      symbol: 'BDO.PS',
      price: 154.50,
      currency: 'PHP',
      timestamp: 1728518400000,
      asOf: '2026-10-09T12:00:00.000Z',
      provider: 'yahoo',
      freshness: 'delayed',
      isStale: false,
      change: 2.50,
      changePercent: 1.64,
      name: 'BDO Unibank Inc',
      previousClose: 152.00,
      volume: 1250000
    } satisfies NormalizedMarketQuote);

    const fcsFetcher = vi.fn();

    const quote = await resolveMarketQuote('bdo.ps', {
      db: mockDb,
      yahooFetcher,
      fcsFetcher
    });

    expect(yahooFetcher).toHaveBeenCalledTimes(1);
    expect(fcsFetcher).not.toHaveBeenCalled();

    // Verify standardized schema
    expect(quote.symbol).toBe('BDO.PS');
    expect(quote.price).toBe(154.50);
    expect(quote.currency).toBe('PHP');
    expect(quote.provider).toBe('yahoo');
    expect(quote.freshness).toBe('delayed');
    expect(quote.isStale).toBe(false);
    expect(quote.change).toBe(2.50);
    expect(quote.changePercent).toBe(1.64);
    expect(typeof quote.timestamp).toBe('number');
    expect(typeof quote.asOf).toBe('string');

    // Verify quote was cached in Firestore
    const cached = mockDb._getStore().get('BDO.PS');
    expect(cached).toBeDefined();
    expect(cached.price).toBe(154.50);
    expect(cached.symbol).toBe('BDO.PS');
    expect(cached.cachedAt).toBeDefined();
  });

  it('Tier 2: Falls back to FCS API when Yahoo Finance fails', async () => {
    const mockDb = createMockFirestore();

    const yahooFetcher = vi.fn().mockRejectedValue(new Error('Yahoo rate limited (429)'));

    const fcsFetcher = vi.fn().mockResolvedValue({
      symbol: 'ALI.PS',
      price: 34.20,
      currency: 'PHP',
      timestamp: 1728518400000,
      asOf: '2026-10-09T12:00:00.000Z',
      provider: 'fcs',
      freshness: 'delayed',
      isStale: false,
      change: 0.70,
      changePercent: 2.09,
      name: 'Ayala Land Inc',
      previousClose: 33.50,
      volume: 3800000
    } satisfies NormalizedMarketQuote);

    const quote = await resolveMarketQuote('ALI.PS', {
      db: mockDb,
      yahooFetcher,
      fcsFetcher,
      fcsApiKey: 'test-fcs-key'
    });

    expect(yahooFetcher).toHaveBeenCalledTimes(1);
    expect(fcsFetcher).toHaveBeenCalledTimes(1);

    expect(quote.symbol).toBe('ALI.PS');
    expect(quote.price).toBe(34.20);
    expect(quote.provider).toBe('fcs');
    expect(quote.freshness).toBe('delayed');
    expect(quote.isStale).toBe(false);

    // Verify quote cached from fallback
    const cached = mockDb._getStore().get('ALI.PS');
    expect(cached).toBeDefined();
    expect(cached.price).toBe(34.20);
  });
});

describe('Market Data Gateway — STALE Cache Preservation & Critical Zero-Price Defense', () => {
  it('Tier 3: Serves STALE quote from Firestore cache when both external providers fail', async () => {
    const priorGoodQuote = {
      symbol: 'SMPH.PS',
      price: 32.50,
      currency: 'PHP',
      timestamp: Date.now() - 3600000,
      asOf: new Date(Date.now() - 3600000).toISOString(),
      provider: 'yahoo',
      freshness: 'delayed',
      isStale: false,
      change: 0.50,
      changePercent: 1.56,
      name: 'SM Prime Holdings',
      previousClose: 32.00,
      volume: 500000,
      cachedAt: new Date(Date.now() - 3600000).toISOString()
    };

    const mockDb = createMockFirestore({
      'SMPH.PS': priorGoodQuote
    });

    const yahooFetcher = vi.fn().mockRejectedValue(new Error('Yahoo network timeout'));
    const fcsFetcher = vi.fn().mockRejectedValue(new Error('FCS API service unavailable'));

    const quote = await resolveMarketQuote('SMPH.PS', {
      db: mockDb,
      yahooFetcher,
      fcsFetcher
    });

    expect(yahooFetcher).toHaveBeenCalledTimes(1);
    expect(fcsFetcher).toHaveBeenCalledTimes(1);

    // Critical STALE assertions
    expect(quote.symbol).toBe('SMPH.PS');
    expect(quote.price).toBe(32.50);
    expect(quote.provider).toBe('cache');
    expect(quote.freshness).toBe('stale');
    expect(quote.isStale).toBe(true);
    expect(quote.staleReason).toMatch(/preserved last valid quote/i);
    expect(quote.price).toBeGreaterThan(0);
  });

  it('CRITICAL ZERO-PRICE DEFENSE: Never returns price: 0 or coerces failed quote to zero', async () => {
    const priorValidQuote = {
      symbol: 'BPI.PS',
      price: 118.00,
      currency: 'PHP',
      timestamp: Date.now() - 7200000,
      asOf: new Date(Date.now() - 7200000).toISOString(),
      provider: 'yahoo',
      freshness: 'delayed',
      isStale: false,
      cachedAt: new Date(Date.now() - 7200000).toISOString()
    };

    const mockDb = createMockFirestore({
      'BPI.PS': priorValidQuote
    });

    const yahooFetcher = vi.fn().mockRejectedValue(new Error('DNS resolution failed'));
    const fcsFetcher = vi.fn().mockRejectedValue(new Error('500 Internal Server Error'));

    const req = {
      method: 'GET',
      headers: { origin: 'http://localhost:5173' },
      query: { symbol: 'BPI.PS' }
    };
    const res = createMockResponse();

    await handleMarketQuoteRequest(req, res, {
      db: mockDb,
      yahooFetcher,
      fcsFetcher
    });

    expect(res.statusCode).toBe(200);
    const returnedQuote: NormalizedMarketQuote = res.body;

    // Price must strictly be positive and NEVER zero
    expect(returnedQuote.price).not.toBe(0);
    expect(returnedQuote.price).toBe(118.00);
    expect(returnedQuote.isStale).toBe(true);
    expect(returnedQuote.freshness).toBe('stale');
  });

  it('Complete outage without prior cache returns 503 error, NEVER a zero-price quote', async () => {
    const emptyDb = createMockFirestore({});

    const yahooFetcher = vi.fn().mockRejectedValue(new Error('Yahoo API down'));
    const fcsFetcher = vi.fn().mockRejectedValue(new Error('FCS API down'));

    const req = {
      method: 'GET',
      headers: { origin: 'http://localhost:5173' },
      query: { symbol: 'UNKNOWN.PS' }
    };
    const res = createMockResponse();

    await handleMarketQuoteRequest(req, res, {
      db: emptyDb,
      yahooFetcher,
      fcsFetcher
    });

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/no prior valid quote recorded/i);
    // Crucial: body does NOT have price: 0
    expect(res.body.price).toBeUndefined();
  });

  it('Cache safety: Never saves quotes with zero/negative price or quotes already marked stale', async () => {
    const mockDb = createMockFirestore();

    const zeroQuote: NormalizedMarketQuote = {
      symbol: 'BAD1',
      price: 0,
      currency: 'PHP',
      timestamp: Date.now(),
      asOf: new Date().toISOString(),
      provider: 'yahoo',
      freshness: 'delayed',
      isStale: false
    };

    const negativeQuote: NormalizedMarketQuote = {
      symbol: 'BAD2',
      price: -50,
      currency: 'PHP',
      timestamp: Date.now(),
      asOf: new Date().toISOString(),
      provider: 'yahoo',
      freshness: 'delayed',
      isStale: false
    };

    const staleQuote: NormalizedMarketQuote = {
      symbol: 'BAD3',
      price: 100,
      currency: 'PHP',
      timestamp: Date.now(),
      asOf: new Date().toISOString(),
      provider: 'cache',
      freshness: 'stale',
      isStale: true
    };

    await saveCachedQuote(zeroQuote, mockDb);
    await saveCachedQuote(negativeQuote, mockDb);
    await saveCachedQuote(staleQuote, mockDb);

    expect(mockDb._getStore().size).toBe(0);
    expect(await getCachedQuote('BAD1', mockDb)).toBeNull();
    expect(await getCachedQuote('BAD2', mockDb)).toBeNull();
    expect(await getCachedQuote('BAD3', mockDb)).toBeNull();
  });
});

describe('Market Data Gateway — Batch Symbols & HTTP Handling', () => {
  it('handles batch symbols query param', async () => {
    const mockDb = createMockFirestore();

    const yahooFetcher = vi.fn().mockImplementation(async (sym: string) => ({
      symbol: sym,
      price: sym === 'AAPL' ? 225.50 : 154.00,
      currency: sym === 'AAPL' ? 'USD' : 'PHP',
      timestamp: Date.now(),
      asOf: new Date().toISOString(),
      provider: 'yahoo',
      freshness: 'delayed',
      isStale: false
    }));

    const req = {
      method: 'GET',
      headers: { origin: 'http://localhost:5173' },
      query: { symbols: 'AAPL,BDO.PS' }
    };
    const res = createMockResponse();

    await handleMarketQuoteRequest(req, res, {
      db: mockDb,
      yahooFetcher
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.quotes).toBeDefined();
    expect(res.body.quotes.length).toBe(2);
    expect(res.body.quotes[0].symbol).toBe('AAPL');
    expect(res.body.quotes[0].price).toBe(225.50);
    expect(res.body.quotes[1].symbol).toBe('BDO.PS');
    expect(res.body.quotes[1].price).toBe(154.00);
  });

  it('handles POST request with body parameter', async () => {
    const mockDb = createMockFirestore();

    const yahooFetcher = vi.fn().mockResolvedValue({
      symbol: 'MSFT',
      price: 430.25,
      currency: 'USD',
      timestamp: Date.now(),
      asOf: new Date().toISOString(),
      provider: 'yahoo',
      freshness: 'delayed',
      isStale: false
    });

    const req = {
      method: 'POST',
      headers: { origin: 'https://angelohizon-coder.github.io' },
      body: { symbol: 'MSFT' }
    };
    const res = createMockResponse();

    await handleMarketQuoteRequest(req, res, {
      db: mockDb,
      yahooFetcher
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.symbol).toBe('MSFT');
    expect(res.body.price).toBe(430.25);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://angelohizon-coder.github.io');
  });

  it('exports cloud function handler getMarketQuote', () => {
    expect(typeof getMarketQuote).toBe('function');
  });
});
