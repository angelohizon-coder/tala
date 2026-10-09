import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreeGlobal, parseGlobalSymbol, parseYahooQuote, parseYahooHistory, parseYahooSearch } from '../tools/free-global.mjs';

// Parser vectors are synthetic test inputs, never dashboard prices or a source fallback.
const NOW = Date.parse('2026-10-09T11:00:00Z');
const second = text => Date.parse(text) / 1000;
const request = path => new Request(`http://127.0.0.1${path}`);
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const vector = (meta = {}, closes = [205, 210, 215]) => ({ chart: { error: null, result: [{
  meta: {
    symbol: 'AAPL', instrumentType: 'EQUITY', currency: 'USD', exchangeName: 'NMS', fullExchangeName: 'NasdaqGS',
    exchangeTimezoneName: 'America/New_York', regularMarketTime: second('2026-10-08T20:00:00Z'),
    regularMarketPrice: 215, regularMarketVolume: 12345, longName: 'Apple Inc.', chartPreviousClose: 100, ...meta,
  },
  timestamp: ['2026-10-06T13:30:00Z', '2026-10-07T13:30:00Z', '2026-10-08T13:30:00Z'].map(second),
  indicators: { quote: [{ close: closes }] },
}] } });
const adapter = options => createFreeGlobal({ now: () => NOW, ...options });

test('qualified identities map to fixed provider tickers without colliding with PSE symbols', () => {
  for (const [symbol, ticker] of [['US:AAPL', 'AAPL'], ['US:BRK-B', 'BRK-B'], ['HK:0700', '0700.HK'], ['JP:7203', '7203.T'], ['GB:VOD', 'VOD.L'], ['CA:SHOP', 'SHOP.TO'], ['AU:BHP', 'BHP.AX']]) {
    assert.equal(parseGlobalSymbol(symbol).ticker, ticker);
  }
  for (const symbol of ['AAPL', 'BDO', 'PH:BDO', 'US:aapl', 'US:AAPL.HK', 'US:BMW.DE', 'HK:700', 'HK:0700.HK', 'US:../secret', 'US:A--B', 'XX:AAPL', 'US:AAPL?token=secret', 'GB:VOD.L']) assert.throws(() => parseGlobalSymbol(symbol));
});

test('quote uses exact provider identity and source clock, deriving prior close from the preceding market date', () => {
  const quote = parseYahooQuote(vector(), 'US:AAPL', NOW);
  assert.equal(quote.symbol, 'US:AAPL');
  assert.equal(quote.ticker, 'AAPL');
  assert.equal(quote.currency, 'USD');
  assert.equal(quote.market, 'US');
  assert.equal(quote.timeZone, 'America/New_York');
  assert.equal(quote.value, 215);
  assert.equal(quote.previousClose, 210);
  assert.equal(quote.change, 5);
  assert.equal(quote.changePercent, 5 / 210 * 100);
  assert.equal(quote.asOf, '2026-10-08T20:00:00.000Z');
  assert.equal(quote.marketDate, '2026-10-08');
  assert.equal(quote.freshness, 'snapshot');
  assert.equal(quote.delayMinutes, null);
  assert.equal(quote.source, 'Yahoo Finance');
  assert.equal(quote.previousClose === 100, false, 'range-baseline chartPreviousClose cannot become daily previous close');
  assert.equal(parseYahooQuote(vector({ previousClose: 212 }), 'US:AAPL', NOW).previousClose, 212);
});

test('missing or nonnumeric values stay null, while genuine zero volume and close remain zero', () => {
  const quote = parseYahooQuote(vector({ regularMarketPrice: null, regularMarketVolume: 0 }, [205, null, 215]), 'US:AAPL', NOW);
  assert.equal(quote.value, null);
  assert.equal(quote.previousClose, null);
  assert.equal(quote.change, null);
  assert.equal(quote.changePercent, null);
  assert.equal(quote.volume, 0);
  assert.equal(parseYahooQuote(vector({ regularMarketPrice: '215', regularMarketVolume: true }), 'US:AAPL', NOW).value, null);
  assert.equal(parseYahooQuote(vector({ previousClose: 0 }), 'US:AAPL', NOW).changePercent, null);
  assert.equal(parseYahooHistory(vector({}, [205, null, 0]), 'US:AAPL', '1m', NOW).points.at(-1).close, 0);
});

test('London pence prices, prior close, changes and daily history normalize consistently to pounds', () => {
  const raw = vector({ symbol: 'VOD.L', currency: 'GBp', exchangeName: 'LSE', fullExchangeName: 'London', exchangeTimezoneName: 'Europe/London', regularMarketPrice: 100, longName: 'Vodafone Group Public Limited Company' }, [98, 99, 100]);
  const quote = parseYahooQuote(raw, 'GB:VOD', NOW);
  assert.equal(quote.currency, 'GBP');
  assert.equal(quote.sourceCurrency, 'GBp');
  assert.equal(quote.sourceUnit, 'pence');
  assert.equal(quote.value, 1);
  assert.equal(quote.previousClose, 0.99);
  assert.ok(Math.abs(quote.change - 0.01) < 1e-12);
  assert.deepEqual(parseYahooHistory(raw, 'GB:VOD', '1m', NOW).points.map(point => point.close), [0.98, 0.99, 1]);
  assert.equal(parseYahooQuote(vector({ ...raw.chart.result[0].meta, currency: 'GBP', regularMarketPrice: 1 }, [0.98, 0.99, 1]), 'GB:VOD', NOW).value, 1);
});

test('malformed, future, mismatched and unsupported source metadata cannot become prices', () => {
  for (const meta of [{ symbol: 'MSFT' }, { currency: 'HKD' }, { instrumentType: 'CRYPTOCURRENCY' }, { exchangeTimezoneName: 'UTC' }, { exchangeName: null }, { regularMarketTime: null }, { regularMarketTime: second('2026-10-10T20:00:00Z') }]) assert.throws(() => parseYahooQuote(vector(meta), 'US:AAPL', NOW));
  const duplicated = vector();
  duplicated.chart.result[0].timestamp[1] = duplicated.chart.result[0].timestamp[0];
  assert.throws(() => parseYahooQuote(duplicated, 'US:AAPL', NOW));
  const mismatched = vector();
  mismatched.chart.result[0].indicators.quote[0].close.pop();
  assert.throws(() => parseYahooHistory(mismatched, 'US:AAPL', '1m', NOW));
  assert.throws(() => parseYahooQuote({ chart: { result: null, error: { code: 'Not Found', description: 'unsafe server detail' } } }, 'US:AAPL', NOW));
});

test('daily history excludes unfinished current-day bars and retains completed sessions and null gaps', () => {
  const raw = vector({ regularMarketTime: second('2026-10-09T17:00:00Z'), currentTradingPeriod: { regular: { end: second('2026-10-09T20:00:00Z') } } }, [205, null, 215]);
  raw.chart.result[0].timestamp[2] = second('2026-10-09T13:30:00Z');
  const during = parseYahooHistory(raw, 'US:AAPL', '1m', Date.parse('2026-10-09T17:01:00Z'));
  assert.deepEqual(during.points.map(point => point.date), ['2026-10-06', '2026-10-07']);
  assert.equal(during.points[1].close, null);
  const after = parseYahooHistory(raw, 'US:AAPL', '1m', Date.parse('2026-10-09T20:01:00Z'));
  assert.equal(after.points.at(-1).date, '2026-10-09');
  assert.equal(after.freshness, 'eod');
});

test('search accepts new source-reported equities and ETFs, filters other markets and unsupported assets', () => {
  const quotes = [
    { symbol: 'COST', longname: 'Costco Wholesale Corporation', quoteType: 'EQUITY', exchange: 'NMS', exchDisp: 'NASDAQ', isYahooFinance: true },
    { symbol: 'VOO', shortname: 'Vanguard S&P 500 ETF', quoteType: 'ETF', exchange: 'PCX' },
    { symbol: '0700.HK', longname: 'Tencent Holdings Limited', quoteType: 'EQUITY', exchange: 'HKG' },
    { symbol: 'BMW.DE', longname: 'BMW', quoteType: 'EQUITY', exchange: 'GER' },
    { symbol: 'BTC-USD', shortname: 'Bitcoin', quoteType: 'CRYPTOCURRENCY', exchange: 'CCC' },
    { symbol: 'BAD', longname: 'Bad currency', quoteType: 'EQUITY', currency: 'HKD', exchange: 'NMS' },
  ];
  assert.deepEqual(parseYahooSearch({ quotes }, 'US').map(row => row.symbol), ['US:COST', 'US:VOO']);
  assert.equal(parseYahooSearch({ quotes }, 'HK')[0].symbol, 'HK:0700');
  assert.throws(() => parseYahooSearch({ quotes: null }, 'US'));
});

test('empty-query catalog offers metadata without fetching or manufacturing prices', async () => {
  const free = adapter({ fetchFn: () => { throw new Error('No request expected'); } });
  const data = await (await free.handle(request('/catalog?market=HK'))).json();
  assert.equal(data.instruments[0].symbol, 'HK:0700');
  assert.equal(data.instruments[0].currency, 'HKD');
  assert.equal(data.instruments[0].verified, false);
  assert.equal(data.instruments[0].value, undefined);
  assert.equal(data.coverage.type, 'searchable');
});

test('remote searches and new ticker charts use only fixed Yahoo paths, cache success, and need no credential', async () => {
  const calls = [];
  const free = adapter({ fetchFn: async value => {
    const url = new URL(value); calls.push(url);
    assert.equal(url.origin, 'https://query1.finance.yahoo.com');
    assert.equal(url.searchParams.has('api_token'), false);
    if (url.pathname === '/v1/finance/search') return json({ quotes: [{ symbol: 'COST', longname: 'Costco Wholesale Corporation', quoteType: 'EQUITY', exchange: 'NMS' }] });
    assert.equal(url.pathname, '/v8/finance/chart/COST');
    assert.equal(url.searchParams.get('range'), '5d');
    return json(vector({ symbol: 'COST', longName: 'Costco Wholesale Corporation' }));
  } });
  const found = await (await free.handle(request('/catalog?market=US&q=Costco'))).json();
  assert.equal(found.instruments[0].symbol, 'US:COST');
  assert.equal((await (await free.handle(request('/catalog?market=US&q=Costco'))).json()).cached, true);
  const first = await (await free.handle(request('/quotes?symbols=US:COST'))).json();
  assert.equal(first.quotes[0].symbol, 'US:COST');
  assert.equal(first.quotes[0].cached, false);
  assert.equal((await (await free.handle(request('/quotes?symbols=US:COST'))).json()).quotes[0].cached, true);
  assert.equal(calls.length, 2);
});

test('quote failures stay per-symbol, sanitized, and retriable instead of clearing healthy peers', async () => {
  let badCalls = 0;
  const free = adapter({ fetchFn: async value => {
    const url = new URL(value);
    if (url.pathname.endsWith('/AAPL')) return json(vector());
    badCalls++;
    throw new Error('unsafe API token secret and internal host');
  } });
  const result = await free.handle(request('/quotes?symbols=US:AAPL,US:FAIL'));
  const data = await result.json();
  assert.equal(result.status, 200);
  assert.equal(data.quotes.length, 1);
  assert.equal(data.issues.length, 1);
  assert.equal(data.issues[0].symbol, 'US:FAIL');
  assert.equal(data.issues[0].code, 'source_unavailable');
  assert.equal(JSON.stringify(data).includes('secret'), false);
  assert.equal(badCalls, 2, 'only query1 and query2 are attempted');
  await free.handle(request('/quotes?symbols=US:FAIL'));
  assert.equal(badCalls, 4, 'network failures are not cached indefinitely');
});

test('request validation rejects hostile parameters and oversized batches before fetching', async () => {
  let calls = 0;
  const free = adapter({ fetchFn: () => { calls++; throw new Error('unexpected'); } });
  for (const path of ['/quotes?symbols=US:AAPL&url=https://evil.test', '/quotes?symbols=US:AAPL&symbols=US:MSFT', '/quotes?symbols=US:AAPL,US:AAPL', '/quotes?symbols=BDO', '/quotes?symbols=US:AAPL.PSE', '/catalog?market=XX&q=Apple', '/catalog?market=HK&q=US:AAPL', '/catalog?q=https://evil.test', '/history/US%3AAAPL?range=10y', '/history/US%3AAAPL?range=1m&token=secret', `/quotes?symbols=${Array.from({ length: 21 }, (_, index) => `US:A${index}`).join(',')}`]) assert.equal((await free.handle(request(path))).status, 400, path);
  assert.equal(calls, 0);
  assert.equal((await free.handle(new Request('http://127.0.0.1/quotes', { method: 'POST' }))).status, 405);
});

test('source rate limits cap Retry-After, avoid fallback, and suppress requests during cooldown', async () => {
  let calls = 0;
  const free = adapter({ fetchFn: async () => { calls++; return new Response('unsafe body secret', { status: 429, headers: { 'Retry-After': '99999' } }); } });
  const first = await free.handle(request('/quotes?symbols=US:AAPL'));
  assert.equal(first.headers.get('Retry-After'), '300');
  assert.equal((await first.json()).issues[0].retryAfter, 300);
  assert.equal(calls, 1);
  assert.equal((await free.handle(request('/catalog?q=Apple'))).status, 429);
  assert.equal(calls, 1);
});

test('history requests preserve encoded qualified IDs, bounded ranges and normalized source metadata', async () => {
  let calls = 0;
  const free = adapter({ fetchFn: async value => {
    calls++; const url = new URL(value);
    assert.equal(url.pathname, '/v8/finance/chart/AAPL');
    assert.equal(url.searchParams.get('range'), '1y');
    assert.equal(url.searchParams.get('interval'), '1d');
    return json(vector());
  } });
  const data = await (await free.handle(request('/history/US%3AAAPL?range=1y'))).json();
  assert.equal(data.symbol, 'US:AAPL');
  assert.equal(data.currency, 'USD');
  assert.equal(data.points.length, 3);
  assert.equal((await (await free.handle(request('/history/US%3AAAPL?range=1y'))).json()).cached, true);
  assert.equal(calls, 1);
});

test('request-wide deadline bounds slow batches and returns an outcome for every symbol', async () => {
  let active = 0, maximumActive = 0, calls = 0;
  const free = adapter({ timeoutMs: 5, requestBudgetMs: 12, fetchFn: async (_value, options) => {
    calls++; active++; maximumActive = Math.max(maximumActive, active);
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => { active--; reject(new Error('aborted')); }, { once: true }));
  } });
  const symbols = Array.from({ length: 20 }, (_, index) => `US:A${index}`);
  const data = await (await free.handle(request(`/quotes?symbols=${symbols.join(',')}`))).json();
  assert.equal(data.quotes.length, 0);
  assert.equal(data.issues.length, 20);
  assert.deepEqual(data.issues.map(issue => issue.symbol), symbols);
  assert.ok(data.issues.every(issue => issue.code === 'source_timeout'));
  assert.ok(maximumActive <= 4);
  assert.ok(calls < 20, 'queued calls stop once the batch budget is exhausted');
});
