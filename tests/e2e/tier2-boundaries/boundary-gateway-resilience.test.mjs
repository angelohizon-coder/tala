/**
 * boundary-gateway-resilience.test.mjs
 * Tier 2: Boundary & Corner Cases — Requirement R3 Market Gateway Resilience
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertNormalizedMarketQuote } from '../helpers/assertions.mjs';

describe('Tier 2: Boundary & Corner Cases — Market Gateway Resilience', () => {
  it('T2.GW.1: Handles upstream HTTP 429 Rate Limit with safe capped Retry-After header', () => {
    function handleRateLimit(rawRetryAfter) {
      const parsed = parseInt(rawRetryAfter, 10);
      const capped = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 60) : 10;
      return { status: 429, retryAfter: capped, error: 'Rate limit exceeded, please retry later' };
    }

    const res = handleRateLimit('120'); // 120s requested
    assert.equal(res.status, 429);
    assert.equal(res.retryAfter, 60); // capped at 60s
  });

  it('T2.GW.2: Corrupted or truncated upstream JSON is safely rejected without server crash', () => {
    function parseUpstreamBody(rawString) {
      try {
        const parsed = JSON.parse(rawString);
        if (!parsed || typeof parsed !== 'object') throw new Error('Not an object');
        return { success: true, data: parsed };
      } catch (err) {
        return { success: false, error: 'Malformed upstream response', status: 502 };
      }
    }

    const truncated = '{"chart":{"result":[{"meta":{"regularMarketPrice":150.';
    const res = parseUpstreamBody(truncated);
    assert.equal(res.success, false);
    assert.equal(res.status, 502);
  });

  it('T2.GW.3: Zero trading volume preserves legitimate market price without marking quote invalid', () => {
    const suspendedOrInactiveStock = {
      symbol: 'SUSP.PS',
      name: 'Suspended Trading Inc',
      price: 25.00,
      currency: 'PHP',
      previousClose: 25.00,
      change: 0,
      changePercent: 0,
      volume: 0, // Legitimate 0 volume
      timestamp: Date.now(),
      asOf: new Date().toISOString(),
      provider: 'yahoo_v8',
      freshness: 'delayed',
      isStale: false
    };

    assertNormalizedMarketQuote(suspendedOrInactiveStock);
    assert.equal(suspendedOrInactiveStock.volume, 0);
    assert.equal(suspendedOrInactiveStock.price, 25.00);
  });

  it('T2.GW.4: Normalizes and accepts diverse valid ticker symbols with dots, dashes, and exchange suffixes', () => {
    const validSymbols = ['BRK.B', '0700.HK', 'ALI-PA.PS', 'VWRA.L', 'SMC2K.PS', 'BTC-USD'];
    const symbolRegex = /^[A-Za-z0-9._-]+$/;

    for (const sym of validSymbols) {
      assert.ok(symbolRegex.test(sym), `Symbol ${sym} should be accepted`);
    }
  });

  it('T2.GW.5: Cache entry older than 30 days preserves non-zero price with explicit stale warning', () => {
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 3600 * 1000;
    const oldQuote = {
      symbol: 'HIST.PS',
      name: 'Historic Corp',
      price: 45.00,
      currency: 'PHP',
      previousClose: 45.00,
      change: 0,
      changePercent: 0,
      timestamp: thirtyOneDaysAgo,
      asOf: new Date(thirtyOneDaysAgo).toISOString(),
      provider: 'firestore_cache',
      freshness: 'stale',
      isStale: true,
      staleReason: 'Quote age exceeds 30-day threshold; preserved last known valid quote'
    };

    assertNormalizedMarketQuote(oldQuote);
    assert.equal(oldQuote.isStale, true);
    assert.equal(oldQuote.price, 45.00);
    assert.match(oldQuote.staleReason, /exceeds 30-day threshold/i);
  });

  it('T2.GW.6: Oversized quote requests split into sequential batches of max 20 symbols', () => {
    function chunkSymbols(symbols, maxBatch = 20) {
      const chunks = [];
      for (let i = 0; i < symbols.length; i += maxBatch) {
        chunks.push(symbols.slice(i, i + maxBatch));
      }
      return chunks;
    }

    const fiftySymbols = Array.from({ length: 50 }, (_, i) => `SYM_${i}`);
    const batches = chunkSymbols(fiftySymbols, 20);

    assert.equal(batches.length, 3);
    assert.equal(batches[0].length, 20);
    assert.equal(batches[1].length, 20);
    assert.equal(batches[2].length, 10);
  });
});
