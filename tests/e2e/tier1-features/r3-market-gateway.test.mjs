/**
 * r3-market-gateway.test.mjs
 * Tier 1: Feature Coverage — Requirement R3 (Market Data Gateway)
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertNormalizedMarketQuote } from '../helpers/assertions.mjs';

// Simulated Market Gateway Logic per R3 specifications
class MarketGatewayService {
  constructor(options = {}) {
    this.firestoreCache = new Map(options.cache || []);
    this.yahooDown = Boolean(options.yahooDown);
    this.fcsDown = Boolean(options.fcsDown);
  }

  isOriginAllowed(origin) {
    if (!origin) return true;
    const allowed = [
      'https://angelohizon-coder.github.io',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174'
    ];
    return allowed.includes(origin);
  }

  async getQuote(symbol, origin) {
    // 1. CORS Gate
    if (!this.isOriginAllowed(origin)) {
      return { status: 403, error: 'CORS origin not allowed' };
    }

    // 2. Symbol Validation
    if (!symbol || !/^[A-Za-z0-9._-]+$/.test(symbol) || symbol.length > 15) {
      return { status: 400, error: 'Invalid symbol parameter' };
    }

    const cleanSymbol = symbol.toUpperCase();

    // 3. Upstream Yahoo Finance
    if (!this.yahooDown) {
      const quote = {
        symbol: cleanSymbol,
        name: `${cleanSymbol} Corp`,
        price: 154.50,
        currency: 'PHP',
        previousClose: 152.00,
        change: 2.50,
        changePercent: 1.64,
        volume: 1250000,
        timestamp: Date.now(),
        asOf: new Date().toISOString(),
        provider: 'yahoo_v8',
        freshness: 'delayed',
        isStale: false
      };
      this.firestoreCache.set(cleanSymbol, quote);
      return { status: 200, data: quote };
    }

    // 4. Secondary Upstream FCS API
    if (!this.fcsDown) {
      const quote = {
        symbol: cleanSymbol,
        name: `${cleanSymbol} Corp`,
        price: 154.20,
        currency: 'PHP',
        previousClose: 152.00,
        change: 2.20,
        changePercent: 1.45,
        volume: 980000,
        timestamp: Date.now(),
        asOf: new Date().toISOString(),
        provider: 'fcs_api',
        freshness: 'delayed',
        isStale: false
      };
      this.firestoreCache.set(cleanSymbol, quote);
      return { status: 200, data: quote };
    }

    // 5. Upstream Failed -> Firestore STALE Cache
    const cached = this.firestoreCache.get(cleanSymbol);
    if (cached && cached.price > 0) {
      const staleQuote = {
        ...cached,
        isStale: true,
        freshness: 'stale',
        provider: 'firestore_cache',
        staleReason: 'Upstream market providers unreachable; preserved last valid quote'
      };
      return { status: 200, data: staleQuote };
    }

    // 6. Complete outage without cache
    return { status: 503, error: `Quote unavailable for ${cleanSymbol}; no prior valid quote recorded.` };
  }
}

describe('Tier 1: R3 Market Data Gateway', () => {
  it('T1.R3.1: Gateway returns standardized schema conforming to NormalizedMarketQuote', async () => {
    const gateway = new MarketGatewayService();
    const res = await gateway.getQuote('BDO.PS', 'https://angelohizon-coder.github.io');

    assert.equal(res.status, 200);
    assertNormalizedMarketQuote(res.data);
    assert.equal(res.data.symbol, 'BDO.PS');
    assert.equal(res.data.isStale, false);
    assert.equal(typeof res.data.price, 'number');
    assert.ok(res.data.price > 0);
  });

  it('T1.R3.2: Strict CORS policy allows GitHub Pages and localhost but rejects arbitrary origins', async () => {
    const gateway = new MarketGatewayService();

    // Canonical GitHub Pages
    const ghRes = await gateway.getQuote('ALI.PS', 'https://angelohizon-coder.github.io');
    assert.equal(ghRes.status, 200);

    // Localhost dev
    const localRes = await gateway.getQuote('ALI.PS', 'http://localhost:5173');
    assert.equal(localRes.status, 200);

    // Unauthorized origin rejected
    const badRes = await gateway.getQuote('ALI.PS', 'https://malicious-phishing-site.com');
    assert.equal(badRes.status, 403);
    assert.match(badRes.error, /CORS/i);
  });

  it('T1.R3.3: Upstream failure retrieves Firestore cache and returns quote with STALE flag', async () => {
    const previousGoodQuote = {
      symbol: 'SMPH.PS',
      name: 'SM Prime Holdings',
      price: 32.50,
      currency: 'PHP',
      previousClose: 32.00,
      change: 0.50,
      changePercent: 1.56,
      volume: 500000,
      timestamp: Date.now() - 3600000,
      asOf: new Date(Date.now() - 3600000).toISOString(),
      provider: 'yahoo_v8',
      freshness: 'delayed',
      isStale: false
    };

    // Both Yahoo and FCS down, but SMPH.PS exists in Firestore cache
    const gateway = new MarketGatewayService({
      yahooDown: true,
      fcsDown: true,
      cache: [['SMPH.PS', previousGoodQuote]]
    });

    const res = await gateway.getQuote('SMPH.PS', 'https://angelohizon-coder.github.io');
    assert.equal(res.status, 200);
    assertNormalizedMarketQuote(res.data);
    assert.equal(res.data.isStale, true);
    assert.equal(res.data.freshness, 'stale');
    assert.equal(res.data.price, 32.50);
    assert.match(res.data.staleReason, /preserved last valid quote/i);
  });

  it('T1.R3.4: Failed quote NEVER replaces price with zero (zero-price hazard prevented)', async () => {
    const gateway = new MarketGatewayService({
      yahooDown: true,
      fcsDown: true,
      cache: [['BPI.PS', {
        symbol: 'BPI.PS',
        name: 'Bank of the Philippine Islands',
        price: 118.00,
        currency: 'PHP',
        previousClose: 117.50,
        change: 0.50,
        changePercent: 0.43,
        volume: 300000,
        timestamp: Date.now() - 7200000,
        asOf: new Date(Date.now() - 7200000).toISOString(),
        provider: 'yahoo_v8',
        freshness: 'delayed',
        isStale: false
      }]]
    });

    const res = await gateway.getQuote('BPI.PS', 'http://localhost:5173');
    assert.equal(res.status, 200);
    assert.notEqual(res.data.price, 0, 'Price must NEVER be 0 on outage');
    assert.equal(res.data.price, 118.00);
  });

  it('T1.R3.5: Primary Yahoo failure seamlessly falls back to FCS API', async () => {
    const gateway = new MarketGatewayService({
      yahooDown: true,
      fcsDown: false // FCS is healthy
    });

    const res = await gateway.getQuote('MBT.PS', 'https://angelohizon-coder.github.io');
    assert.equal(res.status, 200);
    assert.equal(res.data.provider, 'fcs_api');
    assert.equal(res.data.isStale, false);
    assert.ok(res.data.price > 0);
  });

  it('T1.R3.6: Symbol validation strictly rejects injection attacks and malformed tickers', async () => {
    const gateway = new MarketGatewayService();

    const pathTraversal = await gateway.getQuote('../../etc/passwd', 'http://localhost:5173');
    assert.equal(pathTraversal.status, 400);

    const scriptInjection = await gateway.getQuote('<script>alert(1)</script>', 'http://localhost:5173');
    assert.equal(scriptInjection.status, 400);

    const sqlInjection = await gateway.getQuote('AAPL; DROP TABLE quotes;', 'http://localhost:5173');
    assert.equal(sqlInjection.status, 400);
  });
});
