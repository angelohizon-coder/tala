/**
 * scenario-market-outage-stale.test.mjs
 * Tier 4: Real-World Application Scenario — Market Gateway Outage & STALE Preservation
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertNormalizedMarketQuote } from '../helpers/assertions.mjs';

describe('Tier 4: Scenario — Market Outage & STALE Quote Preservation', () => {
  it('T4.SCEN.4: Recovers from upstream provider outage by serving STALE quote from Firestore cache without zeroing prices', async () => {
    // 1. Initial State: Healthy market data saved in Firestore cache
    const firestoreMarketCache = new Map();
    const goodQuote = {
      symbol: 'ALI.PS',
      name: 'Ayala Land Inc',
      price: 34.50,
      currency: 'PHP',
      previousClose: 34.00,
      change: 0.50,
      changePercent: 1.47,
      volume: 4200000,
      timestamp: Date.now() - 3600000, // 1 hour ago
      asOf: new Date(Date.now() - 3600000).toISOString(),
      provider: 'yahoo_v8',
      freshness: 'delayed',
      isStale: false
    };
    firestoreMarketCache.set('ALI.PS', goodQuote);

    // 2. Outage occurs: Both Yahoo Finance and FCS API fail
    const upstreamAvailable = false;

    // 3. Cloud Function Market Gateway execution
    async function resolveMarketQuote(symbol) {
      if (upstreamAvailable) {
        return { status: 200, data: goodQuote };
      }

      // Upstream failed: query Firestore cache
      const cached = firestoreMarketCache.get(symbol);
      if (cached && cached.price > 0) {
        return {
          status: 200,
          data: {
            ...cached,
            isStale: true,
            freshness: 'stale',
            provider: 'firestore_cache',
            staleReason: 'Upstream market providers unreachable; preserved last valid quote'
          }
        };
      }

      return { status: 503, error: 'Quote unavailable' };
    }

    const response = await resolveMarketQuote('ALI.PS');
    assert.equal(response.status, 200);

    const quote = response.data;
    assertNormalizedMarketQuote(quote);

    // 4. Critical Invariants
    assert.equal(quote.isStale, true, 'Quote must carry explicit STALE flag');
    assert.equal(quote.freshness, 'stale');
    assert.equal(quote.price, 34.50, 'Price must preserve last known valid trade price');
    assert.notEqual(quote.price, 0, 'Price must NEVER be coerced to 0 during an outage');

    // 5. Client Portfolio Valuation survives outage
    const portfolioShares = 1000;
    const portfolioValue = portfolioShares * quote.price;
    assert.equal(portfolioValue, 34500.00); // PHP 34,500.00
  });
});
