import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreeMarket, FREE_MARKETS } from '../tools/free-market.mjs';

const NOW = Date.parse('2026-10-09T10:00:00Z');
const request = (path, method = 'GET') => new Request(`http://127.0.0.1:5180${path}`, { method });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const stock = symbol => ({ symbol, name: `Test ${symbol}`, assetType: 'stock', currency: symbol.includes(':') ? 'USD' : 'PHP', value: 10, asOf: '2026-10-09T09:00:00Z', source: 'Test source' });
function harness({ ph, foreign, ...options } = {}) {
  const calls = { ph: [], global: [] }, factoryOptions = {};
  const adapter = (name, handler) => received => {
    factoryOptions[name] = received;
    return { async handle(req) { calls[name].push(new URL(req.url)); return handler(req); } };
  };
  return {
    router: createFreeMarket({ now: () => NOW, ...options,
      pseFactory: adapter('ph', ph ?? (async () => json({ instruments: [], source: 'Test PH' }))),
      globalFactory: adapter('global', foreign ?? (async () => json({ instruments: [], source: 'Test global' }))),
    }), calls, factoryOptions,
  };
}
const groupQuotes = req => json({ quotes: new URL(req.url).searchParams.get('symbols').split(',').map(stock) });

test('default and explicit PH catalogs strip market while preserving search and PH coverage scope', async () => {
  const setup = harness({ ph: async req => {
    assert.equal(new URL(req.url).searchParams.has('market'), false);
    return json({ instruments: [{ symbol: 'BDO', name: 'BDO' }], coverage: { type: 'mirror', count: 21 }, source: 'PSE EDGE' });
  } });
  const result = await setup.router.handle(request('/catalog?market=PH&q=BDO'));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.market, 'PH');
  assert.deepEqual(body.coverage, { type: 'mirror', count: 21, market: 'PH' });
  assert.equal(setup.calls.ph[0].search, '?q=BDO');
  assert.equal((await setup.router.handle(request('/catalog'))).status, 200);
  assert.equal(setup.calls.global.length, 0);
});

test('foreign catalogs preserve supported market and query; injected options reach both sources', async () => {
  const fetchFn = async () => { throw new Error('No network is permitted in this test.'); };
  const setup = harness({ fetchFn, mirrorFallback: true, timeoutMs: 25,
    foreign: async req => json({ instruments: [{ symbol: `${new URL(req.url).searchParams.get('market')}:TEST`, verified: false }] }),
  });
  assert.deepEqual(FREE_MARKETS, ['PH', 'US', 'HK', 'JP', 'GB', 'CA', 'AU']);
  for (const market of FREE_MARKETS.slice(1)) {
    assert.equal((await setup.router.handle(request(`/catalog?market=${market}&q=test`))).status, 200);
    assert.equal(setup.calls.global.at(-1).search, `?market=${market}&q=test`);
  }
  assert.equal(setup.calls.ph.length, 0);
  for (const options of Object.values(setup.factoryOptions)) {
    assert.equal(options.fetchFn, fetchFn); assert.equal(options.now(), NOW); assert.equal(options.mirrorFallback, true); assert.equal(options.timeoutMs, 25);
  }
});

test('mixed quotes run both groups concurrently, retain requested order and distinguish ticker collisions', async () => {
  let phStarted = false, globalStarted = false;
  let releasePh, releaseGlobal;
  const phGate = new Promise(resolve => { releasePh = resolve; });
  const globalGate = new Promise(resolve => { releaseGlobal = resolve; });
  const setup = harness({
    ph: async req => { phStarted = true; await phGate; return json({ quotes: new URL(req.url).searchParams.get('symbols').split(',').map(stock), coverage: { type: 'mirror', count: 21 } }); },
    foreign: async req => { globalStarted = true; await globalGate; return groupQuotes(req); },
  });
  const pending = setup.router.handle(request('/quotes?symbols=US:SM,BDO,SM,HK:0700'));
  assert.equal(phStarted, true); assert.equal(globalStarted, true);
  releaseGlobal(); releasePh();
  const response = await pending;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.quotes.map(row => row.symbol), ['US:SM', 'BDO', 'SM', 'HK:0700']);
  assert.deepEqual(body.issues, []);
  assert.equal(body.coverage.market, 'PH');
  assert.equal(setup.calls.ph[0].searchParams.get('symbols'), 'BDO,SM');
  assert.equal(setup.calls.global[0].searchParams.get('symbols'), 'US:SM,HK:0700');
});

test('healthy Philippine quotes survive a global source failure with exact qualified failure IDs', async () => {
  const setup = harness({ ph: groupQuotes, foreign: async () => json({ error: { code: 'source_timeout', message: 'Test timeout' } }, 504) });
  const response = await setup.router.handle(request('/quotes?symbols=BDO,US:AAPL,JP:7203'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.quotes.map(row => row.symbol), ['BDO']);
  assert.deepEqual(body.issues.map(row => [row.symbol, row.code]), [['US:AAPL', 'source_timeout'], ['JP:7203', 'source_timeout']]);
  assert.ok(body.issues.every(row => row.qualifiedSymbol === row.symbol));
  assert.equal(body.instruments, undefined);
});

test('healthy international quotes survive PH failure and retain per-symbol global issues', async () => {
  const setup = harness({ ph: async () => json({ error: { code: 'coverage_unavailable' } }, 503),
    foreign: async () => json({ quotes: [stock('US:AAPL')], issues: [{ symbol: 'HK:9999', code: 'unknown_symbol' }] }),
  });
  const response = await setup.router.handle(request('/quotes?symbols=BDO,HK:9999,US:AAPL'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.quotes.map(row => row.symbol), ['US:AAPL']);
  assert.deepEqual(body.issues.map(row => [row.symbol, row.qualifiedSymbol, row.code]), [['BDO', 'PH:BDO', 'coverage_unavailable'], ['HK:9999', 'HK:9999', 'unknown_symbol']]);
  assert.equal(body.coverage, undefined);
});

test('all failed quote groups return source error status and bounded retry metadata', async () => {
  const setup = harness({ ph: async () => { throw new Error('secret upstream detail'); },
    foreign: async () => json({ quotes: [], issues: [{ symbol: 'US:AAPL', code: 'rate_limited', retryAfter: 9999 }] }, 200, { 'Retry-After': '9999' }),
  });
  const response = await setup.router.handle(request('/quotes?symbols=BDO,US:AAPL'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Retry-After'), '300');
  const body = await response.json();
  assert.equal(body.error.code, 'source_unavailable');
  assert.equal(body.quotes, undefined);
  assert.equal(JSON.stringify(body).includes('secret upstream detail'), false);
  const unknown = harness({ foreign: async () => json({ quotes: [], issues: [{ symbol: 'US:UNKNOWN', code: 'unknown_symbol' }] }) });
  assert.equal((await unknown.router.handle(request('/quotes?symbols=US:UNKNOWN'))).status, 400);
  const limited = harness({ foreign: async () => json({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '30' }) });
  assert.equal((await limited.router.handle(request('/quotes?symbols=US:AAPL'))).status, 429);
});

test('missing, duplicate or unexpected response identities cannot create validated quotes', async () => {
  for (const body of [
    { quotes: [] },
    { quotes: [stock('AAPL')] },
    { quotes: [stock('US:AAPL'), stock('US:AAPL')] },
    { quotes: [stock('US:AAPL')], issues: [{ symbol: 'US:AAPL', code: 'unknown_symbol' }] },
  ]) {
    const setup = harness({ ph: groupQuotes, foreign: async () => json(body) });
    const response = await setup.router.handle(request('/quotes?symbols=BDO,US:AAPL'));
    const result = await response.json();
    assert.deepEqual(result.quotes.map(row => row.symbol), ['BDO']);
    assert.equal(result.issues[0].symbol, 'US:AAPL');
    assert.equal(result.issues[0].code, 'source_changed');
  }
  const malformed = harness({ ph: groupQuotes, foreign: async () => new Response('{not-json') });
  const response = await malformed.router.handle(request('/quotes?symbols=BDO,US:AAPL'));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.quotes.map(row => row.symbol), ['BDO']);
  assert.equal(result.issues[0].code, 'source_changed');
});

test('aggregate limits, invalid markets, duplicate keys and URL-like IDs reject before adapter calls', async () => {
  const setup = harness();
  for (const path of [
    '/catalog?market=XX', '/catalog?market=us', '/catalog?market=PH&market=US', '/catalog?url=https://evil.test',
    '/quotes', '/quotes?symbols=BDO,BDO', '/quotes?symbols=US:AAPL,US:AAPL', '/quotes?symbols=FR:AAPL',
    '/quotes?symbols=us:AAPL', '/quotes?symbols=BDO.PSE', '/quotes?symbols=US:AAPL&market=US',
    '/quotes?symbols=BDO&symbols=US:AAPL', '/quotes?symbols=https://evil.test',
    `/quotes?symbols=${['BDO', ...Array.from({ length: 20 }, (_, index) => `US:T${index}`)].join(',')}`,
  ]) assert.equal((await setup.router.handle(request(path))).status, 400, path);
  assert.equal((await setup.router.handle(request('/quotes?symbols=BDO', 'POST'))).status, 405);
  assert.equal(setup.calls.ph.length + setup.calls.global.length, 0);
});

test('history qualification and existing Philippine endpoints preserve delegate validations', async () => {
  const setup = harness({ ph: async req => json({ delegated: 'PH', path: new URL(req.url).pathname }, 404),
    foreign: async req => json({ delegated: 'global', path: new URL(req.url).pathname }, 400),
  });
  for (const path of ['/history/US:AAPL?range=1y', '/history/JP%3A7203?range=invalid']) {
    const response = await setup.router.handle(request(path));
    assert.equal(response.status, 400); assert.equal((await response.json()).delegated, 'global');
  }
  for (const path of ['/history/BDO?range=1w', '/history/PSEI', '/index/PSEI', '/etf/FMETF', '/funds', '/unknown']) {
    const response = await setup.router.handle(request(path));
    assert.equal(response.status, 404); assert.equal((await response.json()).delegated, 'PH');
  }
});
