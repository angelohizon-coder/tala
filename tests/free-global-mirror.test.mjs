import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreeGlobalMirror, parseCribleManifest, parseCribleUniverse, parseCribleBars, GLOBAL_MIRROR_BASE } from '../tools/free-global-mirror.mjs';
import { createFreeGlobal } from '../tools/free-global.mjs';

const NOW = Date.parse('2026-10-09T11:00:00Z');
const GENERATED = Date.parse('2026-10-09T06:58:00Z');
const manifestInput = () => ({ schema: 2, generated_at: GENERATED / 1000, universe_rows: 8, prices: { symbols: 6, max_date: '2026-10-09', shards: [{ file: 'prices-00.parquet', bytes: 128, min_symbol: '000001.SZ', max_symbol: 'ZZA.MU' }] } });
const universeRows = [
  { symbol: 'AAPL', name: 'Apple Inc.', currency: 'USD', exchange: 'NMS', country: 'US', delisted: false },
  { symbol: '0700.HK', name: 'Tencent Holding Ltd.', currency: 'HKD', exchange: 'HKG', country: 'CN', delisted: false },
  { symbol: 'VOD.L', name: 'Vodafone Group Public Limited Company', currency: 'GBP', exchange: 'LSE', country: 'GB', delisted: false },
  { symbol: 'SHOP.TO', name: 'Shopify Inc.', currency: 'CAD', exchange: 'TOR', country: 'CA', delisted: false },
  { symbol: 'WRONG', name: 'Wrong venue', currency: 'USD', exchange: 'LSE', country: 'US', delisted: false },
  { symbol: 'OLD', name: 'Delisted', currency: 'USD', exchange: 'NMS', delisted: true },
];
// Verified source-contract vectors are isolated from application fallback data.
const bars = [
  { symbol: 'AAPL', date: new Date('2026-10-07T00:00:00Z'), close: 336.6700134277344, volume: 34147900, source: 'yfinance' },
  { symbol: 'AAPL', date: new Date('2026-10-08T00:00:00Z'), close: 340.4200134277344, volume: 35279900, source: 'yfinance' },
];
const stock = parseCribleUniverse(universeRows).get('US:AAPL');

function fixture({ rows = bars, universe = universeRows, rangeHeaders = true, encoding = null, manifest = manifestInput() } = {}) {
  const requests = [];
  let reads = 0;
  const fetchFn = async (value, options = {}) => {
    const url = new URL(value); requests.push({ url, options });
    assert.equal(url.origin + '/crible/data/', GLOBAL_MIRROR_BASE);
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    assert.equal(url.search, '');
    if (url.pathname.endsWith('/manifest.json')) return new Response(JSON.stringify(manifest));
    assert.ok(['/crible/data/universe.parquet', '/crible/data/prices-00.parquet'].includes(url.pathname));
    if (options.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': '128' } });
    const match = /^bytes=(\d+)-(\d+)$/u.exec(options.headers.Range);
    assert.ok(match);
    const start = Number(match[1]), end = Number(match[2]), headers = { 'Content-Length': String(end - start + 1) };
    if (rangeHeaders) headers['Content-Range'] = `bytes ${start}-${end}/128`;
    if (encoding) headers['Content-Encoding'] = encoding;
    return new Response(new Uint8Array(end - start + 1), { status: 206, headers });
  };
  const readParquetFn = async options => {
    reads++;
    const footer = await options.file.slice(-8);
    assert.equal(footer.byteLength, 8);
    if (!options.filter) {
      assert.deepEqual(options.columns, ['symbol', 'name', 'exchange', 'currency', 'delisted']);
      return universe;
    }
    assert.deepEqual(options.columns, ['symbol', 'date', 'close', 'volume', 'source']);
    return rows.filter(row => row.symbol === options.filter.symbol.$eq);
  };
  return { fetchFn, readParquetFn, requests, get reads() { return reads; } };
}

function corsFixture({ type = 'cors', invalidUniverseMagic = false, invalidPriceMagic = false, malformedRange = false, extraRangeByte = false, universeLength = 128 } = {}) {
  const requests = [];
  const binary = length => { const bytes = new Uint8Array(length); bytes.set([80, 65, 82, 49]); bytes.set([80, 65, 82, 49], length - 4); return bytes; };
  const response = (body, init) => { const result = new Response(body, init); Object.defineProperty(result, 'type', { value: type }); return result; };
  const fetchFn = async (value, options = {}) => {
    const url = new URL(value); requests.push({ url, options }); assert.equal(url.origin + '/crible/data/', GLOBAL_MIRROR_BASE);
    if (url.pathname.endsWith('/manifest.json')) return response(JSON.stringify(manifestInput()));
    const universe = url.pathname.endsWith('/universe.parquet');
    if (options.method === 'HEAD') return response(null, { headers: { 'Content-Length': '96' } });
    const bytes = binary(universe ? universeLength : 128);
    if (universe && invalidUniverseMagic || !universe && invalidPriceMagic) bytes[bytes.length - 1] = 0;
    if (!options.headers.Range) { assert.equal(universe, true); return response(bytes, { headers: { 'Content-Length': '96' } }); }
    const match = /^bytes=(\d+)-(\d+)$/u.exec(options.headers.Range), start = Number(match[1]), end = Number(match[2]);
    const headers = { 'Content-Length': String(end - start + 1) };
    if (malformedRange) headers['Content-Range'] = `bytes ${start + 1}-${end + 1}/128`;
    const body = extraRangeByte ? new Uint8Array(end - start + 2) : bytes.slice(start, end + 1);
    return response(body, { status: 206, headers });
  };
  const readParquetFn = async options => {
    assert.equal(options.file.byteLength, 128, 'decoded universe length replaces compressed HEAD size');
    assert.equal((await options.file.slice(-8)).byteLength, 8);
    return options.filter ? bars : universeRows;
  };
  return { fetchFn, readParquetFn, requests };
}

test('manifest accepts published schema and rejects arbitrary shard URLs, overlapping ranges and future collection', () => {
  assert.equal(parseCribleManifest(manifestInput(), NOW).generatedAt, '2026-10-09T06:58:00.000Z');
  for (const mutate of [raw => { raw.prices.shards[0].file = 'https://evil.test/prices.parquet'; }, raw => { raw.prices.shards[0].bytes = 0; }, raw => { raw.generated_at = NOW / 1000 + 3600; }, raw => { raw.prices.max_date = '2026-02-30'; }, raw => { raw.prices.shards.push({ ...raw.prices.shards[0], file: 'prices-01.parquet' }); }]) {
    const raw = manifestInput(); mutate(raw); assert.throws(() => parseCribleManifest(raw, NOW));
  }
});

test('listing exchange and exact currency identify instruments independently of company domicile', () => {
  const instruments = parseCribleUniverse(universeRows);
  assert.equal(instruments.get('HK:0700').currency, 'HKD');
  assert.equal(instruments.get('HK:0700').ticker, '0700.HK');
  assert.equal(instruments.get('US:AAPL').name, 'Apple Inc.');
  assert.equal(instruments.has('US:WRONG'), false);
  assert.equal(instruments.has('US:OLD'), false);
});

test('completed daily closes retain calendar dates and omit collection-day bars even after the day has ended', () => {
  const input = [...bars, { symbol: 'AAPL', date: new Date('2026-10-09T00:00:00Z'), close: 999, volume: 1, source: 'yfinance' }];
  const result = parseCribleBars(input, stock, parseCribleManifest(manifestInput(), NOW), Date.parse('2026-10-10T11:00:00Z'));
  assert.deepEqual(result.map(bar => bar.date), ['2026-10-07', '2026-10-08']);
  const corrupted = [...bars, { ...bars[0], close: 0 }];
  assert.throws(() => parseCribleBars(corrupted, stock, parseCribleManifest(manifestInput(), NOW), NOW));
  assert.throws(() => parseCribleBars([{ ...bars[0], symbol: 'MSFT' }], stock, parseCribleManifest(manifestInput(), NOW), NOW));
});

test('ambiguous London pounds versus pence are unavailable; explicit pence normalizes consistently', () => {
  const published = parseCribleManifest(manifestInput(), NOW);
  const gb = parseCribleUniverse(universeRows).get('GB:VOD');
  const input = [{ symbol: 'VOD.L', date: '2026-10-02', close: 126.55, volume: 52629315, source: 'stooq' }];
  assert.throws(() => parseCribleBars(input, gb, published, NOW), error => error.code === 'unit_unavailable');
  assert.equal(parseCribleBars(input, { ...gb, sourceCurrency: 'GBp' }, published, NOW)[0].close, 1.2655);
});

test('mirror quote and history share exact source closes, date-only precision and verified HTTP ranges', async () => {
  const data = fixture(), mirror = createFreeGlobalMirror({ ...data, now: () => NOW });
  const quote = await mirror.quote('US:AAPL');
  assert.equal(quote.value, 340.4200134277344);
  assert.equal(quote.previousClose, 336.6700134277344);
  assert.equal(quote.volume, 35279900);
  assert.equal(quote.valueType, 'daily_close');
  assert.equal(quote.asOf, '2026-10-08');
  assert.equal(quote.marketDate, '2026-10-08');
  assert.equal(quote.timestampPrecision, 'date');
  assert.equal(quote.source, 'Crible daily mirror · yfinance');
  assert.equal(quote.mirrorGeneratedAt, '2026-10-09T06:58:00.000Z');
  assert.equal(quote.freshness, 'eod');
  const history = await mirror.history('US:AAPL', '1m');
  assert.deepEqual(history.points, bars.map(bar => ({ date: bar.date.toISOString().slice(0, 10), close: bar.close })));
  assert.equal(history.cached, true);
  assert.equal(history.points.at(-1).close, quote.value);
  assert.equal(data.reads, 2, 'universe and requested price series are cached');
  const search = await mirror.catalog('US', 'Apple');
  assert.equal(search.instruments[0].symbol, 'US:AAPL');
  assert.equal(search.coverage.pricedSymbols, 6);
  assert.equal(search.instruments[0].value, undefined);
});

test('stale foreign prices cannot become current quotes; historical dates remain available with an explicit issue', async () => {
  const oldRows = [{ symbol: '0700.HK', date: '2026-07-24', close: 500, volume: null, source: 'yfinance' }];
  const mirror = createFreeGlobalMirror({ ...fixture({ rows: oldRows }), now: () => NOW });
  await assert.rejects(mirror.quote('HK:0700'), error => error.code === 'stale_source');
  const history = await mirror.history('HK:0700', '1y');
  assert.equal(history.points[0].date, '2026-07-24');
  assert.equal(history.issues[0].code, 'stale_source');
  await assert.rejects(mirror.quote('US:UNLISTED'), error => error.code === 'coverage_unavailable');
});

test('missing closes and volumes stay null and invalid binary encodings/ranges reject the source', async () => {
  const input = [{ ...bars[0], close: null, volume: null }, bars[1]];
  const mirror = createFreeGlobalMirror({ ...fixture({ rows: input }), now: () => NOW });
  const quote = await mirror.quote('US:AAPL');
  assert.equal(quote.previousClose, null);
  assert.equal(quote.change, null);
  const history = await mirror.history('US:AAPL', '1m');
  assert.equal(history.points[0].close, null);
  for (const options of [{ rangeHeaders: false }, { encoding: 'gzip' }]) {
    await assert.rejects(createFreeGlobalMirror({ ...fixture(options), now: () => NOW }).quote('US:AAPL'), error => error.code === 'source_changed');
  }
});

test('opt-in browser CORS uses decoded bounded universe and manifest-sized hidden-header ranges', async () => {
  const data = corsFixture(), mirror = createFreeGlobalMirror({ ...data, browserCors: true, now: () => NOW });
  const quote = await mirror.quote('US:AAPL'); assert.equal(quote.value, bars.at(-1).close); assert.equal(quote.asOf, '2026-10-08');
  const universeRequests = data.requests.filter(request => request.url.pathname.endsWith('/universe.parquet'));
  assert.equal(universeRequests.length, 2); assert.equal(universeRequests[0].options.method, 'HEAD'); assert.equal(universeRequests[1].options.headers.Range, undefined);
  const prices = data.requests.filter(request => request.url.pathname.endsWith('/prices-00.parquet'));
  assert.deepEqual(prices.map(request => request.options.headers.Range).sort(), ['bytes=0-3', 'bytes=120-127']);
  await mirror.history('US:AAPL', '1m'); assert.equal(data.requests.length, 5, 'verified whole universe and shard ranges remain cached');
});

test('browser range relaxation requires explicit opt-in and an actual CORS response', async () => {
  await assert.rejects(createFreeGlobalMirror({ ...corsFixture(), now: () => NOW }).quote('US:AAPL'), error => error.code === 'source_changed');
  await assert.rejects(createFreeGlobalMirror({ ...corsFixture({ type: 'basic' }), browserCors: true, now: () => NOW }).quote('US:AAPL'), error => error.code === 'source_changed');
});

test('browser CORS still rejects invalid magic, exposed wrong ranges, incorrect body lengths and oversized whole files', async () => {
  for (const options of [{ invalidUniverseMagic: true }, { invalidPriceMagic: true }, { malformedRange: true }, { extraRangeByte: true }, { universeLength: 8 * 1024 * 1024 + 1 }]) {
    await assert.rejects(createFreeGlobalMirror({ ...corsFixture(options), browserCors: true, now: () => NOW }).quote('US:AAPL'), error => error.code === 'source_changed');
  }
});

test('Yahoo transport failure opts into the dated mirror strategy and preserves safe per-symbol failures', async () => {
  let yahooCalls = 0, mirrorCalls = 0;
  const global = createFreeGlobal({ now: () => NOW, mirrorFallback: true, fetchFn: async () => { yahooCalls++; throw new Error('secret raw failure'); }, mirrorFactory: () => ({
    async quote(symbol) { mirrorCalls++; if (symbol === 'HK:0700') { const { GlobalMirrorError } = await import('../tools/free-global-mirror.mjs'); throw new GlobalMirrorError(503, 'stale_source', 'No recent verified close.'); } return { symbol, value: 340.42, asOf: '2026-10-08', timestampPrecision: 'date', valueType: 'daily_close', source: 'Crible daily mirror · yfinance' }; },
    async catalog(market, query) { return { instruments: [], market, query, source: 'Crible daily mirror' }; },
    async history(symbol) { return { symbol, points: [], source: 'Crible daily mirror', freshness: 'eod' }; },
  }) });
  const first = await (await global.handle(new Request('http://127.0.0.1/quotes?symbols=US:AAPL'))).json();
  assert.equal(first.quotes[0].timestampPrecision, 'date');
  assert.equal(yahooCalls, 2);
  const mixed = await (await global.handle(new Request('http://127.0.0.1/quotes?symbols=US:AAPL,HK:0700'))).json();
  assert.equal(mixed.quotes.length, 1);
  assert.equal(mixed.issues[0].code, 'stale_source');
  assert.equal(yahooCalls, 2, 'subsequent requests retain the 15-minute mirror strategy');
  assert.equal(mirrorCalls, 3);
  assert.equal(JSON.stringify(mixed).includes('secret'), false);
  const catalog = await (await global.handle(new Request('http://127.0.0.1/catalog?market=US&q=Apple'))).json();
  assert.equal(catalog.source, 'Crible daily mirror');
});
