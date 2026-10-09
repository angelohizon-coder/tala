import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, createWorker, normalizeQuote, numberOrNull, manilaDate, retrySeconds } from '../worker/index.mjs';

const NOW = Date.parse('2026-10-09T08:00:00Z');
const ORIGIN_A = 'https://example.github.io';
const ORIGIN_B = 'https://markets.example.com';
const TOKEN = 'private_test_token_DO_NOT_RETURN';
const ENV = { EODHD_TOKEN: TOKEN, PUBLIC_DISPLAY_LICENSED: 'true', ALLOWED_ORIGINS: `${ORIGIN_A},${ORIGIN_B}` };
const QUOTE = { code: 'AC.PSE', close: 600, previousClose: 590, change: 10, change_p: 1.6949, volume: 0, timestamp: Date.parse('2026-10-09T07:00:00Z') / 1000 };
const PROVIDER_CATALOG = Object.entries(CATALOG).map(([Code, Name]) => ({ Code, Name, Type: Code === 'FMETF' ? 'ETF' : 'Common Stock', Currency: 'PHP', Exchange: 'PSE' }));
const fund = { id: 'approved-equity', name: 'Approved Equity Fund', category: 'Equity', currency: 'PHP', value: 3.4567, valueType: 'NAVPS', previousClose: 3.4, valuationDate: '2026-10-08', asOf: '2026-10-08T08:00:00Z', source: 'Approved fund manager' };
const fundsEnvelope = { generatedAt: '2026-10-09T08:00:00Z', funds: [fund] };
const index = { symbol: 'PSEI', name: 'PSE Composite Index', value: 7200, valueType: 'index_level', previousClose: 7100, asOf: '2026-10-09T07:00:00Z', marketDate: '2026-10-09', freshness: 'delayed', delayMinutes: 20, source: 'Licensed index vendor' };

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const request = (path, { origin = ORIGIN_A, method = 'GET', headers = {} } = {}) => new Request(`https://gateway.example${path}`, { method, headers: { ...(origin ? { Origin: origin } : {}), ...headers } });
const makeWorker = (options = {}) => {
  const { fetchFn = async () => json(QUOTE), catalogFetchFn = async () => json(PROVIDER_CATALOG), ...rest } = options;
  return createWorker({ now: () => NOW, ...rest, fetchFn: (url, init) => new URL(url).pathname === '/api/exchange-symbol-list/PSE' ? catalogFetchFn(url, init) : fetchFn(url, init) });
};
const kv = values => ({ get: async (key, options) => { assert.deepEqual(options, { type: 'json' }); return structuredClone(values[key] ?? null); } });
class MemoryCache {
  entries = new Map();
  keys = [];
  async match(key) { this.keys.push(key.url); return this.entries.get(key.url)?.clone(); }
  async put(key, response) { this.entries.set(key.url, response.clone()); }
}

test('nullable financial fields never coerce missing values to zero', () => {
  for (const value of [null, undefined, '', ' ', 'NA', 'NaN', 'Infinity', true, false, [], {}, Infinity, NaN, '0x10']) assert.equal(numberOrNull(value), null);
  for (const value of [0, '0', 12.34, '12.34', '-3.5', '1e3']) assert.equal(numberOrNull(value), Number(value));
  const quote = normalizeQuote({ close: null, previousClose: null, volume: null, timestamp: null, change: 0, change_p: 0 }, 'AC');
  for (const field of ['value', 'previousClose', 'change', 'changePercent', 'volume', 'asOf', 'marketDate']) assert.equal(quote[field], null);
  assert.equal(quote.freshness, 'delayed');
  assert.equal(quote.delayMinutes, 20);
});

test('real zero volume survives and missing previous close does not create returns', () => {
  const quote = normalizeQuote({ code: 'AC.PSE', close: '600', volume: 0 }, 'AC');
  assert.equal(quote.value, 600);
  assert.equal(quote.volume, 0);
  assert.equal(quote.previousClose, null);
  assert.equal(quote.changePercent, null);
  const zeroPrevious = normalizeQuote({ close: 4, previousClose: 0, change_p: 100 }, 'AC');
  assert.equal(zeroPrevious.changePercent, null);
});

test('timestamps are source times and dates are Philippine market dates', () => {
  assert.equal(manilaDate('2026-10-08T17:00:00Z'), '2026-10-09');
  assert.equal(normalizeQuote({ timestamp: Date.parse('2026-10-08T17:00:00Z') / 1000 }, 'AC').marketDate, '2026-10-09');
  assert.equal(normalizeQuote({ timestamp: 'NA' }, 'AC').asOf, null);
});

test('valid batched request uses only fixed EODHD endpoint and server token', async () => {
  let upstreamUrl;
  const worker = makeWorker({ fetchFn: async (url, options) => {
    upstreamUrl = new URL(url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'GET');
    assert.ok(options.signal instanceof AbortSignal);
    return json([{ ...QUOTE, code: 'BDO.PSE' }, QUOTE]);
  } });
  const response = await worker.fetch(request('/quotes?symbols=BDO,AC'), ENV);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.quotes.map(quote => quote.symbol), ['AC', 'BDO']);
  assert.equal(body.generatedAt, '2026-10-09T08:00:00.000Z');
  assert.equal(upstreamUrl.origin, 'https://eodhd.com');
  assert.equal(upstreamUrl.pathname, '/api/real-time/AC.PSE');
  assert.equal(upstreamUrl.searchParams.get('s'), 'BDO.PSE');
  assert.equal(upstreamUrl.searchParams.get('api_token'), TOKEN);
  assert.equal(upstreamUrl.searchParams.get('fmt'), 'json');
  assert.ok(!JSON.stringify(body).includes(TOKEN));
});

test('invalid and hostile symbols/params are rejected before provider calls', async () => {
  let count = 0;
  const worker = makeWorker({ fetchFn: async () => { count++; return json(QUOTE); } });
  const paths = ['/quotes', '/quotes?symbols=', '/quotes?symbols=AC,', '/quotes?symbols=ac', '/quotes?symbols=AC.PSE', '/quotes?symbols=AC,AC', '/quotes?symbols=__proto__', '/quotes?symbols=AC&symbols=BDO', '/quotes?symbols=AC&url=https://evil.test', '/quotes?symbols=AC&api_token=attacker', '/quotes?symbols=https://evil.test', '/quotes?symbols=AC%0a', '/history/AC?range=2y', '/history/AC?range=1m&range=1y', '/history/AC?from=1970-01-01', '/funds?source=https://evil.test', '/index/PSEI?token=bad'];
  for (const path of paths) {
    const response = await worker.fetch(request(path), ENV);
    assert.equal(response.status, 400, path);
  }
  assert.equal(count, 0);
});

test('symbol bound validates original request rather than silently truncating', async () => {
  let count = 0;
  const worker = makeWorker({ fetchFn: async url => {
    count++;
    const parsed = new URL(url);
    const codes = [parsed.pathname.split('/').at(-1), ...parsed.searchParams.get('s').split(',')];
    return json(codes.map(code => ({ ...QUOTE, code })));
  } });
  const symbols = Object.keys(CATALOG);
  assert.equal(symbols.length, 20);
  assert.equal((await worker.fetch(request(`/quotes?symbols=${symbols.join(',')}`), ENV)).status, 200);
  assert.equal((await worker.fetch(request(`/quotes?symbols=${[...symbols, 'AC'].join(',')}`), ENV)).status, 400);
  assert.equal(count, 1);
});

test('method, path, and encoded hostile IDs are constrained', async () => {
  const worker = makeWorker();
  const response = await worker.fetch(request('/quotes?symbols=AC', { method: 'POST' }), ENV);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, OPTIONS');
  for (const path of ['/proxy', '/history/BTC', '/etf/AC', '/funds/a%2Fb/history', '/funds/https:%2F%2Fevil.test/history', '/quotes/']) assert.ok([400, 404].includes((await worker.fetch(request(path), ENV)).status), path);
});

test('license and configuration gates never call upstream, even with a cache', async () => {
  const cache = new MemoryCache();
  let count = 0;
  const worker = makeWorker({ cache, fetchFn: async () => { count++; return json(QUOTE); } });
  assert.equal((await worker.fetch(request('/quotes?symbols=AC'), ENV)).status, 200);
  for (const flag of [undefined, 'false', true, 'TRUE']) {
    const response = await worker.fetch(request('/quotes?symbols=AC'), { ...ENV, PUBLIC_DISPLAY_LICENSED: flag });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'license_required');
  }
  const noSecret = await worker.fetch(request('/quotes?symbols=AC'), { ...ENV, EODHD_TOKEN: '' });
  assert.equal(noSecret.status, 503);
  assert.equal(count, 1);
});

test('cache keys canonicalize quotes and CORS is recalculated per visitor', async () => {
  const cache = new MemoryCache();
  let count = 0;
  const worker = makeWorker({ cache, fetchFn: async () => { count++; return json([QUOTE, { ...QUOTE, code: 'BDO.PSE' }]); } });
  const a = await worker.fetch(request('/quotes?symbols=AC,BDO'), ENV);
  const b = await worker.fetch(request('/quotes?symbols=BDO,AC', { origin: ORIGIN_B }), ENV);
  const noOrigin = await worker.fetch(request('/quotes?symbols=AC,BDO', { origin: null }), ENV);
  const evil = await worker.fetch(request('/quotes?symbols=AC,BDO', { origin: 'https://evil.test' }), ENV);
  assert.equal(count, 1);
  assert.equal(a.headers.get('Access-Control-Allow-Origin'), ORIGIN_A);
  assert.equal(b.headers.get('Access-Control-Allow-Origin'), ORIGIN_B);
  assert.equal(noOrigin.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(b.headers.get('X-Market-Cache'), 'HIT');
  assert.equal(a.headers.get('Vary'), 'Origin');
  assert.equal(a.headers.get('Cache-Control'), 'no-store');
  assert.equal(cache.entries.size, 2);
  const stored = [...cache.entries].find(([key]) => key.includes('/quotes?'))[1];
  assert.equal(stored.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(stored.headers.get('Cache-Control'), 'public, max-age=60');
  assert.ok(cache.keys.every(key => !key.includes(TOKEN) && !key.includes(ORIGIN_A)));
});

test('CORS allows exact configured origins and rejects null or lookalike origins', async () => {
  const worker = makeWorker();
  for (const origin of ['null', `${ORIGIN_A}.evil.test`, `${ORIGIN_A}/path`, 'https://example.github.io:444', 'http://example.github.io']) {
    assert.equal((await worker.fetch(request('/quotes?symbols=AC', { origin }), ENV)).status, 403, origin);
  }
  assert.equal((await worker.fetch(request('/quotes?symbols=AC'), { ...ENV, ALLOWED_ORIGINS: '*' })).status, 403);
});

test('preflight validates method/headers and succeeds without configured provider', async () => {
  const worker = makeWorker();
  const env = { ALLOWED_ORIGINS: ORIGIN_A };
  const response = await worker.fetch(request('/quotes?symbols=AC', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Accept' } }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN_A);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal(await response.text(), '');
  for (const headers of [{ 'Access-Control-Request-Method': 'POST' }, { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization' }]) assert.equal((await worker.fetch(request('/quotes?symbols=AC', { method: 'OPTIONS', headers }), env)).status, 400);
});

test('upstream failures map to safe status/messages with no secret leakage or caching', async () => {
  for (const [upstreamStatus, expected] of [[401, 503], [403, 503], [404, 404], [500, 502], [503, 502]]) {
    const cache = new MemoryCache();
    const worker = makeWorker({ cache, fetchFn: async () => new Response(`Failed https://eodhd.com?api_token=${TOKEN}`, { status: upstreamStatus, headers: { 'X-Token': TOKEN } }) });
    const response = await worker.fetch(request('/quotes?symbols=AC'), ENV);
    assert.equal(response.status, expected);
    assert.ok(!(await response.text()).includes(TOKEN));
    assert.equal(response.headers.get('X-Token'), null);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.ok([...cache.entries.keys()].every(key => key.endsWith('/catalog')));
  }
  const worker = makeWorker({ fetchFn: async () => { throw new Error(`connect failed ${TOKEN}`); } });
  const response = await worker.fetch(request('/quotes?symbols=AC'), ENV);
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(TOKEN));
});

test('429 honors capped numeric and date Retry-After without reflecting arbitrary headers', async () => {
  for (const [header, expected] of [['99999999', 300], ['2.4', 3], ['-100', 1], ['0', 1], ['garbage', 30], ['Fri, 09 Oct 2026 08:01:00 GMT', 60]]) {
    const worker = makeWorker({ fetchFn: async () => new Response(TOKEN, { status: 429, headers: { 'Retry-After': header } }) });
    const response = await worker.fetch(request('/quotes?symbols=AC'), ENV);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), String(expected));
    assert.ok(!(await response.text()).includes(TOKEN));
  }
  assert.equal(retrySeconds(null, NOW), 30);
});

test('provider timeout covers a fetch that never resolves', async () => {
  let signal;
  const worker = makeWorker({ timeoutMs: 15, fetchFn: async (url, options) => { signal = options.signal; return new Promise(() => {}); } });
  const response = await worker.fetch(request('/quotes?symbols=AC'), ENV);
  assert.equal(response.status, 504);
  assert.equal(signal.aborted, true);
  assert.equal((await response.json()).error.code, 'provider_timeout');
});

test('provider timeout also covers a response body that never finishes', async () => {
  const worker = makeWorker({ timeoutMs: 15, fetchFn: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })) });
  assert.equal((await worker.fetch(request('/quotes?symbols=AC'), ENV)).status, 504);
});

test('malformed, unbounded, wrong-symbol, and duplicate provider data are rejected', async () => {
  const responses = [() => new Response('not json'), () => json({ error: `unknown ${TOKEN}` }), () => json([]), () => json({ ...QUOTE, code: 'AC.US' }), () => json({ ...QUOTE, code: 'BDO.PSE' }), () => json([QUOTE, QUOTE]), () => new Response('x'.repeat(512 * 1024 + 1)), () => new Response('{}', { headers: { 'Content-Length': String(512 * 1024 + 1) } })];
  for (const makeResponse of responses) {
    const worker = makeWorker({ fetchFn: async () => makeResponse() });
    const response = await worker.fetch(request('/quotes?symbols=AC'), ENV);
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes(TOKEN));
  }
});

test('missing quote values remain nullable in successful upstream data', async () => {
  const worker = makeWorker({ fetchFn: async () => json({ code: 'AC.PSE', close: 'NA', timestamp: null }) });
  const response = await worker.fetch(request('/quotes?symbols=AC'), ENV);
  assert.equal(response.status, 200);
  const quote = (await response.json()).quotes[0];
  assert.equal(quote.value, null);
  assert.equal(quote.previousClose, null);
  assert.equal(quote.asOf, null);
  assert.equal(quote.marketDate, null);
});

test('omitted instrument in a valid batch has nullable fields rather than a fabricated quote', async () => {
  const response = await makeWorker().fetch(request('/quotes?symbols=AC,BDO'), ENV);
  const bdo = (await response.json()).quotes.find(quote => quote.symbol === 'BDO');
  assert.equal(bdo.value, null);
  assert.equal(bdo.asOf, null);
});

test('history uses bounded EOD daily range and preserves null closes', async () => {
  let url;
  const worker = makeWorker({ fetchFn: async value => {
    url = new URL(value);
    return json([{ date: '2026-10-08', close: null }, { date: '2026-10-06', close: '600' }, { date: '2026-08-01', close: 500 }, { date: '2026-10-10', close: 900 }]);
  } });
  const response = await worker.fetch(request('/history/AC?range=1w'), ENV);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { symbol: 'AC', points: [{ date: '2026-10-06', close: 600 }, { date: '2026-10-08', close: null }], source: 'EODHD', freshness: 'eod' });
  assert.equal(url.pathname, '/api/eod/AC.PSE');
  assert.equal(url.searchParams.get('from'), '2026-10-02');
  assert.equal(url.searchParams.get('to'), '2026-10-09');
  assert.equal(url.searchParams.get('period'), 'd');
  assert.equal(url.searchParams.get('order'), 'a');
});

test('history malformed dates/duplicate rows/schema fail and empty history is valid', async () => {
  for (const payload of [{}, [{ date: '2026-02-30', close: 100 }], [{ close: 100 }], [{ date: '2026-10-08', close: 10 }, { date: '2026-10-08', close: 11 }]]) {
    assert.equal((await makeWorker({ fetchFn: async () => json(payload) }).fetch(request('/history/AC?range=1m'), ENV)).status, 502);
  }
  const response = await makeWorker({ fetchFn: async () => json([]) }).fetch(request('/history/AC'), ENV);
  assert.deepEqual((await response.json()).points, []);
});

test('licensed PSEi uses its supplied source and freshness and never probes invented symbols', async () => {
  let upstreamCalls = 0;
  const worker = makeWorker({ fetchFn: async () => { upstreamCalls++; return json(QUOTE); } });
  const response = await worker.fetch(request('/index/PSEI'), { ...ENV, EODHD_TOKEN: undefined, MARKET_DATA: kv({ 'index:PSEI': { ...index, privateNotes: TOKEN } }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.quote.source, index.source);
  assert.equal(body.quote.valueType, 'index_level');
  assert.equal(body.quote.freshness, 'delayed');
  assert.equal(body.quote.delayMinutes, 20);
  assert.equal(upstreamCalls, 0);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
});

test('missing or malformed licensed sources return unavailable', async () => {
  const worker = makeWorker();
  for (const path of ['/index/PSEI', '/history/PSEI', '/funds', '/funds/approved-equity/history']) {
    assert.equal((await worker.fetch(request(path), ENV)).status, 503, path);
    assert.equal((await worker.fetch(request(path), { ...ENV, MARKET_DATA: kv({}) })).status, 503, path);
  }
  for (const bad of [{ ...index, source: undefined }, { ...index, value: null }, { ...index, asOf: null, marketDate: null }, { ...index, freshness: 'delayed', delayMinutes: null }]) assert.equal((await worker.fetch(request('/index/PSEI'), { ...ENV, MARKET_DATA: kv({ 'index:PSEI': bad }) })).status, 503);
});

test('index EOD source and calendar date stay explicit', async () => {
  const response = await makeWorker().fetch(request('/index/PSEI'), { ...ENV, MARKET_DATA: kv({ 'index:PSEI': { ...index, asOf: null, marketDate: '2026-10-08', freshness: 'eod', source: 'Licensed PSE EOD file' } }) });
  const body = await response.json();
  assert.equal(body.quote.freshness, 'eod');
  assert.equal(body.quote.delayMinutes, null);
  assert.equal(body.quote.asOf, null);
  assert.equal(body.quote.marketDate, '2026-10-08');
});

test('fund NAV provenance and valuation date stay separate from generated date', async () => {
  const response = await makeWorker().fetch(request('/funds'), { ...ENV, EODHD_TOKEN: undefined, MARKET_DATA: kv({ 'funds:list': { ...fundsEnvelope, funds: [{ ...fund, previousClose: null, privateNotes: TOKEN }] } }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.funds[0].valuationDate, '2026-10-08');
  assert.equal(body.generatedAt, '2026-10-09T08:00:00.000Z');
  assert.equal(body.funds[0].value, fund.value);
  assert.equal(body.funds[0].changePercent, null);
  assert.equal(body.funds[0].freshness, 'daily_nav');
  assert.equal(body.funds[0].source, fund.source);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
});

test('invalid fund category, id, source, NAV type or valuation date fails closed', async () => {
  const variations = [{ category: 'Unknown' }, { id: undefined }, { id: null }, { id: '../secret' }, { source: null }, { valueType: 'last_trade' }, { valuationDate: '2026-02-30' }, { currency: 'USD' }, { value: null }, { value: 0 }, { value: '0' }, { value: -1 }];
  for (const variation of variations) {
    const response = await makeWorker().fetch(request('/funds'), { ...ENV, MARKET_DATA: kv({ 'funds:list': { ...fundsEnvelope, funds: [{ ...fund, ...variation }] } }) });
    assert.equal(response.status, 503, JSON.stringify(variation));
  }
});

test('fund history must belong to catalog and preserves approved source', async () => {
  const marketData = kv({ 'funds:list': fundsEnvelope, 'history:approved-equity': { symbol: fund.id, source: 'Approved manager history', freshness: 'eod', points: [{ date: '2026-10-07', close: 3.4 }, { date: '2026-10-08', close: 3.4567 }] } });
  const worker = makeWorker();
  const env = { ...ENV, MARKET_DATA: marketData };
  const response = await worker.fetch(request('/funds/approved-equity/history?range=1m'), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, 'Approved manager history');
  assert.equal((await worker.fetch(request('/funds/unknown-fund/history'), env)).status, 404);
});

test('licensed PSEI history uses optional KV and never invented EODHD symbols', async () => {
  let calls = 0;
  const worker = makeWorker({ fetchFn: async () => { calls++; return json(QUOTE); } });
  const raw = { symbol: 'PSEI', points: [{ date: '2026-10-08', close: 7200 }, { date: '2026-10-06', close: 7100 }, { date: '2026-08-01', close: 6800 }], source: 'Licensed PSE index archive', freshness: 'eod' };
  const response = await worker.fetch(request('/history/PSEI?range=1w'), { ...ENV, EODHD_TOKEN: undefined, MARKET_DATA: kv({ 'history:PSEI': raw }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { symbol: 'PSEI', points: [{ date: '2026-10-06', close: 7100 }, { date: '2026-10-08', close: 7200 }], source: 'Licensed PSE index archive', freshness: 'eod' });
  assert.equal(calls, 0);
  for (const bad of [{ ...raw, symbol: 'AC' }, { ...raw, source: null }, { ...raw, freshness: 'real_time' }, { ...raw, points: [{ date: '2026-02-30', close: 0 }] }]) {
    assert.equal((await worker.fetch(request('/history/PSEI'), { ...ENV, MARKET_DATA: kv({ 'history:PSEI': bad }) })).status, 503);
  }
  assert.equal(calls, 0);
});

test('example or explicitly unapproved KV data cannot enter public routes', async () => {
  const worker = makeWorker({ fetchFn: async () => json({ ...QUOTE, code: 'FMETF.PSE' }) });
  const nav = { value: 110, valueType: 'NAVPS', valuationDate: '2026-10-08', source: 'Manager' };
  const indexHistory = { symbol: 'PSEI', points: [], source: 'Licensed archive', freshness: 'eod' };
  for (const flags of [{ mode: 'demo' }, { approvedForPublicDisplay: false }, { provenance: { approvedForPublicDisplay: false } }]) {
    for (const [path, key, raw] of [['/funds', 'funds:list', fundsEnvelope], ['/index/PSEI', 'index:PSEI', index], ['/history/PSEI', 'history:PSEI', indexHistory], ['/etf/FMETF', 'etf:FMETF:nav', nav]]) {
      assert.equal((await worker.fetch(request(path), { ...ENV, MARKET_DATA: kv({ [key]: { ...raw, ...flags } }) })).status, 503, path);
    }
    assert.equal((await worker.fetch(request('/funds'), { ...ENV, MARKET_DATA: kv({ 'funds:list': { ...fundsEnvelope, funds: [{ ...fund, ...flags }] } }) })).status, 503);
  }
});

test('fund history must carry matching identity, source, and EOD freshness', async () => {
  for (const raw of [{ symbol: 'wrong', source: 'Manager', freshness: 'eod', points: [] }, { symbol: fund.id, source: null, freshness: 'eod', points: [] }, { symbol: fund.id, source: 'Manager', freshness: 'real_time', points: [] }]) {
    const response = await makeWorker().fetch(request(`/funds/${fund.id}/history`), { ...ENV, MARKET_DATA: kv({ 'funds:list': fundsEnvelope, [`history:${fund.id}`]: raw }) });
    assert.equal(response.status, 503);
  }
});

test('ETF trading price and independently dated NAV remain separate', async () => {
  const nav = { value: 110.4567, valueType: 'NAVPS', asOf: '2026-10-08T10:00:00Z', valuationDate: '2026-10-08', source: 'Licensed ETF manager' };
  const worker = makeWorker({ fetchFn: async () => json({ ...QUOTE, code: 'FMETF.PSE', close: 112 }) });
  const response = await worker.fetch(request('/etf/FMETF'), { ...ENV, MARKET_DATA: kv({ 'etf:FMETF:nav': nav }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.quote.assetType, 'etf');
  assert.equal(body.quote.valueType, 'last_trade');
  assert.equal(body.quote.value, 112);
  assert.equal(body.nav.value, 110.4567);
  assert.equal(body.nav.valueType, 'NAVPS');
  assert.equal(body.nav.valuationDate, '2026-10-08');
  assert.equal(body.nav.source, 'Licensed ETF manager');
});

test('ETF missing NAV is explicit null while malformed supplied NAV fails closed', async () => {
  const worker = makeWorker({ fetchFn: async () => json({ ...QUOTE, code: 'FMETF.PSE' }) });
  const noNav = await worker.fetch(request('/etf/FMETF'), ENV);
  assert.equal(noNav.status, 200);
  assert.equal((await noNav.json()).nav, null);
  assert.equal((await worker.fetch(request('/etf/FMETF'), { ...ENV, MARKET_DATA: kv({ 'etf:FMETF:nav': { value: 0 } }) })).status, 503);
  for (const value of [null, 0, '0', -1]) {
    const nav = { value, valueType: 'NAVPS', valuationDate: '2026-10-08', source: 'Manager' };
    assert.equal((await worker.fetch(request('/etf/FMETF'), { ...ENV, MARKET_DATA: kv({ 'etf:FMETF:nav': nav }) })).status, 503);
  }
});

test('cache failure is recoverable and waitUntil receives only safe normalized response', async () => {
  const pending = [];
  const cache = { match: async () => { throw new Error(TOKEN); }, put: async (key, response) => { assert.ok(!(await response.text()).includes(TOKEN)); throw new Error(TOKEN); } };
  const response = await makeWorker({ cache }).fetch(request('/quotes?symbols=AC'), ENV, { waitUntil: promise => pending.push(promise) });
  assert.equal(response.status, 200);
  await Promise.all(pending);
});

test('optional platform rate limiting rejects without upstream access', async () => {
  let calls = 0;
  const worker = makeWorker({ fetchFn: async () => { calls++; return json(QUOTE); } });
  const response = await worker.fetch(request('/quotes?symbols=AC', { headers: { 'CF-Connecting-IP': '192.0.2.1' } }), { ...ENV, RATE_LIMITER: { limit: async ({ key }) => { assert.equal(key, '192.0.2.1'); return { success: false }; } } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '30');
  assert.equal(calls, 0);
});

test('catalog returns actual provider symbols beyond the reference list and uses fixed authenticated exchange endpoint', async () => {
  let calls = 0;
  const extra = { Code: 'PGOLD', Name: 'Puregold Price Club, Inc.', Type: 'Common Stock', Currency: 'PHP', Exchange: 'PSE', Sector: 'Consumer Staples', privateNotes: TOKEN };
  const worker = makeWorker({ catalogFetchFn: async (value, options) => {
    calls++;
    const url = new URL(value);
    assert.equal(url.origin, 'https://eodhd.com');
    assert.equal(url.pathname, '/api/exchange-symbol-list/PSE');
    assert.equal(url.searchParams.get('api_token'), TOKEN);
    assert.equal(url.searchParams.get('fmt'), 'json');
    assert.equal(url.searchParams.get('q'), null);
    assert.equal(options.redirect, 'error');
    return json([...PROVIDER_CATALOG, extra]);
  } });
  const response = await worker.fetch(request('/catalog'), ENV);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.instruments.length, 21);
  assert.equal(body.source, 'EODHD');
  assert.equal(body.asOf, '2026-10-09T08:00:00.000Z');
  assert.deepEqual(body.instruments.find(instrument => instrument.symbol === 'PGOLD'), { symbol: 'PGOLD', name: extra.Name, assetType: 'stock', currency: 'PHP', sector: extra.Sector });
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  assert.equal(calls, 1);
});

test('catalog search matches names and symbols case-insensitively with a 30-result bound', async () => {
  const rows = Array.from({ length: 45 }, (_, id) => ({ Code: `T${String(id).padStart(2, '0')}`, Name: `Catalog Test Company ${id}`, Type: 'Common Stock', Currency: 'PHP', Exchange: 'PSE' }));
  let calls = 0;
  const worker = makeWorker({ catalogFetchFn: async () => { calls++; return json(rows); } });
  const all = await worker.fetch(request('/catalog'), ENV);
  assert.equal((await all.json()).instruments.length, 45);
  const search = await worker.fetch(request('/catalog?q=company', { origin: ORIGIN_B }), ENV);
  assert.equal((await search.json()).instruments.length, 30);
  assert.equal(search.headers.get('Access-Control-Allow-Origin'), ORIGIN_B);
  const exact = await worker.fetch(request('/catalog?q=t42'), ENV);
  assert.equal((await exact.json()).instruments[0].symbol, 'T42');
  const none = await worker.fetch(request('/catalog?q=nonexistent'), ENV);
  assert.deepEqual((await none.json()).instruments, []);
  assert.equal(calls, 1);
});

test('catalog input is bounded and does not accept arbitrary provider URLs or duplicate parameters', async () => {
  let calls = 0;
  const worker = makeWorker({ catalogFetchFn: async () => { calls++; return json(PROVIDER_CATALOG); } });
  for (const path of ['/catalog?q=', '/catalog?q=%20%20', `/catalog?q=${'x'.repeat(81)}`, '/catalog?q=AC&q=BDO', '/catalog?url=https://evil.test', '/catalog?q=https://evil.test', '/catalog?q=%3Cscript%3E', '/catalog?api_token=attacker']) assert.equal((await worker.fetch(request(path), ENV)).status, 400, path);
  assert.equal(calls, 0);
});

test('dynamic quotes and history verify catalog membership before contacting price endpoints', async () => {
  const rows = [...PROVIDER_CATALOG, { Code: 'PGOLD', Name: 'Puregold Price Club, Inc.', Type: 'Common Stock', Currency: 'PHP' }, { Code: '2GO', Name: '2GO Group', Type: 'Common Stock', Currency: 'PHP' }, { Code: 'ABC-P', Name: 'Catalog Preferred Share', Type: 'Preferred Stock', Currency: 'PHP' }, { Code: 'ABC.A', Name: 'Catalog Class A Share', Type: 'Common Stock', Currency: 'PHP' }];
  let quoteCalls = 0;
  const worker = makeWorker({ catalogFetchFn: async () => json(rows), fetchFn: async value => {
    const url = new URL(value);
    quoteCalls++;
    if (url.pathname.includes('/eod/')) return json([{ date: '2026-10-08', close: 30 }]);
    const code = url.pathname.split('/').at(-1);
    return json({ ...QUOTE, code });
  } });
  const response = await worker.fetch(request('/quotes?symbols=PGOLD'), ENV);
  assert.equal(response.status, 200);
  const quote = (await response.json()).quotes[0];
  assert.equal(quote.name, 'Puregold Price Club, Inc.');
  assert.equal(quote.assetType, 'stock');
  for (const symbol of ['2GO', 'ABC-P', 'ABC.A']) assert.equal((await worker.fetch(request(`/quotes?symbols=${symbol}`), ENV)).status, 200);
  assert.equal((await worker.fetch(request('/history/PGOLD?range=1m'), ENV)).status, 200);
  const callsBeforeUnknown = quoteCalls;
  for (const path of ['/quotes?symbols=UNKNOWN', '/history/UNKNOWN']) {
    const unknown = await worker.fetch(request(path), ENV);
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error.code, 'unknown_symbol');
  }
  assert.equal(quoteCalls, callsBeforeUnknown);
});

test('reference symbols are fallback only during catalog outages and never presented as a provider catalog', async () => {
  let calls = 0;
  const worker = makeWorker({ catalogFetchFn: async () => new Response('outage', { status: 503 }), fetchFn: async () => { calls++; return json(QUOTE); } });
  assert.equal((await worker.fetch(request('/catalog'), ENV)).status, 502);
  assert.equal((await worker.fetch(request('/quotes?symbols=AC'), ENV)).status, 200);
  const unknown = await worker.fetch(request('/quotes?symbols=PGOLD'), ENV);
  assert.equal(unknown.status, 503);
  assert.equal((await unknown.json()).error.code, 'catalog_unavailable');
  assert.equal(calls, 1);
});

test('catalog rejects duplicate identities, malformed records, and foreign exchange metadata', async () => {
  for (const rows of [[], {}, [PROVIDER_CATALOG[0], PROVIDER_CATALOG[0]], [{ ...PROVIDER_CATALOG[0], Code: '../evil' }], [{ ...PROVIDER_CATALOG[0], Name: null }], [{ ...PROVIDER_CATALOG[0], Exchange: 'US' }]]) {
    const response = await makeWorker({ catalogFetchFn: async () => json(rows) }).fetch(request('/catalog'), ENV);
    assert.equal(response.status, 502);
  }
  const worker = makeWorker({ catalogFetchFn: async () => json([...PROVIDER_CATALOG, { Code: 'FOREIGN', Name: 'Excluded currency', Type: 'Common Stock', Currency: 'USD' }, { Code: 'INDEX', Name: 'Excluded index', Type: 'Index', Currency: 'PHP' }]) });
  assert.equal((await (await worker.fetch(request('/catalog'), ENV)).json()).instruments.length, 20);
});

test('approved KV catalog preserves real source/date and can work without an EODHD token', async () => {
  let calls = 0;
  const raw = { instruments: [{ symbol: 'PGOLD', name: 'Puregold Price Club, Inc.', assetType: 'stock', currency: 'PHP' }], source: 'PSE', asOf: '2026-10-08T08:00:00Z', provenance: { approvedForPublicDisplay: true } };
  const worker = makeWorker({ catalogFetchFn: async () => { calls++; return json(PROVIDER_CATALOG); } });
  const response = await worker.fetch(request('/catalog'), { ...ENV, EODHD_TOKEN: undefined, MARKET_DATA: kv({ 'catalog:PSE': raw }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, 'PSE');
  assert.equal(body.asOf, '2026-10-08T08:00:00.000Z');
  assert.deepEqual(body.instruments, raw.instruments);
  assert.equal(calls, 0);
  for (const flags of [{ mode: 'demo' }, { source: null }, { approvedForPublicDisplay: false }, { provenance: { approvedForPublicDisplay: false } }, { asOf: '2026-02-30T00:00:00Z' }, { asOf: '2026-10-10T00:00:00Z' }]) assert.equal((await worker.fetch(request('/catalog'), { ...ENV, MARKET_DATA: kv({ 'catalog:PSE': { ...raw, ...flags } }) })).status, 503);
});

test('catalog cache is origin neutral, lasts at most 24h, and revalidates after expiration', async () => {
  const cache = new MemoryCache();
  let current = NOW;
  let calls = 0;
  const options = { cache, now: () => current, catalogFetchFn: async () => { calls++; return json(PROVIDER_CATALOG); } };
  const first = makeWorker(options);
  assert.equal((await first.fetch(request('/catalog'), ENV)).status, 200);
  const [stored] = cache.entries.values();
  assert.equal(stored.headers.get('Cache-Control'), 'public, max-age=86400');
  assert.equal(stored.headers.get('Access-Control-Allow-Origin'), null);
  current += 23 * 3600 * 1000;
  const nextIsolate = makeWorker(options);
  const hit = await nextIsolate.fetch(request('/catalog', { origin: ORIGIN_B }), ENV);
  assert.equal(hit.headers.get('Access-Control-Allow-Origin'), ORIGIN_B);
  assert.equal(calls, 1);
  current += 2 * 3600 * 1000;
  assert.equal((await nextIsolate.fetch(request('/catalog'), ENV)).status, 200);
  assert.equal(calls, 2);
  assert.equal((await nextIsolate.fetch(request('/catalog'), { ...ENV, PUBLIC_DISPLAY_LICENSED: 'false' })).status, 503);
});

test('catalog rate limit backs off without consuming another quote/catalog request and config failures propagate', async () => {
  let catalogCalls = 0;
  let quoteCalls = 0;
  const worker = makeWorker({ catalogFetchFn: async () => { catalogCalls++; return new Response(TOKEN, { status: 429, headers: { 'Retry-After': '120' } }); }, fetchFn: async () => { quoteCalls++; return json(QUOTE); } });
  for (const path of ['/catalog', '/quotes?symbols=AC', '/history/AC']) {
    const response = await worker.fetch(request(path), ENV);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '120');
    assert.ok(!(await response.text()).includes(TOKEN));
  }
  assert.equal(catalogCalls, 1);
  assert.equal(quoteCalls, 0);
  for (const status of [401, 403]) {
    const response = await makeWorker({ catalogFetchFn: async () => new Response(TOKEN, { status }) }).fetch(request('/quotes?symbols=AC'), ENV);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'service_configuration');
  }
});

test('malformed and future provider timestamps fail instead of presenting invalid source times', async () => {
  for (const timestamp of ['not-a-time', NOW / 1000 + 3600, -1, '2026-02-30', 3.5]) {
    const response = await makeWorker({ fetchFn: async () => json({ ...QUOTE, timestamp }) }).fetch(request('/quotes?symbols=AC'), ENV);
    assert.equal(response.status, 502);
  }
  for (const asOf of ['2026-02-30T00:00:00Z', 'not-a-time', '2026-10-10T00:00:00Z']) {
    const response = await makeWorker().fetch(request('/index/PSEI'), { ...ENV, MARKET_DATA: kv({ 'index:PSEI': { ...index, asOf } }) });
    assert.equal(response.status, 503);
  }
});

test('private local license bypass requires explicit option, confirmation, and loopback URL', async () => {
  const localEnv = { ...ENV, PUBLIC_DISPLAY_LICENSED: 'false', PRIVATE_LOCAL_USE_CONFIRMED: 'true' };
  const local = makeWorker({ privateLocalUse: true });
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const response = await local.fetch(new Request(`http://${host}/quotes?symbols=AC`), localEnv);
    assert.equal(response.status, 200, host);
  }
  const defaultWorker = makeWorker();
  assert.equal((await defaultWorker.fetch(new Request('http://localhost/catalog'), localEnv)).status, 503);
  assert.equal((await local.fetch(new Request('http://localhost/catalog'), { ...localEnv, PRIVATE_LOCAL_USE_CONFIRMED: 'false' })).status, 503);
  assert.equal((await local.fetch(new Request('http://localhost/catalog'), { ...localEnv, PRIVATE_LOCAL_USE_CONFIRMED: true })).status, 503);
  for (const host of ['gateway.example', 'localhost.evil.test', '127.0.0.2']) assert.equal((await local.fetch(new Request(`http://${host}/catalog`), localEnv)).status, 503);
  assert.equal((await local.fetch(new Request('http://localhost/quotes?symbols=AC'), { ...localEnv, EODHD_TOKEN: '' })).status, 503);
  assert.equal((await local.fetch(new Request('http://localhost/quotes?symbols=AC', { headers: { Origin: 'https://evil.test' } }), localEnv)).status, 403);
});
