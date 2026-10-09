import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreePse, parseEdgeQuote, parseEdgeIndex, parseEdgeTimestamp, parseEdgeDirectory, parseEdgeHistory, parseMirrorSnapshot, MIRROR_URL } from '../tools/free-pse.mjs';

const NOW = Date.parse('2026-10-09T09:05:00Z');
const instrument = { symbol: 'BDO', name: 'BDO Unibank, Inc.', assetType: 'stock', currency: 'PHP', companyId: '260', securityId: '468' };
const catalogRows = [instrument, { symbol: 'AREIT', name: 'AREIT, Inc.', companyId: '679', securityId: '692', assetType: 'stock' }, { symbol: 'FMETF', name: 'First Metro Philippine Equity Exchange Traded Fund', companyId: '649', securityId: '592', assetType: 'etf' }];
const quoteHtml = `<input name="cmpy_id" value="260"><select name="security_id"><option value="468" selected>BDO</option></select>
  <p>As of Oct 09, 2026 02:50 PM</p><table>
  <tr><th>Status</th><td>Open</td><th>Issue Type</th><td>Common</td></tr>
  <tr><th>Last Traded Price</th><td>113.00</td><th>Open</th><td>111.00</td><th>Previous Close and Date</th><td>111.00 (Oct 08, 2026)</td></tr>
  <tr><th>Change(% Change)</th><td><img alt="up" src="/images/up.png">2.00 (1.80%)</td></tr>
  <tr><th>Volume</th><td>2,376,950</td></tr></table>`;
const indexHtml = `<table><thead><tr><th>Index</th><th>Value</th><th>Chg</th><th>%Chg</th></tr></thead>
  <tbody><tr><td class="label">PSEi</td><td>5,700.99</td><td>90.60</td><td>1.62▲</td></tr></tbody></table><p>MARKET : CLOSED | As of Oct 9, 2026 5:00 PM</p>`;
function directory(rows, page = 1, pages = 1, total = rows.length) {
  return `<span class="count">[${page} / ${pages}] [Total ${total}]</span><table class="list"><thead><tr><th>Company Name</th><th>Stock Symbol</th><th>Sector</th><th>Subsector</th><th>Listing Date</th></tr></thead><tbody>${rows.map(row => `<tr><td><a onclick="cmDetail('${row.companyId}','${row.securityId}');return false;">${row.name}</a></td><td><a onclick="cmDetail('${row.companyId}','${row.securityId}');return false;">${row.symbol}</a></td><td>${row.assetType === 'etf' ? 'ETF' : 'Financials'}</td><td>Banks</td><td>May 21, 2002</td></tr>`).join('')}</tbody></table>`;
}
const request = path => new Request(`http://127.0.0.1${path}`);
const htmlResponse = html => new Response(html, { headers: { 'Content-Type': 'text/html' } });
const jsonResponse = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const adapter = options => createFreePse({ now: () => NOW, throttleMs: 0, ...options });

test('PSE source timestamps preserve Philippine time and reject impossible/future/missing dates', () => {
  assert.deepEqual(parseEdgeTimestamp(quoteHtml, NOW), { asOf: '2026-10-09T14:50:00+08:00', marketDate: '2026-10-09' });
  assert.equal(parseEdgeTimestamp('As of Oct 9, 2026 12:00 AM', NOW).asOf, '2026-10-09T00:00:00+08:00');
  for (const text of ['no timestamp', 'As of Feb 30, 2026 01:00 PM', 'As of Oct 10, 2026 01:00 PM', 'As of Oct 9, 2026 13:00 PM']) assert.throws(() => parseEdgeTimestamp(text, NOW));
});

test('stock HTML maps actual label pairs with independent timestamp and zero-safe numbers', () => {
  const { quote, companyId, securityId } = parseEdgeQuote(quoteHtml, instrument, NOW);
  assert.equal(quote.value, 113);
  assert.equal(quote.previousClose, 111);
  assert.equal(quote.change, 2);
  assert.equal(quote.changePercent, 1.8);
  assert.equal(quote.volume, 2376950);
  assert.equal(quote.source, 'PSE EDGE');
  assert.equal(quote.freshness, 'snapshot');
  assert.equal(quote.delayMinutes, null);
  assert.equal(quote.asOf, '2026-10-09T14:50:00+08:00');
  assert.equal(companyId, '260');
  assert.equal(securityId, '468');
  assert.equal(quote.marketStatus, undefined);
  const missing = parseEdgeQuote(quoteHtml.replace('113.00', '--').replace('111.00 (Oct 08, 2026)', '--').replace('2,376,950', '0'), instrument, NOW).quote;
  assert.equal(missing.value, null);
  assert.equal(missing.previousClose, null);
  assert.equal(missing.change, null);
  assert.equal(missing.volume, 0);
});

test('declines use direction markers rather than interpreting unsigned changes as gains', () => {
  const down = parseEdgeQuote(quoteHtml.replace('alt="up"', 'alt="down"').replace('up.png', 'down.png').replace('113.00', '109.00'), instrument, NOW).quote;
  assert.equal(down.change, -2);
  assert.equal(down.changePercent, -1.8);
  const index = parseEdgeIndex(indexHtml.replace('▲', '▼'), NOW);
  assert.equal(index.change, -90.6);
  assert.equal(index.changePercent, -1.62);
  assert.equal(index.previousClose, null);
});

test('quote parser refuses identity mismatches, malformed values, and missing expected labels', () => {
  assert.throws(() => parseEdgeQuote(quoteHtml.replace('value="260"', 'value="999"'), instrument, NOW));
  assert.throws(() => parseEdgeQuote(quoteHtml.replace('value="468"', 'value="999"'), instrument, NOW));
  assert.throws(() => parseEdgeQuote(quoteHtml.replace('Last Traded Price', 'Price Schema Changed'), instrument, NOW));
  assert.equal(parseEdgeQuote(quoteHtml.replace('113.00', 'not-a-number'), instrument, NOW).quote.value, null);
});

test('index quote uses actual index row, direction, and its own source timestamp', () => {
  const quote = parseEdgeIndex(indexHtml, NOW);
  assert.equal(quote.value, 5700.99);
  assert.equal(quote.change, 90.6);
  assert.equal(quote.changePercent, 1.62);
  assert.equal(quote.assetType, 'index');
  assert.equal(quote.valueType, 'index_level');
  assert.equal(quote.asOf, '2026-10-09T17:00:00+08:00');
  assert.throws(() => parseEdgeIndex(indexHtml.replace('▲', ''), NOW));
  assert.throws(() => parseEdgeIndex(indexHtml.replace('PSEi', 'Unknown'), NOW));
});

test('directory parser preserves actual company/security identities and count metadata', () => {
  const parsed = parseEdgeDirectory(directory(catalogRows));
  assert.equal(parsed.page, 1);
  assert.equal(parsed.pages, 1);
  assert.equal(parsed.total, 3);
  assert.equal(parsed.instruments.find(row => row.symbol === 'BDO').companyId, '260');
  assert.equal(parsed.instruments.find(row => row.symbol === 'BDO').securityId, '468');
  assert.equal(parsed.instruments.find(row => row.symbol === 'FMETF').assetType, 'etf');
  assert.throws(() => parseEdgeDirectory(directory(catalogRows).replaceAll("cmDetail('260','468')", "cmDetail('https://evil.test','468')")));
});

test('history preserves daily dates/null gaps, sorts, and collapses only identical duplicates', () => {
  const row = { CHART_DATE: 'Oct 08, 2026 00:00:00', CLOSE: 113 };
  assert.deepEqual(parseEdgeHistory({ chartData: [row, { CHART_DATE: 'Oct 07, 2026 00:00:00', CLOSE: null }, row] }, '2026-10-01', '2026-10-09'), [{ date: '2026-10-07', close: null }, { date: '2026-10-08', close: 113 }]);
  assert.throws(() => parseEdgeHistory({ chartData: [row, { ...row, CLOSE: 114 }] }, '2026-10-01', '2026-10-09'));
  assert.throws(() => parseEdgeHistory({ chartData: [{ CHART_DATE: 'Feb 30, 2026 00:00:00', CLOSE: 10 }] }, '2026-01-01', '2026-12-31'));
  assert.throws(() => parseEdgeHistory({ chartData: null }, '2026-10-01', '2026-10-09'));
});

test('complete directory pagination and search expose all issuer symbols without an API key', async () => {
  let calls = 0;
  const free = adapter({ fetchFn: async (value, options) => {
    calls++;
    const url = new URL(value);
    assert.equal(url.origin, 'https://edge.pse.com.ph');
    assert.equal(url.pathname, '/companyDirectory/search.ax');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
    const page = Number(new URLSearchParams(options.body).get('pageNo'));
    return htmlResponse(directory(page === 1 ? catalogRows.slice(0, 2) : catalogRows.slice(2), page, 2, 3));
  } });
  const result = await free.handle(request('/catalog'));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.instruments.length, 3);
  assert.equal(body.source, 'PSE EDGE');
  assert.ok(body.instruments.every(row => row.companyId === undefined && row.securityId === undefined));
  assert.equal(calls, 2);
  const search = await free.handle(request('/catalog?q=areit'));
  assert.deepEqual((await search.json()).instruments.map(row => row.symbol), ['AREIT']);
  assert.equal(calls, 2);
});

test('incomplete/repeated directory pages fail rather than claiming complete catalog coverage', async () => {
  for (const mode of ['same-page', 'missing-total', 'duplicate-symbol']) {
    const free = adapter({ fetchFn: async (url, options) => {
      const page = Number(new URLSearchParams(options.body).get('pageNo'));
      if (mode === 'same-page') return htmlResponse(directory(catalogRows.slice(0, 2), 1, 2, 3));
      if (mode === 'missing-total') return htmlResponse(directory(catalogRows.slice(0, 1), page, 1, 3));
      return htmlResponse(directory([catalogRows[0]], page, 2, 2));
    } });
    const response = await free.handle(request('/catalog'));
    assert.equal(response.status, 502, mode);
  }
});

test('quote/history endpoints send only validated source identities and real historical request format', async () => {
  const seen = [];
  const free = adapter({ fetchFn: async (value, options) => {
    const url = new URL(value); seen.push({ url, options });
    if (url.pathname === '/companyDirectory/search.ax') return htmlResponse(directory(catalogRows));
    if (url.pathname === '/companyPage/stockData.do') return htmlResponse(quoteHtml);
    if (url.pathname === '/common/DisclosureCht.ax') return jsonResponse({ chartData: [{ CHART_DATE: 'Oct 08, 2026 00:00:00', CLOSE: 113 }] });
    throw new Error('unexpected endpoint');
  } });
  const quotes = await free.handle(request('/quotes?symbols=BDO'));
  assert.equal(quotes.status, 200);
  assert.equal((await quotes.json()).quotes[0].value, 113);
  const history = await free.handle(request('/history/BDO?range=1w'));
  assert.deepEqual(await history.json(), { symbol: 'BDO', points: [{ date: '2026-10-08', close: 113 }], source: 'PSE EDGE', freshness: 'eod' });
  const chart = seen.find(row => row.url.pathname === '/common/DisclosureCht.ax');
  assert.equal(chart.options.method, 'POST');
  assert.equal(chart.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(chart.options.body), { cmpy_id: '260', security_id: '468', startDate: '10-02-2026', endDate: '10-09-2026' });
  assert.ok(seen.every(row => row.url.origin === 'https://edge.pse.com.ph' && !row.url.searchParams.has('api_token')));
  assert.equal(seen.filter(row => row.url.pathname === '/companyPage/stockData.do').length, 1);
});

test('invalid requests never reach source and unknown symbols never get a manufactured quote', async () => {
  let calls = 0;
  const free = adapter({ fetchFn: async () => { calls++; return htmlResponse(directory(catalogRows)); } });
  for (const path of ['/quotes', '/quotes?symbols=BDO,BDO', '/quotes?symbols=BDO.PSE', '/quotes?symbols=bdO', `/quotes?symbols=${Array.from({ length: 21 }, (_, i) => `T${i}`).join(',')}`, '/quotes?symbols=BDO&url=https://evil.test', '/history/BDO?range=bad', '/catalog?q=', '/catalog?q=A&q=B']) assert.equal((await free.handle(request(path))).status, 400, path);
  assert.equal(calls, 0);
  const unknown = await free.handle(request('/quotes?symbols=UNKNOWN'));
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, 'unknown_symbol');
  assert.equal(calls, 1);
});

test('source timeout, rate limit, and errors remain bounded and sanitized', async () => {
  const noResponse = adapter({ timeoutMs: 10, fetchFn: async () => new Promise(() => {}) });
  assert.equal((await noResponse.handle(request('/catalog'))).status, 504);
  let count = 0;
  const rateLimited = adapter({ fetchFn: async () => { count++; return new Response('private upstream details', { status: 429, headers: { 'Retry-After': '99999' } }); } });
  const first = await rateLimited.handle(request('/catalog'));
  assert.equal(first.status, 429);
  assert.equal(first.headers.get('Retry-After'), '300');
  const second = await rateLimited.handle(request('/catalog'));
  assert.equal(second.status, 429);
  assert.equal(count, 1);
  assert.ok(!(await first.text()).includes('private upstream details'));
  const bad = adapter({ fetchFn: async () => { throw new Error('server-private-secret'); } });
  const response = await bad.handle(request('/catalog'));
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('server-private-secret'));
});

test('missing mutual-fund NAV, ETF NAV, and index history stay explicit', async () => {
  const free = adapter({ fetchFn: async value => {
    const url = new URL(value);
    if (url.pathname === '/companyDirectory/search.ax') return htmlResponse(directory(catalogRows));
    if (url.pathname === '/companyPage/stockData.do') return htmlResponse(quoteHtml.replace('value="260"', 'value="649"').replace('value="468"', 'value="592"'));
    if (url.pathname === '/index/form.do') return htmlResponse(indexHtml);
    throw new Error('unexpected source');
  } });
  assert.deepEqual((await (await free.handle(request('/funds'))).json()).funds, []);
  const etf = await free.handle(request('/etf/FMETF'));
  assert.equal(etf.status, 200);
  assert.equal((await etf.json()).nav, null);
  assert.equal((await free.handle(request('/history/PSEI'))).status, 503);
  assert.equal((await free.handle(request('/index/PSEI'))).status, 200);
});

// Isolated contract vectors from the downloaded October 9 source, not app data.
const MIRROR_NOW = Date.parse('2026-10-09T11:00:00Z');
const mirrorRaw = {
  generated_utc: '2026-10-09 10:30:34', source: 'https://edge.pse.com.ph',
  stocks: [
    { symbol: 'BDO', name: 'BDO Unibank, Inc.', as_of: 'Oct 09, 2026 02:50 PM', status: 'Open', last_traded_price: 113, previous_close: 111, previous_close_date: 'Oct 08, 2026', change: 'up', change_amount: 2, change_pct: 1.8, volume: 2376950 },
    { symbol: 'SM', name: 'SM Investments Corporation', as_of: 'Oct 09, 2026 02:50 PM', status: 'Open', last_traded_price: 515, previous_close: 522.5, previous_close_date: 'Oct 08, 2026', change: 'down', change_amount: 7.5, change_pct: 1.44, volume: 422720 },
    { symbol: 'RRHI', name: 'Robinsons Retail Holdings, Inc.', as_of: 'Oct 09, 2026 02:50 PM', status: 'Suspended', last_traded_price: 38, previous_close: 38, previous_close_date: 'Jul 10, 2026' },
    { symbol: 'GTCAP', name: 'GT Capital Holdings, Inc.', as_of: 'Oct 09, 2026 02:50 PM', status: 'Open', last_traded_price: 439, previous_close: 418, previous_close_date: 'Oct 08, 2026', change: 'up', change_amount: 21, change_pct: 5.02, volume: 44300 },
  ],
  index: { as_of: 'Oct 9, 2026 5:00 PM', market_status: 'CLOSED', indices: [{ name: 'PSEi', value: 5700.99, change: 90.6, change_pct: 1.62 }] },
};

test('mirror contract preserves current source times, unsigned decline direction, and suspended price age', () => {
  const data = parseMirrorSnapshot(mirrorRaw, MIRROR_NOW);
  assert.equal(data.asOf, '2026-10-09T10:30:34.000Z');
  assert.equal(data.source, 'PSE EDGE via ph-stocks mirror');
  assert.equal(data.quotes.BDO.value, 113);
  assert.equal(data.quotes.BDO.asOf, '2026-10-09T14:50:00+08:00');
  assert.equal(data.quotes.SM.change, -7.5);
  assert.equal(data.quotes.SM.changePercent, -1.44);
  assert.equal(data.quotes.RRHI.value, 38);
  assert.equal(data.quotes.RRHI.tradingStatus, 'Suspended');
  assert.equal(data.quotes.RRHI.freshness, 'suspended');
  assert.equal(data.quotes.RRHI.marketDate, '2026-07-10');
  assert.equal(data.quotes.RRHI.previousCloseDate, '2026-07-10');
  assert.equal(data.quotes.RRHI.change, null);
  assert.equal(data.quotes.RRHI.changePercent, null);
  assert.equal(data.quotes.RRHI.volume, null);
  assert.equal(data.index.value, 5700.99);
  assert.equal(data.index.changePercent, 1.62);
  assert.equal(data.index.asOf, '2026-10-09T17:00:00+08:00');
  assert.equal(data.limitedCoverage, true);
});

test('opt-in connection fallback caches one mirror snapshot and avoids EDGE for 15 minutes', async () => {
  let current = MIRROR_NOW, edgeCalls = 0, mirrorCalls = 0;
  const free = createFreePse({ mirrorFallback: true, now: () => current, throttleMs: 0, fetchFn: async value => {
    if (value === MIRROR_URL) { mirrorCalls++; return jsonResponse(mirrorRaw); }
    edgeCalls++;
    assert.equal(new URL(value).origin, 'https://edge.pse.com.ph');
    throw new Error('private connection diagnostic');
  } });
  const catalog = await free.handle(request('/catalog'));
  assert.equal(catalog.status, 200);
  const list = await catalog.json();
  assert.equal(list.instruments.length, mirrorRaw.stocks.length);
  assert.equal(list.limitedCoverage, true);
  assert.equal(list.sourceUrl, MIRROR_URL);
  const quotes = await free.handle(request('/quotes?symbols=BDO,GTCAP'));
  assert.equal(quotes.status, 200);
  const body = await quotes.json();
  assert.equal(body.quotes[1].value, 439);
  assert.equal(body.quotes[1].changePercent, 5.02);
  assert.equal(body.quotes[0].cached, true);
  assert.equal((await (await free.handle(request('/index/PSEI'))).json()).quote.value, 5700.99);
  assert.equal(edgeCalls, 1);
  assert.equal(mirrorCalls, 1);
  current += 6 * 60000;
  assert.equal((await free.handle(request('/quotes?symbols=BDO'))).status, 200);
  assert.equal(edgeCalls, 1);
  assert.equal(mirrorCalls, 2);
  current += 10 * 60000;
  assert.equal((await free.handle(request('/catalog'))).status, 200);
  assert.equal(edgeCalls, 2);
  assert.equal(mirrorCalls, 3);
});

test('mirror coverage gaps stay unavailable; default adapter never contacts the mirror', async () => {
  const urls = [];
  const free = createFreePse({ mirrorFallback: true, now: () => MIRROR_NOW, throttleMs: 0, fetchFn: async value => {
    urls.push(value);
    if (value === MIRROR_URL) return jsonResponse(mirrorRaw);
    throw new Error('connection failed');
  } });
  const missing = await free.handle(request('/quotes?symbols=AREIT'));
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, 'coverage_unavailable');
  assert.equal((await free.handle(request('/history/BDO'))).status, 503);
  assert.equal((await free.handle(request('/etf/FMETF'))).status, 503);
  assert.ok(urls.every(value => value === MIRROR_URL || new URL(value).origin === 'https://edge.pse.com.ph'));
  assert.ok(urls.every(value => !value.includes('api_token')));
  let calls = 0;
  const normal = adapter({ fetchFn: async value => { calls++; assert.notEqual(value, MIRROR_URL); throw new Error('connection failed'); } });
  assert.equal((await normal.handle(request('/catalog'))).status, 503);
  assert.equal(calls, 1);
});

test('mirror missing numeric fields remain null and old timestamps remain explicit; invalid provenance/time fails', () => {
  const missing = structuredClone(mirrorRaw);
  missing.stocks[0].last_traded_price = null;
  delete missing.stocks[0].volume;
  const data = parseMirrorSnapshot(missing, MIRROR_NOW + 30 * 86400000);
  assert.equal(data.quotes.BDO.value, null);
  assert.equal(data.quotes.BDO.change, null);
  assert.equal(data.quotes.BDO.volume, null);
  assert.equal(data.quotes.BDO.asOf, '2026-10-09T14:50:00+08:00');
  assert.equal(data.asOf, '2026-10-09T10:30:34.000Z');
  for (const flags of [{ source: 'https://evil.test' }, { generated_utc: '2026-02-30 10:30:34' }, { generated_utc: '2026-10-10 10:30:34' }]) assert.throws(() => parseMirrorSnapshot({ ...mirrorRaw, ...flags }, MIRROR_NOW));
  const badTime = structuredClone(mirrorRaw);
  badTime.stocks[0].as_of = 'Oct 10, 2026 02:50 PM';
  assert.throws(() => parseMirrorSnapshot(badTime, MIRROR_NOW));
});
