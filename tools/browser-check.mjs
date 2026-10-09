// Browser journeys with Chrome DevTools Protocol and Node built-ins.
// Node 22+ supplies WebSocket; no browser automation package is required.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(project, 'artifacts');
const liveSource = process.argv.includes('--live-source');
const baseUrl = process.argv.slice(2).find(argument => !argument.startsWith('--')) || process.env.BASE_URL || 'http://127.0.0.1:5180';
const SETTINGS_KEY = 'psedash:settings:v3';
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(join(artifacts, 'browser-profile-'));
let chrome, socket, launchError;
let diagnostics = '', sequence = 0, passed = 0;
let interceptedGatewayRequests = 0;
const gatewayFixtureRequests = [];
const providerCatalog = [
  { symbol: 'AREIT', name: 'AREIT, Inc.', assetType: 'stock', currency: 'PHP' },
  { symbol: 'DNL', name: 'D&L Industries, Inc.', assetType: 'stock', currency: 'PHP' },
  { symbol: 'SPNEC', name: 'SP New Energy Corporation', assetType: 'stock', currency: 'PHP' }
];
function providerFixtureQuote(symbol) {
  const instrument = providerCatalog.find(instrument => instrument.symbol === symbol);
  return {
    ...instrument, symbol, name: instrument?.name || `${symbol} test instrument`,
    assetType: symbol === 'PSEI' ? 'index' : symbol === 'FMETF' ? 'etf' : 'stock', currency: 'PHP',
    value: symbol === 'PSEI' ? 6800 : 43.25, valueType: symbol === 'PSEI' ? 'index_level' : 'last_trade',
    previousClose: symbol === 'PSEI' ? 6790 : 43, change: symbol === 'PSEI' ? 10 : 0.25,
    changePercent: 0.58, volume: 1200, asOf: new Date(Date.now() - 20 * 60_000).toISOString(),
    marketDate: '2026-10-09', freshness: 'delayed', delayMinutes: 20, source: 'Fixture provider · testing only'
  };
}
function providerFixtureResponse(raw) {
  const url = new URL(raw);
  gatewayFixtureRequests.push(url.href);
  if (url.pathname === '/catalog') return { instruments: providerCatalog, source: 'Fixture reference data · testing only', asOf: new Date().toISOString() };
  if (url.pathname === '/quotes') return { generatedAt: new Date().toISOString(), quotes: (url.searchParams.get('symbols') || '').split(',').filter(Boolean).map(providerFixtureQuote) };
  if (url.pathname === '/index/PSEI') return { quote: providerFixtureQuote('PSEI') };
  if (url.pathname === '/funds') return { funds: [] };
  if (url.pathname === '/etf/FMETF') return { quote: providerFixtureQuote('FMETF'), nav: null };
  if (url.pathname.startsWith('/history/')) return { symbol: decodeURIComponent(url.pathname.split('/').at(-1)), points: [{ date: '2026-10-08', close: 43 }, { date: '2026-10-09', close: 43.25 }], source: 'Fixture provider · testing only', freshness: 'eod' };
  return { error: { code: 'invalid_request' } };
}
const publicCatalog = [
  { symbol: 'BDO', name: 'BDO Unibank, Inc.', assetType: 'stock', currency: 'PHP' },
  { symbol: 'AC', name: 'Ayala Corporation', assetType: 'stock', currency: 'PHP' },
  { symbol: 'ICT', name: 'International Container Terminal Services, Inc.', assetType: 'stock', currency: 'PHP' },
  { symbol: 'JFC', name: 'Jollibee Foods Corporation', assetType: 'stock', currency: 'PHP' },
  { symbol: 'SM', name: 'SM Investments Corporation', assetType: 'stock', currency: 'PHP' },
  { symbol: 'FMETF', name: 'First Metro Philippine Equity Exchange Traded Fund', assetType: 'etf', currency: 'PHP' },
  ...providerCatalog,
  ...['ALI','BPI','MBT','SMPH','URC','LTG','TEL','GLO','AP','AEV','MER','CNVRG'].map(symbol => ({ symbol, name: `${symbol} test instrument`, assetType: 'stock', currency: 'PHP' }))
];
let publicMirrorFixture = false;
let globalFixtureFailure = false;
const globalCatalog = [
  { symbol:'US:AAPL', name:'Apple test fixture', market:'US', currency:'USD', timeZone:'America/New_York', exchange:'NASDAQ' },
  { symbol:'HK:0700', name:'Tencent test fixture', market:'HK', currency:'HKD', timeZone:'Asia/Hong_Kong', exchange:'Hong Kong' },
  { symbol:'JP:7203', name:'Toyota test fixture', market:'JP', currency:'JPY', timeZone:'Asia/Tokyo', exchange:'Tokyo' },
  { symbol:'GB:VOD', name:'Vodafone test fixture', market:'GB', currency:'GBP', timeZone:'Europe/London', exchange:'London' },
  { symbol:'CA:SHOP', name:'Shopify Canada test fixture', market:'CA', currency:'CAD', timeZone:'America/Toronto', exchange:'Toronto' },
  { symbol:'AU:BHP', name:'BHP test fixture', market:'AU', currency:'AUD', timeZone:'Australia/Sydney', exchange:'ASX' }
].map(instrument=>({...instrument,assetType:'stock',verified:false}));
const globalExtraCatalog = [
  { ...globalCatalog[0], symbol:'US:AMD', name:'AMD test fixture' },
  { ...globalCatalog[0], symbol:'US:SHOP', name:'Shopify US test fixture' }
];
function globalFixtureQuote(symbol) {
  const metadata=[...globalCatalog,...globalExtraCatalog].find(instrument=>instrument.symbol===symbol);
  if(!metadata)return null;
  const eod=symbol==='US:AMD';
  return {...providerFixtureQuote(symbol),...metadata,value:metadata.market==='JP'?2750.5:123.45,
    asOf:eod?'2026-10-08':'2026-10-09T00:30:00Z',marketDate:metadata.market==='US'||metadata.market==='CA'?'2026-10-08':'2026-10-09',
    timestampPrecision:eod?'date':'second',freshness:eod?'eod':'snapshot',valueType:eod?'close':'last_trade',delayMinutes:null,
    source:eod?'Fixture EOD mirror · testing only':'Fixture international provider · testing only',
    sourceUrl:eod?'https://github.com/maxgfr/crible/releases/tag/data-latest':`https://finance.yahoo.com/quote/${symbol.split(':')[1]}/`};
}
function publicFixtureQuote(symbol) {
  const metadata = publicCatalog.find(instrument => instrument.symbol === symbol);
  return { ...providerFixtureQuote(symbol), ...metadata, symbol, source: publicMirrorFixture ? 'PSE EDGE via ph-stocks mirror' : 'PSE EDGE',
    sourceUrl: publicMirrorFixture ? 'https://raw.githubusercontent.com/zhameersheraz/ph-stocks/main/stocks.json' : 'https://edge.pse.com.ph/', originalSourceUrl: 'https://edge.pse.com.ph/', freshness: 'snapshot', delayMinutes: null,
    asOf: '2026-10-09T14:50:00+08:00' };
}
function publicFixtureResponse(raw) {
  const url = new URL(raw), path = url.pathname.replace(/^\/api\/public/, '');
  const coverage = publicMirrorFixture ? { type: 'mirror', count: publicCatalog.length, note: 'Only these listed stocks are available from the mirror.' } : null;
  if (path === '/catalog') {
    const market=url.searchParams.get('market')||'PH',query=(url.searchParams.get('q')||'').toLowerCase();
    if(market!=='PH')return {instruments:(query?[...globalCatalog,...globalExtraCatalog]:globalCatalog).filter(instrument=>instrument.market===market&&`${instrument.symbol} ${instrument.name}`.toLowerCase().includes(query)),source:'Fixture reference catalog · testing only',market,coverage:{type:'searchable'},asOf:new Date().toISOString()};
    return { instruments: publicCatalog, source: publicMirrorFixture ? 'PSE EDGE via ph-stocks mirror' : 'PSE EDGE', coverage, asOf: '2026-10-09T14:50:00+08:00' };
  }
  if (path === '/quotes') {
    const symbols=(url.searchParams.get('symbols')||'').split(',');
    return {generatedAt:new Date().toISOString(),coverage,quotes:symbols.map(symbol=>symbol.includes(':')?(globalFixtureFailure?null:globalFixtureQuote(symbol)):publicCatalog.some(instrument=>instrument.symbol===symbol)?publicFixtureQuote(symbol):null).filter(Boolean),issues:globalFixtureFailure?symbols.filter(symbol=>symbol.includes(':')).map(symbol=>({symbol,code:'source_unavailable',message:'International fixture source unavailable'})):[]};
  }
  if (path === '/index/PSEI') return { quote: publicFixtureQuote('PSEI') };
  if (path === '/funds') return { funds: [] };
  if (path === '/etf/FMETF') return { quote: publicFixtureQuote('FMETF'), nav: null };
  if (path.startsWith('/history/')) {const symbol=decodeURIComponent(path.split('/').at(-1)),quote=globalFixtureQuote(symbol);return quote?{symbol,points:[{date:'2026-10-07',close:120},{date:'2026-10-08',close:quote.value}],source:quote.source,freshness:'eod',currency:quote.currency,timeZone:quote.timeZone}:{symbol,points:[],source:'PSE EDGE',freshness:'snapshot'};}
  return { error: { code: 'invalid_request' } };
}
const requests = new Map();
const exceptions = [];
const interceptionErrors = [];
const pendingInterceptions = new Set();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { requests.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
    requests.set(id, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); }
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function js(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(expression, label, timeout = 10000) {
  for (let attempt = 0; attempt < Math.ceil(timeout / 100); attempt++) {
    if (await js(expression)) return;
    await pause(100);
  }
  throw new Error(`Did not become ready: ${label}`);
}

async function clickSelector(selector) {
  const clicked = await js(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node || node.disabled || node.hidden) return false;
    node.click(); return true;
  })()`);
  assert.ok(clicked, `Enabled control exists: ${selector}`);
  await pause(40);
}

async function setInput(selector, value) {
  await js(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('Missing input ' + ${JSON.stringify(selector)});
    node.focus(); node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

async function key(key, code = key) {
  const keyCode = { Escape: 27, Enter: 13, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Tab: 9, ' ': 32 }[key];
  const params = { key, code, ...(keyCode ? { windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode } : {}) };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

async function ready(label = 'dashboard') {
  await waitFor(`Boolean(document.querySelector('#history-chart') &&
    document.querySelector('#instrument-table tbody tr [data-select]') &&
    document.querySelector('#market-status')?.textContent.trim() &&
    !/loading/i.test(document.querySelector('#market-status').textContent) &&
    !document.querySelector('#refresh-data')?.disabled)`, label);
}

async function shellReady(label = 'dashboard shell') {
  await waitFor(`Boolean(document.querySelector('#settings-open') &&
    document.querySelector('#market-status')?.textContent.trim() &&
    !/loading/i.test(document.querySelector('#market-status').textContent))`, label);
}

async function reload() {
  await send('Page.reload');
  await pause(150);
  await ready('reloaded dashboard');
}

async function view(name) {
  if (await js('Boolean(document.querySelector(".sidebar[inert]"))')) await clickSelector('#menu-toggle');
  await clickSelector(`[data-view="${name}"]`);
  await waitFor(`Boolean(document.querySelector('[data-view="${name}"][aria-current], [data-view="${name}"][aria-pressed="true"], [data-view="${name}"][aria-selected="true"], [data-view="${name}"].active'))`, `${name} active tab`);
}

async function market(name, timeout = 10000) {
  await setInput('#market-select', name);
  await waitFor(`document.querySelector('#market-select').value === ${JSON.stringify(name)} &&
    !document.querySelector('#refresh-data').disabled &&
    !/loading/i.test(document.querySelector('#market-state').textContent + document.querySelector('#market-status').textContent)`, `${name} market settled`, timeout);
}

async function addMarketStock(ticker, selectedMarket) {
  await clickSelector('#topbar-add-stock');
  if(selectedMarket)await setInput('#add-stock-market', selectedMarket);
  await setInput('#add-stock-input',ticker);
  await waitFor('!document.querySelector("#add-stock-submit").disabled', 'add action ready');
  await js('document.querySelector("#add-stock-form").requestSubmit()');
  await waitFor('!document.querySelector("#add-stock-dialog").open', `added ${ticker}`,30000);
}

async function screenshot(name) {
  const toastState = name === 'browser-failure.png' ? null : await js(`(() => {
    const toast = document.querySelector('#toast');
    if (!toast) return null;
    const previous = toast.hidden; toast.hidden = true; return previous;
  })()`);
  try {
    const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(artifacts, name), Buffer.from(capture.data, 'base64'));
  } finally {
    if (toastState !== null) await js(`document.querySelector('#toast').hidden = ${JSON.stringify(toastState)}`);
  }
}

async function noOverflow(label) {
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), `No horizontal page overflow: ${label}`);
}

async function stopInterception() {
  // Completing one mocked quote can start its history request. Drain both before disabling Fetch.
  do {
    await Promise.all([...pendingInterceptions]);
    await pause(50);
  } while (pendingInterceptions.size);
  await send('Fetch.disable');
}

function pass(name) { passed++; console.log(`PASS ${name}`); }

async function liveSnapshot() {
  return js(`(() => {
    const settings = JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)}));
    return JSON.parse(localStorage.getItem('psedash:cache:' + settings.mode + ':' + settings.apiBase))?.data;
  })()`);
}

function assertLiveQuote(quote, symbol) {
  assert.ok(quote && Number.isFinite(quote.value), `${symbol} has an actual finite source value`);
  assert.ok(/PSE EDGE/i.test(quote.source) && !/sample|demo|fixture|illustrative/i.test(quote.source + ' ' + quote.freshness), `${symbol} identifies the actual PSE source`);
  assert.ok(Number.isFinite(Date.parse(quote.asOf)), `${symbol} preserves its source timestamp`);
  assert.ok(/^https:\/\//.test(quote.sourceUrl || ''), `${symbol} links its source`);
}

function assertLiveGlobalQuote(quote,symbol) {
  assert.ok(quote&&Number.isFinite(quote.value),`${symbol} has an actual finite source price`);
  assert.equal(quote.currency,'USD',`${symbol} preserves USD without peso conversion`);
  assert.equal(quote.market,'US',`${symbol} preserves its market`);
  assert.ok(quote.source&&!/sample|demo|fixture|illustrative/i.test(quote.source+' '+quote.freshness),`${symbol} identifies actual provider provenance`);
  assert.ok(Number.isFinite(Date.parse(quote.asOf))&&/^https:\/\//.test(quote.sourceUrl||''),`${symbol} retains a source date and source link`);
}

async function liveSourceJourney() {
  // This isolated profile never intercepts data or preselects a connection.
  await send('Page.navigate', { url: baseUrl });
  await waitFor(`Boolean(document.querySelector('#refresh-data') && !document.querySelector('#refresh-data').disabled &&
    document.querySelector('#market-status')?.textContent.trim() && !/loading/i.test(document.querySelector('#market-status').textContent))`, 'actual source startup', 45000);
  const settings = await js(`JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)}))`);
  assert.equal(settings?.mode, 'gateway', 'A fresh local profile automatically connects a source');
  assert.equal(new URL(settings.apiBase).pathname, '/api/public', 'Automatic connection uses the public free source');
  const first = await liveSnapshot();
  const index = first?.index, bdo = first?.quotes?.find(quote => quote.symbol === 'BDO');
  assertLiveQuote(index, 'PSEi');
  assertLiveQuote(bdo, 'BDO');
  assert.ok(await js('!/sample|offline|update failed/i.test(document.querySelector("#market-status").textContent)'), 'The displayed connection is actual data without a failed-update fallback');
  await clickSelector('#settings-open');
  assert.equal(await js('document.querySelector("#connection-mode").value'), 'free', 'The actual connection is reflected as free in settings');
  assert.ok(await js('!document.querySelector("#local-token").required && document.querySelector("#api-url").disabled'), 'The actual free source requires no API key');
  await key('Escape');
  await waitFor('!document.querySelector("#settings-dialog").open', 'actual settings close');
  await view('stocks');
  await clickSelector('#instrument-table [data-select="BDO"]');
  assert.equal(await js('Number(document.querySelector("#detail-value").textContent.replace(/[^0-9.-]/g, ""))'), bdo.value, 'BDO renders the actual source price');
  await clickSelector('#topbar-add-stock');
  await setInput('#add-stock-input', 'GTCAP');
  await waitFor('Boolean(document.querySelector("#add-stock-results [data-add-symbol=GTCAP]"))', 'actual GTCAP catalog result', 30000);
  await clickSelector('#add-stock-results [data-add-symbol="GTCAP"]');
  await waitFor('!document.querySelector("#add-stock-dialog").open && document.querySelector("#detail-symbol").dataset.detailSymbol === "GTCAP" && /\\d/.test(document.querySelector("#detail-value").textContent)', 'actual added GTCAP quote', 30000);
  const added = await liveSnapshot();
  const gtcap = added?.quotes?.find(quote => quote.symbol === 'GTCAP');
  assertLiveQuote(gtcap, 'GTCAP');
  assert.ok(await js('JSON.parse(localStorage.getItem("psedash:watchlist:v1")).includes("GTCAP") && JSON.parse(localStorage.getItem("psedash:instruments:v1")).some(instrument => instrument.symbol === "GTCAP" && instrument.verified)'), 'Actual GTCAP is saved as a verified stock and watchlist entry');
  await js('window.__liveBeforeReload = true');
  await send('Page.reload');
  await waitFor('!window.__liveBeforeReload && Boolean(document.querySelector("#refresh-data")) && !document.querySelector("#refresh-data").disabled && !/loading/i.test(document.querySelector("#market-status").textContent) && Boolean(document.querySelector("#instrument-table [data-select=GTCAP]"))', 'actual source reload retains GTCAP', 30000);
  await view('watchlist');
  await clickSelector('#instrument-table [data-select="GTCAP"]');
  const reloaded = await liveSnapshot();
  const persisted = reloaded?.quotes?.find(quote => quote.symbol === 'GTCAP');
  assertLiveQuote(persisted, 'Persisted GTCAP');
  assert.equal(await js('Number(document.querySelector("#detail-value").textContent.replace(/[^0-9.-]/g, ""))'), persisted.value, 'Reloaded GTCAP renders the actual source value');
  assert.ok(await js('/PSE EDGE/i.test(document.querySelector("#market-status").textContent) && /PHT/.test(document.querySelector("#detail-asof").textContent)'), 'Actual source and Manila timestamp are visible');
  if (reloaded.coverage?.type === 'mirror') assert.ok(await js(`/Mirror coverage: ${reloaded.coverage.count}/.test(document.querySelector('#market-status').textContent)`), 'Actual limited mirror coverage is visible');
  await noOverflow('actual free source');
  await js('scrollTo(0, 0)');
  await screenshot('live-free-source.png');
  for (const quote of [index, bdo, persisted]) console.log('OBSERVED ' + JSON.stringify({ symbol: quote.symbol, value: quote.value, source: quote.source, asOf: quote.asOf, sourceUrl: quote.sourceUrl }));
  pass('actual automatic free connection, finite PSEi/BDO, GTCAP catalog add, source/date labels, and persisted watchlist without fixtures');
  await market('US',45000);
  await view('stocks');
  await clickSelector('#instrument-table [data-select="US:AAPL"]');
  const international=await liveSnapshot(),aapl=international?.quotes?.find(quote=>quote.symbol==='US:AAPL');
  assertLiveGlobalQuote(aapl,'US:AAPL');
  assert.ok(await js('/USD/.test(document.querySelector("#detail-value").textContent) && /source|market date/i.test(document.querySelector("#market-status").textContent)'), 'The actual US source and original USD price are visible');
  await addMarketStock('AMD','US');
  const expanded=await liveSnapshot(),amd=expanded?.quotes?.find(quote=>quote.symbol==='US:AMD');
  assertLiveGlobalQuote(amd,'US:AMD');
  if(amd.timestampPrecision==='date')assert.ok(await js('/End of day/.test(document.querySelector("#detail-asof").textContent) && !/\\d{1,2}:\\d{2}|PHT|EDT|GMT/.test(document.querySelector("#detail-asof").textContent)'), 'The actual daily mirror displays its date without an invented time');
  await js('window.__liveBeforeReload = true');
  await send('Page.reload');
  await waitFor('!window.__liveBeforeReload && Boolean(document.querySelector("#refresh-data")) && !document.querySelector("#refresh-data").disabled && !/loading/i.test(document.querySelector("#market-status").textContent)', 'actual international reload',45000);
  await view('watchlist');
  await clickSelector('#instrument-table [data-select="US:AMD"]');
  const reloadedGlobal=await liveSnapshot(),savedAmd=reloadedGlobal?.quotes?.find(quote=>quote.symbol==='US:AMD');
  assertLiveGlobalQuote(savedAmd,'Persisted US:AMD');
  assert.ok(await js('JSON.parse(localStorage.getItem("psedash:watchlist:v1")).includes("US:AMD") && JSON.parse(localStorage.getItem("psedash:watchlist:v1")).includes("GTCAP")'), 'Actual Philippine and international stocks persist in one watchlist');
  await noOverflow('actual international source');
  await js('scrollTo(0,0)');
  await screenshot('live-international.png');
  for(const quote of [aapl,savedAmd])console.log('OBSERVED '+JSON.stringify({symbol:quote.symbol,value:quote.value,currency:quote.currency,source:quote.source,asOf:quote.asOf,timestampPrecision:quote.timestampPrecision,sourceUrl:quote.sourceUrl}));
  pass('actual US AAPL source, dynamic AMD quote outside starters, USD/date-only labels, and mixed Philippine/international watch persistence');
}

async function globalFixtureJourneys() {
  await view('stocks');
  const sourceHours={US:'20:30',HK:'08:30',JP:'09:30',GB:'01:30',CA:'20:30',AU:'11:30'};
  for(const metadata of globalCatalog){
    await market(metadata.market);
    await clickSelector(`#instrument-table [data-select="${metadata.symbol}"]`);
    assert.ok(await js(`document.querySelector('#detail-value').textContent.includes(${JSON.stringify(metadata.currency)}) && !document.querySelector('#detail-value').textContent.includes('₱')`), `${metadata.market} price uses its actual currency`);
    assert.ok(await js(`document.querySelector('#detail-asof').textContent.includes(${JSON.stringify(sourceHours[metadata.market])}) && /Fixture international provider/.test(document.querySelector('#detail-asof').textContent)`), `${metadata.market} shows the source's exchange-local time`);
    assert.ok(await js(`document.querySelector('#instrument-table [data-select="${metadata.symbol}"]').closest('tr').querySelector('.quote-currency').textContent === ${JSON.stringify(metadata.currency)}`), `${metadata.market} table currency matches its quote`);
    assert.ok(await js('/PSE INDEX.*PH/.test(document.querySelector(".index-card").textContent)'), 'The remaining Philippine index is explicitly labelled');
  }
  pass('six international markets retain currencies, qualified IDs, source exchange times, and an explicitly Philippine index');

  await market('US');
  assert.ok(await js(`!document.querySelector('#instrument-table [data-select="US:AMD"]')`), 'AMD is outside the starter metadata list');
  await addMarketStock('AMD','US');
  await waitFor('document.querySelector("#detail-symbol").dataset.detailSymbol === "US:AMD"', 'dynamic qualified AMD selected');
  assert.ok(await js('/USD/.test(document.querySelector("#detail-value").textContent) && /Daily close/.test(document.querySelector("#detail-value-type").textContent)'), 'Dynamic EOD quote has USD and the close value type');
  assert.ok(await js('/End of day/.test(document.querySelector("#detail-asof").textContent) && /Oct 08/.test(document.querySelector("#detail-asof").textContent) && !/\\d{1,2}:\\d{2}|PHT|EDT|GMT/.test(document.querySelector("#detail-asof").textContent)'), 'A date-only source preserves its market day and never invents intraday time');
  assert.ok(await js('/Fixture EOD mirror/.test(document.querySelector("#market-status").textContent) && !/Fixture reference catalog/.test(document.querySelector("#market-status").textContent)'), 'Actual quote provenance takes precedence over the catalog source');
  await waitFor('document.querySelectorAll("#history-table tbody tr").length === 2', 'dynamic EOD history');
  assert.ok(await js('/Oct 08/.test(document.querySelector("#history-table tbody tr").textContent) && /USD/.test(document.querySelector("#history-value-heading").textContent)'), 'Historical market dates do not shift and historical values identify currency');
  await reload();
  await view('watchlist');
  assert.equal(await js('document.querySelector("#market-select").value'),'US','Selected market survives reload');
  assert.ok(await js(`Boolean(document.querySelector('#instrument-table [data-select="US:AMD"]')) && JSON.parse(localStorage.getItem("psedash:watchlist:v1")).includes("US:AMD") && JSON.parse(localStorage.getItem("psedash:instruments:v1")).some(instrument=>instrument.symbol==="US:AMD"&&instrument.verified)`), 'Dynamic international stock, verified pin, and watchlist persist');
  pass('dynamic international add outside starter metadata, day-only EOD/source labels, history currency, and persisted qualified stock');

  await addMarketStock('SHOP','US');
  await addMarketStock('SHOP','CA');
  await market('ALL');
  const collision=await js(`['US:SHOP','CA:SHOP'].map(symbol=>document.querySelector('#instrument-table [data-select="'+symbol+'"]').closest('tr').querySelector('.quote-currency').textContent)`);
  assert.deepEqual(collision,['USD','CAD'],'The same native ticker in two markets keeps distinct IDs and currencies');
  assert.ok(await js('!document.querySelector("#instrument-head [data-sort=value]") && !document.querySelector("#instrument-head [data-sort=change]") && Boolean(document.querySelector("#instrument-head [data-sort=changePercent]"))'), 'Mixed currencies compare percentages without nominal price sorting');
  assert.ok(await js('/source.session change/.test(document.querySelector("#watch-summary").textContent)'), 'Mixed watch summaries identify source-session percentages');
  await noOverflow('mixed international watchlist');
  await screenshot('international-watchlist-fixture.png');
  pass('qualified ticker collisions, mixed-currency saved watchlist, and percentage comparisons');

  await view('stocks');
  globalFixtureFailure=true;
  await market('US');
  assert.ok(await js(`!/\\d/.test(document.querySelector('#instrument-table [data-select="US:AMD"]').closest("tr").querySelector(".quote-price").textContent)`), 'A failed global source clears its earlier current price');
  assert.ok(await js('/unavailable/i.test(document.querySelector("#market-status").textContent) && /\\d/.test(document.querySelector("#index-value").textContent)'), 'The global failure is explicit while the actual Philippine index remains available');
  globalFixtureFailure=false;
  await clickSelector('#refresh-data');
  await ready('global source recovery');
  await market('PH');
  assert.ok(await js(`/43.25/.test(document.querySelector('#instrument-table [data-select="BDO"]').closest("tr").querySelector(".quote-price").textContent)`), 'Healthy Philippine quotes survive failed global data');
  pass('international source failure shows unavailable prices and preserves healthy Philippine data');

  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await market('JP');
  await noOverflow('mobile market selector and international prices');
  await clickSelector('#topbar-add-stock');
  assert.equal(await js('document.querySelector("#add-stock-market").value'),'JP','Add stock follows the selected market');
  await noOverflow('mobile international add dialog');
  await key('Escape');
  await waitFor('!document.querySelector("#add-stock-dialog").open','mobile international add closes');
  await js('scrollTo(0,0)');
  await screenshot('international-mobile-fixture.png');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await market('PH');
  await view('overview');
  pass('390px market selection, international prices, and add-stock dialog fit the viewport');
}

try {
  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.on('error', error => { launchError = error; });
  chrome.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2500); });
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch {}
    await pause(100);
  }
  if (!port) throw new Error(`Chrome did not start. ${diagnostics}`);
  const endpoint = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(endpoint.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.method === 'Fetch.requestPaused') {
      const requestUrl = new URL(data.params.request.url);
      const dynamicFixture = requestUrl.hostname === 'catalog-check.invalid';
      const localFixture = requestUrl.origin === new URL(baseUrl).origin;
      const statusFixture = localFixture && requestUrl.pathname === '/api/status';
      const publicFixture = localFixture && requestUrl.pathname.startsWith('/api/public/');
      const successfulFixture = dynamicFixture || statusFixture || publicFixture;
      if (!successfulFixture) interceptedGatewayRequests++;
      const response = statusFixture ? { configured: false, provider: 'EODHD', personalUse: false, freeAvailable: true, freeApiBase: '/api/public', freeSource: 'PSE EDGE' } : publicFixture ? publicFixtureResponse(requestUrl.href) : dynamicFixture ? providerFixtureResponse(requestUrl.href) : { error: { code: 'service_configuration', message: 'Private upstream details must not reach the UI.' } };
      // Delay the mock long enough to exercise the cleared loading state.
      let settle;
      const completion = new Promise(resolve => { settle = resolve; });
      pendingInterceptions.add(completion);
      setTimeout(async () => {
        try {
          await send('Fetch.fulfillRequest', {
            requestId: data.params.requestId,
            responseCode: successfulFixture ? 200 : 503,
            responseHeaders: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'Access-Control-Allow-Origin', value: new URL(baseUrl).origin }
            ],
            body: Buffer.from(JSON.stringify(response)).toString('base64')
          });
        } catch (error) {
          // Navigation can cancel a paused request before its mock response is delivered.
          if (!/Invalid InterceptionId\.?$|Fetch domain is not enabled\.?$/.test(error.message)) interceptionErrors.push(error.message);
        } finally {
          pendingInterceptions.delete(completion); settle();
        }
      }, 200);
      return;
    }
    if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
    const pending = requests.get(data.id);
    if (!pending) return;
    requests.delete(data.id);
    data.error ? pending.reject(new Error(data.error.message)) : pending.resolve(data.result);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__browserErrors = [];
    addEventListener('error', event => window.__browserErrors.push(event.message));
    addEventListener('unhandledrejection', event => window.__browserErrors.push(String(event.reason)));` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  if (liveSource) {
    await liveSourceJourney();
  } else {
  await send('Fetch.enable', { patterns: [
    { urlPattern: new URL('/api/status', baseUrl).href, requestStage: 'Request' },
    { urlPattern: new URL('/api/public/*', baseUrl).href, requestStage: 'Request' }
  ] });
  await send('Page.navigate', { url: baseUrl });
  await shellReady();
  await js('localStorage.clear()');
  await send('Page.reload');
  await ready('automatic free source');
  assert.ok(await js(`/PSE EDGE/.test(document.querySelector('#market-status').textContent) && JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)})).apiBase.endsWith('/api/public')`), 'A fresh local dashboard automatically connects the public source');
  assert.ok(await js('/snapshot/i.test(document.querySelector("#index-badge").textContent) && /14:50/.test(document.querySelector("#market-status").textContent) && !/20 min|real.time|refresh every 60/i.test(document.querySelector("#market-status").textContent)'), 'Public quotes retain their source time and snapshot identity');
  await clickSelector('#settings-open');
  assert.equal(await js('document.querySelector("#connection-mode").value'), 'free', 'Settings reflect the free connection');
  assert.ok(await js('document.querySelector("#local-setup").hidden && !document.querySelector("#local-token").required && document.querySelector("#api-url").disabled'), 'Free source requires no provider key or gateway URL');
  await js('document.querySelector("#settings-form").requestSubmit()');
  await waitFor('!document.querySelector("#settings-dialog").open', 'free source settings saved without a key');
  await ready('saved public source');
  await view('funds');
  assert.ok(await js('/does not provide mutual.fund NAVs/i.test(document.querySelector("#instrument-table").textContent) && document.querySelector("#fund-date").textContent === "Unavailable"'), 'Unsupported fund NAVs remain unavailable');
  await view('etfs');
  assert.ok(await js('/Unavailable/.test(document.querySelector("#etf-nav-detail").textContent) && /not supplied/i.test(document.querySelector("#etf-nav-detail").textContent)'), 'Unsupported ETF NAV remains unavailable');
  await view('overview');
  await screenshot('free-provider-fixture.png');
  pass('automatic free PSE EDGE connection, snapshot/source time labels, no API key, and unavailable NAV coverage');
  publicMirrorFixture = true;
  await clickSelector('#refresh-data');
  await ready('public mirror fixture');
  assert.ok(await js('/PSE EDGE via ph-stocks mirror/.test(document.querySelector("#market-status").textContent) && /Mirror coverage: 21/.test(document.querySelector("#market-status").textContent)'), 'A limited mirror is named and its coverage count is explicit');
  assert.ok(await js('document.querySelector("#free-source-reference a").href.startsWith("https://raw.githubusercontent.com/") && !document.querySelector("#free-original-source").hidden'), 'Mirror attribution links the actual feed and original PSE reference');
  await clickSelector('#add-stock-open');
  await setInput('#add-stock-input', 'MEG');
  await js('document.querySelector("#add-stock-form").requestSubmit()');
  await waitFor('!document.querySelector("#add-stock-error").hidden && /free source has no quote for MEG/i.test(document.querySelector("#add-stock-error").textContent)', 'stock outside free mirror coverage');
  await key('Escape');
  await waitFor('!document.querySelector("#add-stock-dialog").open', 'limited source add dialog closes');
  publicMirrorFixture = false;
  pass('mirror source attribution,21-stock coverage, and a clear unavailable quote for an uncovered symbol');
  await globalFixtureJourneys();
  await js('localStorage.clear(); localStorage.setItem("psedash:settings:v2", JSON.stringify({ mode: "demo", apiBase: "" }));');
  await send('Page.reload');
  await ready('migrated explicit sample settings');
  assert.ok(await js('/sample/i.test(document.querySelector("#market-status").textContent)'), 'An explicitly selected legacy sample mode remains selected');
  await js('localStorage.clear(); localStorage.setItem("psedash:settings:v2", JSON.stringify({ mode: "gateway", apiBase: location.origin + "/api/public" }));');
  await send('Page.reload');
  await ready('migrated explicit gateway settings');
  await clickSelector('#settings-open');
  assert.equal(await js('document.querySelector("#connection-mode").value'), 'free', 'An existing public gateway maps to the free selector');
  await key('Escape');
  await waitFor('!document.querySelector("#settings-dialog").open', 'migrated gateway settings close');
  pass('settings migration preserves explicit sample and gateway selections');
  await js(`localStorage.clear(); localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, JSON.stringify({ mode: 'unconfigured', apiBase: '', autoConnect: false }));`);
  await send('Page.reload');
  await shellReady('fresh unconfigured dashboard');
  assert.ok(await js('!/\\d/.test(document.querySelector("#index-value").textContent) && !/\\d/.test(document.querySelector("#detail-value").textContent)'), 'An unconfigured dashboard does not invent an index or stock price');
  assert.equal(await js('document.querySelectorAll("#history-table tbody tr").length'), 0, 'An unconfigured dashboard has no fictional history');
  assert.ok(await js('/connect|configur|gateway/i.test(document.querySelector("#market-status").textContent)'), 'An unconfigured dashboard explains how to obtain market data');
  await screenshot('unconfigured.png');
  pass('fresh installation has no invented prices or history and explains the missing data connection');
  await clickSelector('#add-stock-open');
  await waitFor('document.querySelector("#add-stock-dialog").open', 'unconfigured add-stock dialog');
  await setInput('#add-stock-input', 'PHR');
  await js('document.querySelector("#add-stock-form").requestSubmit()');
  await waitFor('!document.querySelector("#add-stock-dialog").open && Boolean(document.querySelector("#instrument-table [data-select=PHR]"))', 'unconfigured manual stock saved');
  assert.ok(await js('!/\\d/.test(document.querySelector("#instrument-table [data-select=PHR]").closest("tr").querySelector(".quote-price").textContent) && /unavailable/i.test(document.querySelector("#instrument-table [data-select=PHR]").closest("tr").textContent)'), 'Saving a ticker without a provider keeps its price unavailable');
  await reload();
  await view('watchlist');
  assert.ok(await js('Boolean(document.querySelector("#instrument-table [data-select=PHR]")) && JSON.parse(localStorage.getItem("psedash:instruments:v1")).some(instrument => instrument.symbol === "PHR" && instrument.verified === false)'), 'Unverified manual addition survives reload');
  await clickSelector('#instrument-table [data-watch="PHR"]');
  await view('overview');
  pass('manual stock additions persist while unconfigured and never create prices');
  await clickSelector('#settings-open');
  await setInput('#connection-mode', 'demo');
  await setInput('#api-url', '');
  await js('document.querySelector("#settings-form").requestSubmit()');
  await waitFor('!document.querySelector("#settings-dialog").open', 'explicit sample-mode selection');
  await ready('explicitly selected sample dashboard');

  assert.ok(await js('/sample|demo/i.test(document.querySelector("#market-status").textContent)'), 'Sample dataset is explicitly labeled');
  assert.ok(await js('Boolean(document.querySelector("[role=status][aria-live], [role=status], [aria-live=polite]"))'), 'Dynamic status has an accessible live region');
  assert.ok(await js('Boolean(document.querySelector("#instrument-table caption") && document.querySelector("#instrument-table th[scope]"))'), 'Instrument table has a caption and scoped headings');
  assert.ok(await js('Boolean(document.querySelector("#history-chart[role=img], #history-chart title, #history-chart[aria-label]"))'), 'History visualization has a textual accessible name');
  await noOverflow('desktop overview');
  await screenshot('desktop.png');
  await js('document.querySelector(".explore-card").scrollIntoView({ block: "start" })');
  await screenshot('desktop-table.png');
  await js('scrollTo(0, 0)');
  pass('desktop overview, sample provenance, accessible tables/chart/status, and responsive width');

  for (const name of ['stocks', 'funds', 'etfs', 'watchlist', 'overview']) {
    await view(name);
    await noOverflow(`desktop ${name}`);
    assert.ok(await js('document.querySelectorAll("#instrument-table tbody tr").length > 0'), `${name} presents instrument rows`);
  }
  await view('funds');
  assert.ok(await js('/NAVPS|NAVPU/i.test(document.querySelector("#instrument-table").textContent)'), 'Funds identify their daily NAV unit');
  assert.ok(await js('/valuation|as of|NAV date/i.test(document.querySelector("#instrument-table").textContent)'), 'Funds show valuation dates');
  await view('etfs');
  await clickSelector('#instrument-table [data-select]');
  assert.ok(await js('/NAV|iNAV/i.test(document.body.textContent)'), 'ETF detail includes separately identified NAV/iNAV');
  pass('Stocks, Mutual funds, ETFs, and My watchlist routes retain instrument-specific data labels');

  await setInput('#search-input', 'BDO');
  await waitFor('Boolean(document.querySelector("#search-results [data-result]"))', 'stock search result');
  assert.ok(await js('/BDO/i.test(document.querySelector("#search-results").textContent)'), 'Search resolves a PSE symbol');
  await key('ArrowDown');
  await key('Enter');
  await waitFor('/BDO/i.test(document.querySelector("#detail-symbol")?.textContent || "")', 'keyboard-selected BDO detail');
  assert.ok(await js('document.querySelector("#search-results").hidden || document.querySelector("#search-input").getAttribute("aria-expanded") === "false" || !document.querySelector("#search-results [data-result]")'), 'Selection dismisses autocomplete');
  await key('ArrowDown');
  await key('ArrowUp');
  assert.ok(await js('document.querySelector("#search-results").hidden'), 'Arrow keys after selection keep the empty search closed');
  await setInput('#search-input', 'Ayala');
  await waitFor('Boolean(document.querySelector("#search-results [data-result]"))', 'name search result');
  await key('Escape');
  assert.ok(await js('document.querySelector("#search-results").hidden || document.querySelector("#search-input").getAttribute("aria-expanded") === "false" || !document.querySelector("#search-results [data-result]")'), 'Escape dismisses autocomplete');
  pass('symbol/name search, keyboard navigation and selection, and Escape dismissal');

  const counts = [], paths = [];
  for (const range of ['1w', '1m', '3m', '1y']) {
    await clickSelector(`#chart-range button[data-range="${range}"]`);
    await waitFor(`document.querySelector('#chart-range [data-range="${range}"]').getAttribute('aria-pressed') === 'true'`, `${range} active range`);
    await waitFor('document.querySelectorAll("#history-table tbody tr").length > 0', `${range} history rows`);
    counts.push(await js('document.querySelectorAll("#history-table tbody tr").length'));
    paths.push(await js('document.querySelector("#history-chart path")?.getAttribute("d") || document.querySelector("#history-chart polyline")?.getAttribute("points") || document.querySelector("#history-chart").innerHTML'));
  }
  assert.ok(counts.every((count, index) => index === 0 || count > counts[index - 1]), `History lengths grow with selected range: ${counts}`);
  assert.equal(new Set(paths).size, 4, 'Every range updates the chart geometry');
  assert.ok(await js('document.querySelector("#history-details").tagName === "DETAILS" && Boolean(document.querySelector("#history-details summary"))'), 'Historical values use a native disclosure');
  await clickSelector('#history-details summary');
  assert.ok(await js('document.querySelector("#history-details").open'), 'Accessible history disclosure opens');
  assert.ok(await js('Boolean(document.querySelector("#history-table caption") && document.querySelector("#history-table th[scope]"))'), 'History table has an accessible caption and heading scopes');
  await clickSelector('#history-details summary');
  pass('selected stock history, all four ranges, updated chart geometry, and accessible data disclosure');

  await view('stocks');
  const candidate = await js(`(() => {
    const buttons = [...document.querySelectorAll('#instrument-table [data-watch]')];
    return (buttons.find(node => node.getAttribute('aria-pressed') === 'false') || buttons[0])?.dataset.watch;
  })()`);
  assert.ok(candidate, 'Stocks include watchlist buttons');
  const watchSelector = `#instrument-table [data-watch="${candidate}"]`;
  if (await js(`document.querySelector(${JSON.stringify(watchSelector)}).getAttribute('aria-pressed') === 'true'`)) await clickSelector(watchSelector);
  await clickSelector(watchSelector);
  assert.equal(await js(`document.querySelector(${JSON.stringify(watchSelector)}).getAttribute('aria-pressed')`), 'true', 'Watchlist adds the selected stock');
  await reload();
  await view('watchlist');
  assert.ok(await js(`Boolean(document.querySelector('#instrument-table [data-select="${candidate}"]'))`), 'Saved watchlist survives reload');
  await clickSelector(`#instrument-table [data-watch="${candidate}"]`);
  await reload();
  await view('watchlist');
  assert.ok(await js(`!document.querySelector('#instrument-table [data-select="${candidate}"]')`), 'Removed stock stays removed after reload');
  pass('watchlist add/remove, saved indicator, and persistence after reload');

  // Capture the generated CSV without changing the application export code.
  await js(`window.__csvExport = null; window.__csvDownload = null;
    window.__originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function(blob) { window.__csvExport = blob.text(); return window.__originalCreateObjectURL.call(this, blob); };
    window.__originalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() { if (this.download) { window.__csvDownload = this.download; return; } return window.__originalAnchorClick.call(this); };`);
  await clickSelector('#export-csv');
  const exported = await js('window.__csvExport');
  assert.ok(exported && /symbol/i.test(exported) && /source/i.test(exported) && /as.?of|valuation|market.?date/i.test(exported), 'CSV retains values, provenance, and timestamps');
  assert.ok(await js('/\.csv$/i.test(window.__csvDownload || "")'), 'UI export names a CSV file');
  await js('URL.createObjectURL = window.__originalCreateObjectURL; HTMLAnchorElement.prototype.click = window.__originalAnchorClick;');
  pass('CSV export through the UI preserves provenance and timestamps');

  await clickSelector('#settings-open');
  await waitFor('document.querySelector("#settings-dialog").open', 'settings dialog');
  await key('Escape');
  await waitFor('!document.querySelector("#settings-dialog").open', 'native Escape closes settings');
  await clickSelector('#settings-open');
  await setInput('#connection-mode', 'gateway');
  await setInput('#api-url', 'http://example.com');
  await js('document.querySelector("#settings-form").requestSubmit()');
  await pause(80);
  assert.ok(await js('document.querySelector("#settings-dialog").open'), 'Insecure external URL keeps settings open');
  assert.ok(await js('/HTTPS|secure/i.test(document.querySelector("#settings-dialog").textContent) || !document.querySelector("#api-url").checkValidity()'), 'URL validation explains the HTTPS requirement');
  await setInput('#connection-mode', 'demo');
  await setInput('#api-url', '');
  await js('document.querySelector("#settings-form").requestSubmit()');
  await waitFor('!document.querySelector("#settings-dialog").open', 'sample-mode save');
  await ready('restored sample data');
  assert.ok(await js('/sample|demo/i.test(document.querySelector("#market-status").textContent)'), 'Settings explicitly restore sample mode');
  pass('settings dialog keyboard dismissal, HTTPS validation, and sample-mode selection');

  await view('etfs');
  await waitFor('document.querySelectorAll("#history-table tbody tr").length > 0 && !document.querySelector("#etf-nav-detail").hidden', 'sample ETF history and NAV');
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://browser-check.invalid/*', requestStage: 'Request' }] });
  await clickSelector('#settings-open');
  await setInput('#connection-mode', 'gateway');
  await setInput('#api-url', 'https://browser-check.invalid');
  await js('document.querySelector("#settings-form").requestSubmit()');
  await waitFor('!document.querySelector("#settings-dialog").open', 'gateway connection saved');
  assert.equal(await js('document.querySelectorAll("#history-table tbody tr").length'), 0, 'Switching sources immediately clears sample historical values');
  assert.equal(await js('document.querySelector("#detail-value").textContent.trim()'), '—', 'Switching sources clears the old selected value');
  assert.ok(await js('document.querySelector("#etf-nav-detail").hidden'), 'Switching sources clears independently timestamped sample NAV');
  await waitFor('/configuration error/i.test(document.querySelector("#market-status").textContent) && !document.querySelector("#refresh-data").disabled', 'gateway configuration error');
  assert.ok(interceptedGatewayRequests >= 4, 'All four gateway data families use the selected gateway');
  assert.ok(await js('!/loading/i.test(document.querySelector("#index-badge").textContent + document.querySelector("#detail-asof").textContent)'), 'A failed gateway stops displaying loading labels');
  assert.ok(await js('[...document.querySelectorAll("#instrument-table tbody .quote-price")].every(node => !/\\d/.test(node.textContent)) && !document.querySelector("#history-chart path")'), 'Unavailable gateway presents no sample prices or chart');
  assert.ok(await js('!/sample|fictional/i.test(document.querySelector("#market-status").textContent + document.querySelector("#history-label").textContent)'), 'Gateway failure retains no sample provenance');
  assert.ok(await js('!document.body.textContent.includes("Private upstream details")'), 'Provider failure details are sanitized');
  await stopInterception();
  await clickSelector('#settings-open');
  await setInput('#connection-mode', 'demo');
  await setInput('#api-url', '');
  await js('document.querySelector("#settings-form").requestSubmit()');
  await waitFor('!document.querySelector("#settings-dialog").open', 'sample connection restored');
  await ready('restored sample after gateway outage');
  pass('gateway loading/failure clears sample quotes, chart, and NAV without leaking upstream details');

  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://catalog-check.invalid/*', requestStage: 'Request' }] });
  await clickSelector('#settings-open');
  await setInput('#connection-mode', 'gateway');
  await setInput('#api-url', 'https://catalog-check.invalid');
  await js('document.querySelector("#settings-form").requestSubmit()');
  await waitFor('!document.querySelector("#settings-dialog").open', 'provider fixture connection saved');
  await ready('provider fixture snapshot');
  await view('stocks');
  assert.ok(await js('!document.querySelector("#instrument-table [data-select=AREIT]")'), 'AREIT is outside the initial displayed stock list');
  await clickSelector('#add-stock-open');
  await waitFor('document.querySelector("#add-stock-dialog").open', 'add-stock dialog');
  await setInput('#add-stock-input', 'AREIT');
  await waitFor('Boolean(document.querySelector("#add-stock-results [data-add-symbol=AREIT]"))', 'provider catalog result beyond bundled stocks');
  await clickSelector('#add-stock-results [data-add-symbol="AREIT"]');
  await waitFor('!document.querySelector("#add-stock-dialog").open && Boolean(document.querySelector("#instrument-table [data-select=AREIT]"))', 'new stock displayed');
  assert.ok(await js('document.querySelector("#instrument-table [data-select=AREIT]").closest("tr").textContent.includes("43.25") && document.querySelector("#instrument-table [data-select=AREIT]").closest("tr").textContent.includes("Fixture provider")'), 'Added stock displays its requested provider value and source');
  assert.ok(gatewayFixtureRequests.some(raw => { const url = new URL(raw); return url.pathname === '/quotes' && url.searchParams.get('symbols') === 'AREIT'; }), 'Adding a stock requests its own quote');
  assert.ok(await js('JSON.parse(localStorage.getItem("psedash:instruments:v1")).some(instrument => instrument.symbol === "AREIT") && JSON.parse(localStorage.getItem("psedash:watchlist:v1")).includes("AREIT")'), 'Added provider instrument and watchlist persist separately');
  await reload();
  await view('watchlist');
  await waitFor('Boolean(document.querySelector("#instrument-table [data-select=AREIT]"))', 'added stock retained after reload');
  assert.ok(await js('document.querySelector("#instrument-table [data-watch=AREIT]").getAttribute("aria-pressed") === "true"'), 'New stock remains saved after reload');
  assert.ok(gatewayFixtureRequests.some(raw => { const url = new URL(raw); return url.pathname === '/quotes' && (url.searchParams.get('symbols') || '').split(',').includes('AREIT'); }), 'Reload fetches quotes for the added stock');
  await clickSelector('#add-stock-open');
  await setInput('#add-stock-input', 'NOTREAL');
  await js('document.querySelector("#add-stock-form").requestSubmit()');
  await waitFor('!document.querySelector("#add-stock-error").hidden && Boolean(document.querySelector("#add-stock-error").textContent.trim())', 'unknown provider symbol error');
  assert.ok(await js('!document.querySelector("#instrument-table [data-select=NOTREAL]")'), 'Unknown symbols do not create invented market prices');
  await key('Escape');
  await waitFor('!document.querySelector("#add-stock-dialog").open', 'add-stock dialog Escape');
  await stopInterception();
  await clickSelector('#settings-open');
  await setInput('#connection-mode', 'demo');
  await setInput('#api-url', '');
  await js('document.querySelector("#settings-form").requestSubmit()');
  await waitFor('!document.querySelector("#settings-dialog").open', 'sample restored after dynamic provider test');
  await ready('explicit sample after dynamic stock');
  await view('stocks');
  const addedSampleRow = await js('document.querySelector("#instrument-table [data-select=AREIT]")?.closest("tr").textContent || ""');
  assert.ok(!addedSampleRow.includes('43.25') && (!addedSampleRow || /unavailable|no quote|not available/i.test(addedSampleRow)), 'Sample mode does not invent a value for a newly added stock');
  pass('provider-wide catalog search, dynamic stock quotes, saved additions across reload, and unavailable unknown values');

  const offlineValues = await js('[...document.querySelectorAll("#instrument-table tbody [data-select]")].map(node => node.dataset.select)');
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await js('window.dispatchEvent(new Event("offline"))');
  const refreshSelector = await js(`(() => {
    const node = document.querySelector('#refresh-data, #refresh-market, [data-action="refresh"]') || [...document.querySelectorAll('button')].find(node => /refresh/i.test(node.textContent + ' ' + node.getAttribute('aria-label')));
    if (!node) return null; node.id ||= 'browser-refresh-control'; return '#' + node.id;
  })()`);
  if (refreshSelector) await clickSelector(refreshSelector);
  await waitFor('/offline/i.test(document.querySelector("#market-status").textContent) && /cache/i.test(document.querySelector("#market-status").textContent)', 'explicit offline cached state');
  assert.deepEqual(await js('[...document.querySelectorAll("#instrument-table tbody [data-select]")].map(node => node.dataset.select)'), offlineValues, 'Offline cached instruments remain available');
  assert.ok(await js('/sample/i.test(document.querySelector("#market-status").textContent)'), 'Offline sample cache retains its sample identity');
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await js('window.dispatchEvent(new Event("online"))');
  await waitFor('!/offline/i.test(document.querySelector("#market-status").textContent)', 'online recovery');
  pass('offline cache remains readable, explicitly labeled, and recovers online');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const name of ['stocks', 'funds', 'etfs', 'watchlist', 'overview']) {
    await view(name);
    await noOverflow(`mobile ${name}`);
  }
  await js('scrollTo(0, 0)');
  await screenshot('mobile.png');
  await clickSelector('#settings-open');
  await noOverflow('mobile settings dialog');
  await key('Escape');
  await waitFor('!document.querySelector("#settings-dialog").open', 'mobile native Escape closes settings');
  await setInput('#search-input', 'BDO');
  await waitFor('Boolean(document.querySelector("#search-results [data-result]"))', 'mobile autocomplete');
  await noOverflow('mobile autocomplete');
  await key('Escape');
  pass('390px mobile routes, settings, and search fit the viewport');
  }

  assert.deepEqual(await js('window.__browserErrors'), [], 'No window errors or unhandled promise rejections');
  assert.deepEqual(exceptions, [], 'No uncaught browser runtime exceptions');
  assert.deepEqual(interceptionErrors, [], 'No unexpected browser harness interception errors');
  console.log(`${passed} browser journeys passed. Screenshots: ${liveSource ? 'artifacts/live-free-source.png and artifacts/live-international.png' : 'artifacts/desktop.png and artifacts/mobile.png'}`);
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await screenshot('browser-failure.png'); } catch {}
  }
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  socket?.close();
  chrome?.kill();
  await pause(400);
  // Cleanup is limited to the fresh profile created by this invocation.
  if (dirname(resolve(profile)) !== resolve(artifacts) || !basename(profile).startsWith('browser-profile-')) throw new Error('Unexpected browser profile path; cleanup refused.');
  try { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { console.log(`Temporary browser profile remains at ${profile}`); }
}
