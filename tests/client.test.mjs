import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketApi, DataError, requestJson, validateApiUrl, normalizeStockSymbol } from '../site/src/api.js';
import { saveCache, loadCache, readStorage, writeStorage } from '../site/src/cache.js';
import { number, percent, date, timestamp, freshness, filterPoints, csvCell } from '../site/src/format.js';

function browserMocks(t, { online = true, fetch = undefined, storageThrows = false } = {}) {
  const originals = new Map(['localStorage', 'navigator', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const stored = new Map();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: online } });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key) { if (storageThrows) throw new Error('Storage blocked'); return stored.get(key) ?? null; },
      setItem(key, value) { if (storageThrows) throw new Error('Storage blocked'); stored.set(key, String(value)); }
    }
  });
  if (fetch) Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: fetch });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return stored;
}

const sample = {
  mode: 'demo', generatedAt: '2026-10-09T08:00:00Z',
  index: { symbol: 'PSEI', value: 6500, freshness: 'demo' },
  quotes: [{ symbol: 'AC', value: 620, freshness: 'demo' }],
  funds: [], etfs: [],
  histories: { AC: [{ date: '2026-10-08', close: 610 }, { date: '2026-10-09', close: 620 }] }
};

test('a gateway URL accepts HTTPS and local development but rejects credentials and token query strings', () => {
  assert.equal(validateApiUrl('https://market.example/api/'), 'https://market.example/api');
  assert.equal(validateApiUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(validateApiUrl('http://localhost:8787/'), 'http://localhost:8787');
  for (const value of [
    'http://market.example', 'file:///tmp/data.json', 'javascript:alert(1)',
    'https://user:token@market.example', 'https://market.example?api_token=secret', 'https://market.example#secret'
  ]) assert.throws(() => validateApiUrl(value), undefined, value);
});

test('missing financial values remain unavailable, and zero remains a legitimate value', () => {
  for (const value of [null, undefined, NaN, Infinity, '0']) assert.equal(number(value), '—');
  assert.equal(number(0), '0.00');
  assert.equal(percent(0), '0.00%');
  assert.equal(percent(1.2), '+1.20%');
  assert.equal(percent(-1.2), '−1.20%');
});

test('freshness distinguishes delayed quotes, missing/future/stale timestamps, daily NAV, and illustrative cache', () => {
  const now = Date.parse('2026-10-09T08:00:00Z');
  const quote = { assetType: 'stock', value: 100, freshness: 'delayed', delayMinutes: 20, asOf: '2026-10-09T07:40:00Z' };
  assert.match(freshness(quote, { now }), /20 min delayed/);
  assert.equal(freshness({ ...quote, asOf: '2026-10-09T06:00:00Z' }, { now }), 'Stale');
  assert.equal(freshness({ ...quote, asOf: null }, { now }), 'Stale');
  assert.equal(freshness({ ...quote, asOf: '2026-10-09T08:02:00Z' }, { now }), 'Stale');
  assert.equal(freshness(quote, { now, cached: true }), 'Cached · stale');
  assert.equal(freshness({ assetType: 'mutual_fund', value: 1.23, freshness: 'daily_nav', asOf: '2026-10-08T00:00:00Z' }, { now }), 'Daily NAV');
  assert.equal(freshness({ value: 100, freshness: 'demo' }, { now, cached: true }), 'Cached sample');
  assert.equal(freshness({ value: null, freshness: 'delayed', asOf: '2026-10-09T07:40:00Z' }, { now }), 'Unavailable');
  assert.equal(freshness(null, { now }), 'Unavailable');
});

test('public market snapshots keep their identity after the session ends and flag old source dates', () => {
  const now = Date.parse('2026-10-09T18:00:00+08:00');
  const quote = { value: 43.25, freshness: 'snapshot', asOf: '2026-10-09T14:50:00+08:00', source: 'PSE EDGE' };
  assert.equal(freshness(quote, { now }), 'Market snapshot');
  assert.equal(freshness(quote, { now, cached: true }), 'Cached market snapshot');
  assert.equal(freshness({ ...quote, asOf: '2026-10-01T14:50:00+08:00' }, { now }), 'Stale snapshot');
  assert.equal(freshness({ ...quote, asOf: '2026-10-10T14:50:00+08:00' }, { now }), 'Stale snapshot');
  assert.equal(freshness({ ...quote, freshness: 'eod' }, { now, cached: true }), 'Cached end of day');
});

test('a current source page timestamp never makes a suspended stock appear current', () => {
  const now = Date.parse('2026-10-09T18:00:00+08:00');
  const quote = { value: 38, freshness: 'snapshot', tradingStatus: 'Suspended', asOf: '2026-10-09T14:50:00+08:00' };
  assert.equal(freshness(quote, { now }), 'Suspended snapshot');
  assert.equal(freshness(quote, { now, cached: true }), 'Cached suspended snapshot');
  assert.equal(freshness({ ...quote, tradingStatus: undefined, freshness: 'suspended' }, { now }), 'Suspended snapshot');
});

test('Philippine dates preserve a NAV valuation date and display quotes in Manila time', () => {
  const expectedDate = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', day: '2-digit', month: 'short' }).format(new Date('2026-10-08T12:00:00+08:00'));
  assert.equal(date('2026-10-08'), expectedDate);
  const actual = timestamp('2026-10-08T18:30:00Z');
  const expectedTime = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', hour12: false }).format(new Date('2026-10-08T18:30:00Z'));
  assert.equal(actual, expectedTime + ' PHT');
  assert.match(actual, /02:30/);
  assert.equal(date('invalid-date'), 'Date unavailable');
  assert.equal(timestamp(null), 'Timestamp unavailable');
});

test('history excludes unavailable prices, retains legitimate zeros, and sorts before range selection', () => {
  const points = [
    { date: '2026-10-09', close: 120 }, { date: '2026-10-06', close: 0 },
    { date: '2026-08-01', close: 99 }, { date: '2026-10-08', close: null },
    { date: 'invalid', close: 110 }, { date: '2026-10-07', close: '112' }
  ];
  assert.deepEqual(filterPoints(points, '1w'), [{ date: '2026-10-06', close: 0 }, { date: '2026-10-09', close: 120 }]);
  assert.equal(filterPoints(points, '3m').length, 3);
  assert.deepEqual(filterPoints(null, '1y'), []);
});

test('CSV data quotes commas/quotes and prevents untrusted spreadsheet formulas', () => {
  assert.equal(csvCell('Ayala, Inc.'), '"Ayala, Inc."');
  assert.equal(csvCell('A "quoted" fund'), '"A ""quoted"" fund"');
  assert.equal(csvCell(null), '""');
  for (const value of ['=HYPERLINK("https://example.com")', '+1+1', '-1+1', '@SUM(1,1)', '\t=1', '\r=1', '\n=1', '  =1', ' \t+1']) {
    assert.ok(csvCell(value).startsWith('"\''), `Formula-prefixed value is escaped: ${JSON.stringify(value)}`);
  }
});

test('cache expiry and future saved dates prevent silently reusing invalid snapshots', t => {
  browserMocks(t);
  saveCache('fresh', sample);
  assert.deepEqual(loadCache('fresh').data, sample);
  writeStorage('expired', { savedAt: Date.now() - 31 * 60_000, data: sample });
  assert.equal(loadCache('expired'), null);
  writeStorage('future', { savedAt: Date.now() + 60_000, data: sample });
  assert.equal(loadCache('future'), null);
  writeStorage('malformed-date', { savedAt: '2026-10-09', data: sample });
  assert.equal(loadCache('malformed-date'), null);
});

test('denied browser storage remains usable and accurately reports save failure', t => {
  browserMocks(t, { storageThrows: true });
  assert.deepEqual(readStorage('watchlist', ['BDO']), ['BDO']);
  assert.equal(writeStorage('watchlist', ['AC']), false);
  assert.equal(loadCache('snapshot'), null);
});

test('offline sample cache retains illustrative identity and its history', async t => {
  browserMocks(t, { online: false });
  const api = new MarketApi({ mode: 'demo', apiBase: '' });
  saveCache(api.cacheKey, sample);
  const snapshot = await api.snapshot([{ symbol: 'AC' }]);
  assert.equal(snapshot.cached, true);
  assert.equal(snapshot.data.mode, 'demo');
  assert.equal(snapshot.error.message, 'Offline');
  assert.deepEqual((await api.history('AC', '1m')).points, sample.histories.AC);
});

test('gateway mode never substitutes another gateway or a sample cache during an outage', async t => {
  browserMocks(t, { online: false });
  saveCache('psedash:cache:demo:', sample);
  saveCache('psedash:cache:gateway:https://other.example', { mode: 'gateway', quotes: sample.quotes });
  const api = new MarketApi({ mode: 'gateway', apiBase: 'https://market.example' });
  await assert.rejects(api.snapshot([{ symbol: 'AC' }]), /Offline/);
  saveCache(api.cacheKey, { mode: 'gateway', quotes: [{ symbol: 'AC', value: 625, freshness: 'delayed' }] });
  const cached = await api.snapshot([{ symbol: 'AC' }]);
  assert.equal(cached.cached, true);
  assert.equal(cached.data.mode, 'gateway');
  assert.equal(cached.data.quotes[0].value, 625);
});

test('partial gateway responses preserve available stock quotes and report unavailable index/fund/ETF data', async t => {
  browserMocks(t, {
    fetch: async raw => new URL(String(raw)).pathname === '/quotes'
      ? new Response(JSON.stringify({ quotes: [{ symbol: 'AC', value: 620 }], generatedAt: '2026-10-09T08:00:00Z' }), { status: 200 })
      : new Response('{}', { status: 503 })
  });
  const snapshot = await new MarketApi({ mode: 'gateway', apiBase: 'https://market.example' }).snapshot([{ symbol: 'AC' }]);
  assert.equal(snapshot.data.mode, 'gateway');
  assert.deepEqual(snapshot.data.quotes, [{ symbol: 'AC', value: 620 }]);
  assert.equal(snapshot.data.index, null);
  assert.deepEqual(snapshot.data.funds, []);
  assert.deepEqual(snapshot.data.etfs, []);
  assert.deepEqual(snapshot.data.issues, ['PSEi unavailable', 'Fund NAVs unavailable', 'ETF NAV unavailable']);
});

test('an invalid sample dataset is rejected instead of presented as available quotes', async t => {
  browserMocks(t, { fetch: async () => new Response(JSON.stringify({ mode: 'gateway', quotes: [], index: null }), { status: 200 }) });
  await assert.rejects(new MarketApi({ mode: 'demo', apiBase: '' }).snapshot([]), /Sample dataset is invalid/);
});

test('configuration and rate-limit errors provide explicit status and a bounded Retry-After', async t => {
  let status = 429;
  browserMocks(t, { fetch: async () => new Response('{}', { status, headers: { 'Retry-After': '900' } }) });
  await assert.rejects(requestJson('https://market.example/quotes'), error => {
    assert.ok(error instanceof DataError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfter, 600);
    assert.match(error.message, /rate limit/);
    return true;
  });
  status = 403;
  await assert.rejects(requestJson('https://market.example/quotes'), error => error.status === 403 && /configuration/.test(error.message));
});

test('malformed successful responses expose a safe error rather than provider content', async t => {
  browserMocks(t, { fetch: async () => new Response('private-provider-token: secret-value', { status: 200 }) });
  await assert.rejects(requestJson('https://market.example/quotes'), error => {
    assert.ok(error instanceof DataError);
    assert.equal(error.message, 'Data service returned an invalid response.');
    assert.ok(!error.message.includes('secret-value'));
    return true;
  });
});

test('a gateway configuration error on503 preserves the known failure code', async t => {
  browserMocks(t, { fetch: async () => new Response(JSON.stringify({ error: { code: 'service_configuration', message: 'Private configuration details' } }), { status: 503 }) });
  await assert.rejects(requestJson('https://market.example/quotes'), error => error.status === 503 && error.code === 'service_configuration' && error.message === 'Data service configuration error.');
});

test('gateway history falls back only to the selected instrument and range cache', async t => {
  browserMocks(t, { fetch: async () => { throw new TypeError('Network unavailable'); } });
  const api = new MarketApi({ mode: 'gateway', apiBase: 'https://market.example' });
  const history = { symbol: 'AC', points: [{ date: '2026-10-09', close: 620 }], source: 'Licensed provider' };
  saveCache(`${api.cacheKey}:history:AC:1m`, history);
  assert.deepEqual(await api.history('AC', '1m'), { ...history, cached: true });
  await assert.rejects(api.history('BDO', '1m'), /Network unavailable/);
  await assert.rejects(api.history('AC', '1y'), /Network unavailable/);
});

const providerCatalog = [
  { symbol: 'AREIT', name: 'AREIT, Inc.', assetType: 'stock', currency: 'PHP' },
  { symbol: 'DNL', name: 'D&L Industries, Inc.', assetType: 'stock', currency: 'PHP' },
  { symbol: 'SPNEC', name: 'SP New Energy Corporation', assetType: 'stock', currency: 'PHP' }
];

function fixtureQuote(symbol, metadata = {}) {
  return {
    ...metadata, symbol, name: metadata.name || `${symbol} test instrument`,
    assetType: metadata.assetType || 'stock', currency: 'PHP', valueType: 'last_trade',
    value: 43.25, previousClose: 43, change: 0.25, changePercent: 0.58,
    volume: 1200, asOf: '2026-10-09T07:40:00Z', marketDate: '2026-10-09',
    freshness: 'delayed', delayMinutes: 20, source: 'Fixture provider · testing only'
  };
}

test('provider catalog lookup finds stocks outside the bundled sample list', async t => {
  const requested = [];
  browserMocks(t, { fetch: async raw => {
    const url = new URL(String(raw)); requested.push(url);
    assert.equal(url.pathname, '/catalog');
    return new Response(JSON.stringify({ instruments: providerCatalog, source: 'Fixture reference data · testing only', asOf: '2026-10-09T08:00:00Z' }), { status: 200 });
  } });
  const api = new MarketApi({ mode: 'gateway', apiBase: 'https://market.example' });
  const result = await api.catalog();
  assert.deepEqual(result.instruments, providerCatalog);
  assert.ok(result.instruments.some(instrument => instrument.symbol === 'AREIT'));
  assert.equal(requested.length, 1);
});

test('adding a provider-resolved stock requests its own quote and retains provider timestamps', async t => {
  const requested = [];
  browserMocks(t, { fetch: async raw => {
    const url = new URL(String(raw)); requested.push(url);
    assert.equal(url.pathname, '/quotes');
    assert.equal(url.searchParams.get('symbols'), 'AREIT');
    return new Response(JSON.stringify({ quotes: [fixtureQuote('AREIT', providerCatalog[0])] }), { status: 200 });
  } });
  const quote = await new MarketApi({ mode: 'gateway', apiBase: 'https://market.example' }).quote('AREIT', providerCatalog[0]);
  assert.equal(quote.symbol, 'AREIT');
  assert.equal(quote.value, 43.25);
  assert.equal(quote.name, 'AREIT, Inc.');
  assert.equal(quote.asOf, '2026-10-09T07:40:00Z');
  assert.equal(quote.source, 'Fixture provider · testing only');
  assert.equal(requested.length, 1);
});

test('more than twenty displayed securities are split into bounded sequential quote batches', async t => {
  const instruments = Array.from({ length: 53 }, (_, index) => ({ symbol: `S${String(index + 1).padStart(3, '0')}`, name: `Test security ${index + 1}`, assetType: 'stock', currency: 'PHP' }));
  const batches = [];
  let activeQuotes = 0, maxActiveQuotes = 0;
  browserMocks(t, { fetch: async raw => {
    const url = new URL(String(raw));
    if (url.pathname === '/quotes') {
      const symbols = url.searchParams.get('symbols').split(','); batches.push(symbols);
      activeQuotes++; maxActiveQuotes = Math.max(maxActiveQuotes, activeQuotes);
      await new Promise(resolve => setTimeout(resolve, 2));
      activeQuotes--;
      return new Response(JSON.stringify({ generatedAt: '2026-10-09T08:00:00Z', quotes: symbols.map(symbol => fixtureQuote(symbol)) }), { status: 200 });
    }
    return new Response(JSON.stringify(url.pathname === '/funds' ? { funds: [] } : { quote: null, nav: null }), { status: 200 });
  } });
  const result = await new MarketApi({ mode: 'gateway', apiBase: 'https://market.example' }).snapshot(instruments);
  assert.ok(batches.length >= 3);
  assert.ok(batches.every(batch => batch.length > 0 && batch.length <= 20), `Every request stays within twenty symbols: ${batches.map(batch => batch.length)}`);
  assert.equal(maxActiveQuotes, 1, 'Quote batches avoid sending simultaneous large bursts');
  assert.deepEqual(batches.flat(), instruments.map(instrument => instrument.symbol));
  assert.equal(result.data.quotes.length, 53);
});

test('stock symbol normalization accepts actual ticker syntax while rejecting paths and query injection', () => {
  assert.equal(normalizeStockSymbol(' areit.pse '), 'AREIT');
  assert.equal(normalizeStockSymbol('2go'), '2GO');
  for (const raw of [null, undefined, '', 'PSEI', '../AREIT', 'AC/BDO', 'AC?symbols=BDO', 'https://market.example', 'AC--BDO', 'AC..BDO']) {
    assert.throws(() => normalizeStockSymbol(raw), undefined, JSON.stringify(raw));
  }
});

test('an unconfigured data source returns no quotes or fictional history and makes no provider request', async t => {
  let requested = 0;
  browserMocks(t, { fetch: async () => { requested++; throw new Error('Unexpected network request'); } });
  const api = new MarketApi({ mode: 'unconfigured', apiBase: '' });
  const result = await api.snapshot(providerCatalog);
  assert.equal(result.data.mode, 'unconfigured');
  assert.equal(result.data.index, null);
  assert.deepEqual(result.data.quotes, []);
  assert.deepEqual(result.data.funds, []);
  assert.deepEqual(result.data.etfs, []);
  assert.deepEqual((await api.history('AREIT', '1m')).points, []);
  assert.deepEqual((await api.catalog('AREIT')).instruments, []);
  assert.equal(await api.quote('AREIT'), null);
  assert.equal(requested, 0);
});

test('unknown stock quotes and unavailable provider catalogs never create sample data', async t => {
  browserMocks(t, { fetch: async raw => new Response(JSON.stringify(new URL(String(raw)).pathname === '/quotes' ? { quotes: [] } : { error: { code: 'service_configuration' } }), { status: new URL(String(raw)).pathname === '/quotes' ? 200 : 503 }) });
  const api = new MarketApi({ mode: 'gateway', apiBase: 'https://market.example' });
  await assert.rejects(api.quote('AREIT'), /No quote is available/);
  await assert.rejects(api.catalog('AREIT'), error => error.code === 'service_configuration');
  assert.equal(api.demo, null);
});

test('explicit sample mode never fabricates a quote for a stock outside its sample dataset', async t => {
  browserMocks(t, { fetch: async () => new Response(JSON.stringify(sample), { status: 200 }) });
  const api = new MarketApi({ mode: 'demo', apiBase: '' });
  await api.snapshot([]);
  assert.equal(await api.quote('AREIT'), null);
  assert.deepEqual((await api.history('AREIT', '1m')).points, []);
});

test('the free public adapter preserves source timestamps and mirror coverage while leaving unsupported NAV data empty', async t => {
  const coverage = { type: 'mirror', count: 21, note: 'Only the listed mirror symbols are available.' };
  const officialSnapshotFixture = { ...fixtureQuote('AREIT', providerCatalog[0]), freshness: 'snapshot', delayMinutes: null, source: 'PSE EDGE via ph-stocks mirror', sourceUrl: 'https://raw.githubusercontent.com/zhameersheraz/ph-stocks/main/stocks.json', originalSourceUrl: 'https://edge.pse.com.ph/', asOf: '2026-10-09T14:50:00+08:00' };
  browserMocks(t, { fetch: async raw => {
    const path = new URL(String(raw)).pathname;
    assert.ok(path.startsWith('/api/public/'));
    const payload = path.endsWith('/catalog') ? { instruments: providerCatalog, source: 'PSE EDGE via ph-stocks mirror', coverage }
      : path.endsWith('/quotes') ? { quotes: [officialSnapshotFixture], coverage }
      : path.endsWith('/funds') ? { funds: [] }
      : { quote: null, nav: null };
    return new Response(JSON.stringify(payload), { status: 200 });
  } });
  const api = new MarketApi({ mode: 'gateway', apiBase: 'http://127.0.0.1:5180/api/public' });
  assert.ok((await api.catalog('AREIT')).instruments.some(instrument => instrument.symbol === 'AREIT'));
  const result = await api.snapshot([providerCatalog[0]]);
  assert.equal(result.data.quotes[0].source, 'PSE EDGE via ph-stocks mirror');
  assert.deepEqual(result.data.coverage, coverage);
  assert.equal(result.data.quotes[0].asOf, '2026-10-09T14:50:00+08:00');
  assert.equal(result.data.quotes[0].freshness, 'snapshot');
  assert.equal(result.data.quotes[0].delayMinutes, null);
  assert.deepEqual(result.data.funds, []);
  assert.deepEqual(result.data.etfs, []);
});
