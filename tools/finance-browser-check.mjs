import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

// These QA records live only in isolated browser contexts, never the user's profile.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(project, 'artifacts');
const args = process.argv.slice(2);
const staticSource = args.includes('--static-source');
const liveSource = staticSource || args.includes('--live-source');
const publicMirror = args.includes('--public-mirror');
const sourceArtifact = staticSource ? 'finance-static-source' : 'finance-live';
const sourceResultsFile = staticSource ? 'finance-static-source-results.json' : 'finance-live-source-results.json';
const liveUrl = new URL(args.find(arg => /^https?:\/\//.test(arg)) || process.env.FINANCE_PREVIEW_URL || 'http://127.0.0.1:5174/');
liveUrl.hash = ''; liveUrl.search = '';
if (!liveUrl.pathname.endsWith('/')) liveUrl.pathname += '/';
const dist = await realpath(resolve(project, 'dist'));
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const routes = [
  ['/', 'Overview', /A little clarity/], ['/transactions', 'Transactions', /Your transactions/],
  ['/accounts', 'Accounts', /Your accounts/], ['/budgets', 'Budgets', /Budgets & recurring/],
  ['/investments', 'Investments', /Your investments/], ['/markets', 'Markets', /Markets beyond borders/],
  ['/fire', 'FIRE journey', /Freedom, at your own pace/], ['/debts', 'Debts', /Debts & repayment/],
  ['/reports', 'Reports', /reports|money|numbers|story|picture/i], ['/data', 'Data & sync', /safe home/],
  ['/settings', 'Settings', /Your preferences/],
];
const date = new Date();
const dayParts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
const part = type => dayParts.find(value => value.type === type).value;
const today = `${part('year')}-${part('month')}-${part('day')}`;
const openingDate = `${today.slice(0, 7)}-01`;
let browser, server, currentPage, passed = 0;
const runtimeErrors = [], consoleErrors = [];
const liveObservations = {}, liveNetworkErrors = [];
const livePublicRequests = new Set();
const mirrorObservations = [];
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const contained = path => path === dist || path.startsWith(dist + sep);

// Serve the same relative-base production build at root and at a repository-like mount.
// No provider credentials or finance data are sent to a test server or external service.
async function startStaticServer() {
  const instance = createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (path.startsWith('/api/')) { response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Market gateway unavailable in isolated finance acceptance.' } })); return; }
      const localPath = path.startsWith('/finance-check/') ? path.slice('/finance-check'.length) : path;
      if (localPath.split(/[\\/]/).some(segment => segment.startsWith('.'))) { response.writeHead(403).end(); return; }
      let target = resolve(dist, '.' + localPath);
      if (!contained(target)) { response.writeHead(403).end(); return; }
      if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
      target = await realpath(target);
      if (!contained(target)) { response.writeHead(403).end(); return; }
      const body = await readFile(target);
      response.writeHead(200, { 'Content-Type': mime[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); }
  });
  await new Promise((resolveStart, reject) => { instance.once('error', reject); instance.listen(0, '127.0.0.1', resolveStart); });
  return instance;
}
const minorMoney = amount => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(amount / 100);
const main = page => page.locator('#page-main');
const dialog = page => page.locator('dialog[open]');
async function saveDialog(page, name) {
  await dialog(page).getByRole('button', { name, exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
}
async function chooseAccount(select, name) {
  let value = '';
  await expect.poll(async () => {
    value = await select.locator('option').evaluateAll((options, name) => options.find(option => option.textContent.trim().startsWith(name))?.value || '', name);
    return value;
  }, { timeout: 15000, message: `Wait for the IndexedDB account option: ${name}` }).not.toBe('');
  await select.selectOption(value);
}
async function openRoute(page, path) {
  const entry = routes.find(route => route[0] === path);
  assert(entry, `Unknown test route ${path}`);
  const link = page.locator('.sidebar').getByRole('link', { name: entry[1], exact: true });
  const toggle = page.getByRole('button', { name: 'Toggle navigation', exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await link.click();
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 15000 }).toBe(`#${path}`);
  await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible();
  if (path !== '/reports') await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(entry[2]);
  await expect(page.getByText('This view could not be opened.', { exact: true })).toHaveCount(0);
}
async function readLedger(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolveOpen, reject) => { const request = indexedDB.open('tala-finance'); request.onsuccess = () => resolveOpen(request.result); request.onerror = () => reject(request.error); });
    try {
      const names = ['accounts', 'transactions', 'postings', 'instruments', 'prices', 'budgets', 'recurringRules', 'recurringOccurrences', 'liabilityTerms', 'settings'];
      const transaction = db.transaction(names, 'readonly');
      const entries = await Promise.all(names.map(name => new Promise((resolveRows, reject) => { const request = transaction.objectStore(name).getAll(); request.onsuccess = () => resolveRows([name, request.result.filter(row => !row.deletedAt)]); request.onerror = () => reject(request.error); })));
      return Object.fromEntries(entries);
    } finally { db.close(); }
  });
}
async function balance(page, name) {
  const data = await readLedger(page), account = data.accounts.find(account => account.name === name);
  assert(account, `Missing account ${name}`);
  return (account.openingDate <= today ? account.openingBalance : 0) + data.postings.filter(posting => posting.accountId === account.id && posting.date <= today).reduce((sum, posting) => sum + posting.delta, 0);
}
async function expectBalance(page, name, amount) {
  await expect.poll(() => balance(page, name)).toBe(amount);
  if (await page.locator('.account-card').count()) await expect(page.locator('.account-card').filter({ has: page.getByRole('heading', { name, exact: true }) }).locator('.account-balance')).toHaveText(minorMoney(amount));
}
async function netWorth(page, amount) {
  await openRoute(page, '/');
  await expect(page.locator('.worth-card .metric-value')).toHaveText(minorMoney(amount));
}
async function createAccount(page, { name, type = 'SAVINGS', opening = '0', fire = false }) {
  await openRoute(page, '/accounts');
  await main(page).getByRole('button', { name: 'Add account', exact: true }).click();
  await dialog(page).getByLabel('Account name', { exact: true }).fill(name);
  await dialog(page).getByLabel(/^Account type/).selectOption(type);
  await dialog(page).getByLabel('Currency', { exact: true }).selectOption('PHP');
  await dialog(page).getByLabel(/^Opening (?:balance|amount owed)(?! date)/).fill(opening);
  await dialog(page).getByLabel('Opening balance date', { exact: true }).fill(openingDate);
  if (fire) await dialog(page).getByLabel('FIRE assets', { exact: true }).check();
  await saveDialog(page, 'Save account');
  await expectBalance(page, name, Math.round(Number(opening) * 100));
}
async function recordTransaction(page, { type = 'EXPENSE', account = 'QA Savings', to, amount, category, merchant = '', notes = '', principal }) {
  await openRoute(page, '/transactions');
  await main(page).getByRole('button', { name: 'Add transaction', exact: true }).click();
  await dialog(page).getByLabel('Transaction type', { exact: true }).selectOption(type);
  await chooseAccount(dialog(page).getByLabel(to ? 'From account' : 'Account', { exact: true }), account);
  await dialog(page).getByLabel(/^(Signed adjustment|Amount) \(PHP\)$/).fill(String(amount));
  await dialog(page).getByLabel('Date', { exact: true }).fill(today);
  if (to) await chooseAccount(dialog(page).getByLabel('To account', { exact: true }), to);
  if (category) await dialog(page).getByLabel('Category', { exact: true }).selectOption({ label: category });
  if (merchant) await dialog(page).getByLabel('Merchant / payer (optional)', { exact: true }).fill(merchant);
  if (notes) await dialog(page).getByLabel('Notes', { exact: true }).fill(notes);
  if (principal != null) await dialog(page).getByLabel(/^Declared principal paid/).fill(String(principal));
  await saveDialog(page, 'Save transaction');
}
async function screenshot(page, name) {
  await page.screenshot({ path: resolve(artifacts, name), fullPage: true, animations: 'disabled' });
}
async function noOverflow(page) {
  const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert(widths.document <= widths.viewport + 1 && widths.body <= widths.viewport + 1, `Horizontal page overflow: ${JSON.stringify(widths)}`);
}
async function expectOverviewGraphs(page) {
  await expect.poll(() => page.locator('.chart-container .recharts-area-curve').evaluateAll(paths => paths.some(path => {
    const box = path.getBBox(); return !!path.getAttribute('d') && box.width > 10 && box.height > 1;
  })), { timeout: 15000, message: 'Cash-flow chart must contain a non-flat plotted data path' }).toBe(true);
  await expect.poll(() => page.locator('.allocation-chart path.recharts-sector').evaluateAll(paths => paths.filter(path => {
    const box = path.getBBox(); return !!path.getAttribute('d') && box.width > 1 && box.height > 1;
  }).length), { timeout: 15000, message: 'Allocation chart must contain actual pie sectors' }).toBeGreaterThan(0);
}
async function journey(name, work) {
  const start = Date.now();
  await work(); passed++;
  console.log(`PASS ${passed}: ${name} (${Date.now() - start}ms)`);
}
async function waitForOfflineShell(page) {
  await page.waitForFunction(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    return registrations.some(registration => registration.active?.state === 'activated');
  }, null, { timeout: 120000 });
  if (!await page.evaluate(() => !!navigator.serviceWorker.controller)) await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  const manifest = await page.locator('link[rel="manifest"]').getAttribute('href');
  assert(manifest, 'Production PWA manifest missing');
  const result = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    return { scope: registration.scope, keys, controlled: !!navigator.serviceWorker.controller };
  });
  assert(result.keys.some(key => /precache/.test(key)), 'Production shell precache missing');
  return result;
}
function observe(page) {
  currentPage = page;
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const source = message.location().url || '';
    // A static Pages-style finance test deliberately has no market-data gateway.
    if (!liveSource && /Failed to load resource/.test(message.text()) && (source.includes('/api/') || /ERR_INTERNET_DISCONNECTED/.test(message.text()))) return;
    consoleErrors.push(`${message.text()} ${source}`.trim());
  });
}

async function liveQuote(page, symbol) {
  const row = main(page).locator('table tbody tr').filter({ has: page.getByRole('button', { name: symbol, exact: true }) });
  await expect(row).toHaveCount(1, { timeout: 60000 });
  await expect(row.locator('td').nth(1)).toContainText('USD', { timeout: 90000 });
  const cells = await row.locator('td').allTextContents();
  const value = Number(cells[1].replace(/[^0-9.+-]/g, ''));
  const asOf = cells[3].match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const source = cells[4].trim();
  assert(Number.isFinite(value) && value > 0, `${symbol}: no actual positive quote`);
  assert(asOf && Number.isFinite(Date.parse(asOf)), `${symbol}: source date missing`);
  assert(source && !/awaiting|sample|demo|fixture|synthetic/i.test(source), `${symbol}: unverified source label ${source}`);
  if (staticSource) {
    assert(/^Crible daily mirror\b/.test(source), `${symbol}: static mode must prove the direct public Crible mirror, got ${source}`);
    assert(cells[3].includes('Daily close'), `${symbol}: mirror quote must identify its daily close`);
  }
  await row.getByRole('button', { name: symbol, exact: true }).click();
  const detail = main(page).locator('.card').filter({ has: page.getByRole('button', { name: 'Add to Investments', exact: true }) });
  await expect(detail).toHaveCount(1);
  await expect(detail.locator('.section-title .eyebrow')).toContainText('USD');
  const detailSource = await detail.locator('p.helper').first().innerText();
  assert(detailSource.includes(source) && detailSource.includes(asOf), `${symbol}: original source/date missing in detail`);
  const sourceUrl = await detail.locator('a.source-link').getAttribute('href');
  assert(sourceUrl && new URL(sourceUrl).protocol === 'https:', `${symbol}: original source URL missing`);
  const observation = { symbol, value, currency: 'USD', asOf, source, sourceUrl, sourceDetail: detailSource, observedAt: new Date().toISOString() };
  liveObservations[symbol] = observation;
  console.log(`ACTUAL ${symbol}: ${JSON.stringify(observation)}`);
  return { detail, observation };
}

async function runLiveSource() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: 'Asia/Manila' });
  const page = await context.newPage(); observe(page); page.setDefaultTimeout(30000);
  page.on('request', request => { if (request.url().startsWith('https://maxgfr.github.io/crible/data/')) livePublicRequests.add(new URL(request.url()).origin + new URL(request.url()).pathname); });
  page.on('requestfailed', request => {
    try {
      const url = new URL(request.url());
      // Log public host/path only. Do not capture headers, credentials or query strings.
      liveNetworkErrors.push({ endpoint: url.origin + url.pathname, error: request.failure()?.errorText || 'Request failed' });
    } catch { liveNetworkErrors.push({ endpoint: 'Unknown public request', error: 'Request failed' }); }
  });
  // No route interception: this branch verifies the browser's real CORS/network path.
  await page.goto(liveUrl.href + '#/markets', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(/Markets beyond borders/);
  await journey('actual United States starter quote has USD, its original source and source date', async () => {
    await main(page).getByLabel('Stock market', { exact: true }).selectOption('US');
    await liveQuote(page, 'US:AAPL');
    await expect(main(page).getByRole('button', { name: 'US:AMD', exact: true })).toHaveCount(0);
    await screenshot(page, `${sourceArtifact}-aapl.png`);
  });
  await journey('actual AMD outside starters can be searched and saved without personal finance records', async () => {
    await main(page).getByLabel('Company or ticker', { exact: true }).fill('AMD');
    const search = main(page).getByRole('button', { name: 'Search', exact: true });
    await expect(search).toBeEnabled({ timeout: 90000 }); await search.click();
    const { detail, observation } = await liveQuote(page, 'US:AMD');
    await detail.getByRole('button', { name: 'Add to Investments', exact: true }).click();
    await expect.poll(async () => (await readLedger(page)).instruments.some(instrument => instrument.sourceSymbol === 'US:AMD'), { timeout: 30000 }).toBe(true);
    const data = await readLedger(page), instrument = data.instruments.find(instrument => instrument.sourceSymbol === 'US:AMD');
    assert.equal(instrument.currency, 'USD'); assert.equal(instrument.instrumentType, 'FOREIGN_STOCK');
    const price = data.prices.find(price => price.instrumentId === instrument.id);
    assert(price && Number.isFinite(price.value) && price.value > 0);
    assert(Math.abs(price.value - observation.value) < .005000001, 'Stored quote differs from the source value displayed at USD precision'); assert.equal(price.currency, 'USD');
    assert.equal(price.asOf.slice(0, 10), observation.asOf); assert.equal(price.source, observation.source);
    assert.equal(data.accounts.length, 0); assert.equal(data.transactions.length, 0);
    liveObservations.savedInvestment = { symbol: instrument.sourceSymbol, currency: instrument.currency, value: price.value, source: price.source, asOf: price.asOf, status: price.status };
    await screenshot(page, `${sourceArtifact}-amd.png`);
  });
  await journey('actual sourced investment metadata and price persist across production reload', async () => {
    await openRoute(page, '/investments'); await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(/Your investments/);
    const data = await readLedger(page), instrument = data.instruments.find(instrument => instrument.sourceSymbol === 'US:AMD');
    assert(instrument && data.prices.some(price => price.instrumentId === instrument.id && price.source === liveObservations['US:AMD'].source));
    assert.equal(data.accounts.length, 0); assert.equal(data.transactions.length, 0);
    await expect(page.locator('.investment-card')).toHaveCount(1);
    await expect(page.locator('.investment-card .value')).toHaveText('—');
    await noOverflow(page); await screenshot(page, `${sourceArtifact}-investment.png`);
  });
  assert.deepEqual(runtimeErrors, [], 'Unexpected live browser runtime exceptions');
  if (staticSource) {
    assert([...livePublicRequests].some(url => url.endsWith('/manifest.json')), 'Static source did not fetch the actual public manifest');
    assert([...livePublicRequests].some(url => url.endsWith('/universe.parquet')), 'Static source did not fetch the actual public catalog');
    assert([...livePublicRequests].some(url => /\/prices-\d{2}\.parquet$/.test(url)), 'Static source did not fetch actual public price data');
  }
  await writeFile(resolve(artifacts, sourceResultsFile), JSON.stringify({ passed, testedAt: new Date().toISOString(), productionPreview: liveUrl.href, liveSource: true, staticSource, interceptedRequests: false, observations: liveObservations, publicRequests: [...livePublicRequests], runtimeErrors, consoleErrors, networkErrors: liveNetworkErrors }, null, 2));
  console.log(`${passed} actual-source finance browser journeys passed. Public source observations and diagnostics: artifacts/${sourceResultsFile}.`);
}

async function runPublicMirrorDiagnostic() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage(); observe(page); page.setDefaultTimeout(30000);
  const base = 'https://maxgfr.github.io/crible/data/';
  const network = [], pending = [];
  const headerNames = ['content-length', 'content-range', 'content-encoding', 'accept-ranges', 'access-control-allow-origin', 'access-control-expose-headers'];
  page.on('response', response => {
    if (!response.url().startsWith(base)) return;
    pending.push((async () => {
      const headers = await response.allHeaders();
      network.push({ file: response.url().slice(base.length), method: response.request().method(), range: response.request().headers()['range'] || null, status: response.status(), headers: Object.fromEntries(headerNames.map(name => [name, headers[name] || null])) });
    })().catch(error => network.push({ error: String(error) })));
  });
  await page.goto(liveUrl.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible();
  async function probe(file, method = 'GET', range = null, maximumBytes = 1024 * 1024) {
    const result = await page.evaluate(async ({ url, method, range, maximumBytes }) => {
      const started = performance.now();
      try {
        const response = await fetch(url, { method, mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', headers: range ? { Range: range } : {}, signal: AbortSignal.timeout(30000) });
        const headers = Object.fromEntries(['content-length', 'content-range', 'content-encoding', 'accept-ranges', 'access-control-allow-origin', 'access-control-expose-headers'].map(name => [name, response.headers.get(name)]));
        let bytes = new Uint8Array(0), truncated = false;
        if (method !== 'HEAD' && response.body) {
          const reader = response.body.getReader(), chunks = []; let length = 0;
          while (true) {
            const next = await reader.read(); if (next.done) break;
            if (length + next.value.length > maximumBytes) { const remaining = maximumBytes - length; if (remaining > 0) chunks.push(next.value.slice(0, remaining)); length = maximumBytes; truncated = true; await reader.cancel(); break; }
            chunks.push(next.value); length += next.value.length;
          }
          bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        }
        const readable = values => [...values].map(byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
        let manifest = null;
        if (url.endsWith('/manifest.json') && !truncated) { try { const parsed = JSON.parse(new TextDecoder().decode(bytes)); manifest = { schema: parsed.schema, generatedAt: parsed.generated_at, universeRows: parsed.universe_rows, pricesMaxDate: parsed.prices?.max_date, shards: parsed.prices?.shards?.map(shard => ({ file: shard.file, bytes: shard.bytes, minSymbol: shard.min_symbol, maxSymbol: shard.max_symbol })) }; } catch {} }
        return { method, range, status: response.status, type: response.type, exposedHeaders: headers, bodyLength: bytes.length, bodyTruncated: truncated, firstMagic: readable(bytes.slice(0, 4)), lastMagic: readable(bytes.slice(-4)), manifest, elapsedMs: Math.round(performance.now() - started) };
      } catch (error) { return { method, range, error: String(error), elapsedMs: Math.round(performance.now() - started) }; }
    }, { url: base + file, method, range, maximumBytes });
    const record = { file, ...result }; mirrorObservations.push(record);
    console.log(`PUBLIC MIRROR ${JSON.stringify(record)}`);
    return result;
  }
  const manifest = await probe('manifest.json');
  const head = await probe('universe.parquet', 'HEAD');
  await probe('universe.parquet', 'GET', 'bytes=0-3', 65536);
  const length = Number(head.exposedHeaders?.['content-length']);
  await probe('universe.parquet', 'GET', Number.isSafeInteger(length) && length >= 8 ? `bytes=${length - 8}-${length - 1}` : 'bytes=-8', 65536);
  // A bounded full read compares decoded body size with HEAD size and tests the
  // browser-only path needed when CORS hides Content-Range or gzip changes HEAD.
  await probe('universe.parquet', 'GET', null, 32 * 1024 * 1024);
  const shard = manifest.manifest?.shards?.find(shard => shard.minSymbol <= 'AAPL' && shard.maxSymbol >= 'AAPL') || manifest.manifest?.shards?.[0];
  if (shard && /^prices-\d{2}\.parquet$/.test(shard.file) && Number.isSafeInteger(shard.bytes) && shard.bytes >= 12) {
    await probe(shard.file, 'GET', 'bytes=0-3', 65536);
    await probe(shard.file, 'GET', `bytes=${shard.bytes - 8}-${shard.bytes - 1}`, 65536);
  }
  await Promise.allSettled(pending);
  await writeFile(resolve(artifacts, 'finance-public-mirror-diagnostic.json'), JSON.stringify({ testedAt: new Date().toISOString(), browserOrigin: liveUrl.origin, publicMirror: true, interceptedRequests: false, probes: mirrorObservations, networkHeaders: network, runtimeErrors, consoleErrors }, null, 2));
  console.log('Browser mirror diagnostics saved to artifacts/finance-public-mirror-diagnostic.json. No quote fixtures or request interception used.');
}

try {
  await mkdir(artifacts, { recursive: true });
  if (staticSource || !liveSource && !publicMirror) server = await startStaticServer();
  if (staticSource) liveUrl.href = `http://127.0.0.1:${server.address().port}/`;
  const origin = server ? `http://127.0.0.1:${server.address().port}` : liveUrl.origin;
  browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--disable-background-networking', '--no-first-run', '--no-default-browser-check'] });
  if (publicMirror) await runPublicMirrorDiagnostic();
  else if (liveSource) await runLiveSource();
  else {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: 'Asia/Manila', acceptDownloads: true, reducedMotion: 'reduce' });
  const page = await context.newPage(); observe(page); page.setDefaultTimeout(15000);
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(/A little clarity/);

  await journey('empty private ledger has no invented personal balances', async () => {
    const data = await readLedger(page);
    assert.equal(data.accounts.length, 0); assert.equal(data.transactions.length, 0); assert.equal(data.instruments.length, 0);
    await expect(page.locator('.worth-card .metric-value')).toHaveText('—');
    await expect(page.getByText('Add your first account', { exact: true }).first()).toBeVisible();
    await noOverflow(page);
    await screenshot(page, 'finance-empty-desktop.png');
  });
  await journey('actual opening balances, account flags and native dialog Escape', async () => {
    await createAccount(page, { name: 'QA Savings', opening: '10000', fire: true });
    await createAccount(page, { name: 'QA Wallet', type: 'EWALLET', opening: '1000' });
    await createAccount(page, { name: 'QA Brokerage', type: 'BROKERAGE', fire: true });
    await createAccount(page, { name: 'QA Card', type: 'CREDIT_CARD', opening: '500' });
    const data = await readLedger(page);
    assert(data.accounts.find(account => account.name === 'QA Savings').includeInFire);
    await page.locator('.account-card').filter({ has: page.getByRole('heading', { name: 'QA Savings', exact: true }) }).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(dialog(page)).toHaveCount(1); await page.keyboard.press('Escape'); await expect(dialog(page)).toHaveCount(0);
    await netWorth(page, 1050000);
  });
  await journey('income, expense, transfer and credit-card payment reconcile without duplicate spending', async () => {
    await recordTransaction(page, { type: 'INCOME', amount: 2000, category: 'Salary', merchant: 'QA Salary' });
    await recordTransaction(page, { amount: 300, category: 'Food', merchant: 'QA Grocery' });
    await recordTransaction(page, { type: 'TRANSFER', to: 'QA Wallet', amount: 1000, notes: 'QA Wallet funding' });
    await recordTransaction(page, { account: 'QA Card', amount: 200, category: 'Food', merchant: 'QA Card purchase' });
    await recordTransaction(page, { type: 'TRANSFER', to: 'QA Card', amount: 250, notes: 'QA Card payment' });
    await expectBalance(page, 'QA Savings', 1045000); await expectBalance(page, 'QA Wallet', 200000); await expectBalance(page, 'QA Card', 45000);
    const data = await readLedger(page), payment = data.transactions.find(transaction => transaction.notes === 'QA Card payment');
    assert.equal(payment.type, 'TRANSFER');
    const postings = data.postings.filter(posting => posting.transactionId === payment.id);
    assert.equal(postings.length, 2); assert(postings.every(posting => posting.delta === -25000));
    await netWorth(page, 1200000);
    await expect(page.locator('.mini-stat-row').getByText(minorMoney(150000), { exact: true })).toBeVisible();
    await expect(page.locator('.savings-card .metric-value')).toHaveText('75.0%');
  });
  await journey('edit and delete regenerate balances and remove stale postings', async () => {
    await openRoute(page, '/transactions');
    await page.getByRole('button', { name: `Edit QA Grocery from ${today}`, exact: true }).click();
    await dialog(page).getByLabel('Amount (PHP)', { exact: true }).fill('375'); await saveDialog(page, 'Save transaction');
    await expectBalance(page, 'QA Savings', 1037500); await netWorth(page, 1192500);
    await openRoute(page, '/transactions'); await page.getByRole('button', { name: `Delete QA Grocery from ${today}`, exact: true }).click();
    await saveDialog(page, 'Delete transaction');
    await expect(page.getByRole('button', { name: `Edit QA Grocery from ${today}`, exact: true })).toHaveCount(0);
    await expectBalance(page, 'QA Savings', 1075000); await netWorth(page, 1230000);
    const data = await readLedger(page); assert(!data.transactions.some(transaction => transaction.merchant === 'QA Grocery'));
  });
  await journey('investment purchase exchanges cash for units and manual valuation preserves net worth', async () => {
    await recordTransaction(page, { type: 'TRANSFER', to: 'QA Brokerage', amount: 1000, notes: 'QA investment funding' });
    await openRoute(page, '/investments'); await main(page).getByRole('button', { name: 'Add investment', exact: true }).click();
    await dialog(page).getByLabel('Investment name', { exact: true }).fill('QA Fund');
    await dialog(page).getByLabel('Valuation method', { exact: true }).selectOption('MANUAL_PRICE');
    await saveDialog(page, 'Save investment');
    const card = page.locator('.investment-card').filter({ has: page.getByRole('heading', { name: 'QA Fund', exact: true }) });
    await card.getByRole('button', { name: 'Record activity', exact: true }).click();
    await chooseAccount(dialog(page).getByLabel('Account', { exact: true }), 'QA Brokerage');
    await dialog(page).getByLabel('Units', { exact: true }).fill('10'); await dialog(page).getByLabel('Unit price (PHP)', { exact: true }).fill('100');
    await saveDialog(page, 'Record activity'); await expectBalance(page, 'QA Brokerage', 0);
    await openRoute(page, '/'); await expect(page.locator('.worth-card .metric-value')).toHaveText('—');
    await openRoute(page, '/investments'); await card.getByRole('button', { name: 'Manual valuation', exact: true }).click();
    await dialog(page).getByLabel('Price per unit / NAV (PHP)', { exact: true }).fill('100');
    await dialog(page).getByLabel('Valuation date', { exact: true }).fill(today); await saveDialog(page, 'Save valuation');
    await expect(card.locator('.value')).toHaveText(minorMoney(100000));
    const data = await readLedger(page), buy = data.transactions.find(transaction => transaction.type === 'INVESTMENT_BUY');
    assert.equal(buy.units, 10); assert.equal(buy.amount, 100000);
    await netWorth(page, 1230000); await expect(page.locator('.savings-card .metric-value')).toHaveText('90.0%');
    await expectOverviewGraphs(page);
    await screenshot(page, 'finance-desktop.png');
  });
  await journey('budgets count purchases once and recurring rules require an explicit confirmation', async () => {
    await openRoute(page, '/budgets'); await main(page).getByRole('button', { name: 'Create budget', exact: true }).click();
    await dialog(page).getByLabel('Expense category', { exact: true }).selectOption({ label: 'Food' });
    await dialog(page).getByLabel('Budget amount (PHP)', { exact: true }).fill('1000'); await saveDialog(page, 'Save budget');
    const food = page.locator('.budget-card').filter({ has: page.getByRole('heading', { name: 'Food', exact: true }) });
    await expect(food.locator('.budget-main').getByText(minorMoney(20000), { exact: true })).toBeVisible();
    await expect(food.locator('progress')).toHaveAttribute('value', '20');
    await main(page).getByRole('button', { name: 'Add rule', exact: true }).click();
    await dialog(page).getByLabel('Rule name', { exact: true }).fill('QA Subscription');
    await chooseAccount(dialog(page).getByLabel('Account', { exact: true }), 'QA Savings');
    await dialog(page).getByLabel('Amount (PHP)', { exact: true }).fill('15');
    await dialog(page).getByLabel('Category', { exact: true }).selectOption({ label: 'Subscriptions' });
    await saveDialog(page, 'Save rule');
    let data = await readLedger(page); assert(!data.transactions.some(transaction => transaction.notes?.includes('QA Subscription'))); assert.equal(data.recurringOccurrences.length, 0);
    const rule = page.locator('.recurring-row').filter({ hasText: 'QA Subscription' });
    await rule.getByRole('button', { name: /Confirm/, exact: true }).click(); await saveDialog(page, 'Record occurrence');
    await expect.poll(async () => (await readLedger(page)).recurringOccurrences.length).toBe(1);
    data = await readLedger(page); assert(data.recurringRules.find(rule => rule.name === 'QA Subscription').nextDate > today);
    assert.equal(data.transactions.filter(transaction => transaction.id.startsWith('recurring:')).length, 1);
    await expectBalance(page, 'QA Savings', 973500);
  });
  await journey('actual debt balances remain separate from declared terms and amortization projections', async () => {
    await openRoute(page, '/debts');
    const card = page.locator('.debt-card').filter({ has: page.getByRole('heading', { name: 'QA Card', exact: true }) });
    await expect(card.locator('.account-balance')).toHaveText(minorMoney(45000));
    await expect(card.locator('.ledger-metrics > div').filter({ hasText: 'Recorded repayments' }).locator('dd')).toHaveText(minorMoney(25000));
    await card.getByRole('button', { name: 'Enter debt terms', exact: true }).click();
    await dialog(page).getByLabel(/^Original principal/).fill('500');
    await dialog(page).getByLabel('Annual interest rate (%)', { exact: true }).fill('12');
    await dialog(page).getByLabel('Minimum payment (PHP)', { exact: true }).fill('100');
    await dialog(page).getByLabel('Monthly due day (optional)', { exact: true }).fill('15');
    await dialog(page).getByLabel(/^Projection term/).fill('12'); await saveDialog(page, 'Save debt terms');
    await expect(card.getByText('Projection · assumptions', { exact: true })).toBeVisible();
    await card.getByText('View projected amortization', { exact: true }).click();
    await expect(card.locator('.debt-projection tbody tr')).toHaveCount(12);
    await expect(card.locator('.debt-projection tbody tr').last().locator('td').last()).toHaveText(minorMoney(0));
    await expectBalance(page, 'QA Card', 45000); await expectBalance(page, 'QA Savings', 973500);
    const data = await readLedger(page); assert.equal(data.liabilityTerms.length, 1);
    assert.equal(data.liabilityTerms[0].annualInterestRate, .12); assert.equal(data.liabilityTerms[0].principal, 50000);
    await screenshot(page, 'finance-debt-projection.png');
  });
  await journey('statement preview skips duplicates within a file and on reimport', async () => {
    await openRoute(page, '/data');
    const csv = `date,amount,merchant,reference\r\n${today},-25.50,QA Imported expense,QA-CSV-1\r\n${today},40,QA Imported income,QA-CSV-2\r\n${today},-25.50,QA Imported expense,QA-CSV-1\r\n`;
    await main(page).getByLabel('Statement CSV', { exact: true }).setInputFiles({ name: 'qa-statement.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(main(page).getByLabel('Amount column', { exact: true })).toHaveValue('amount');
    await chooseAccount(main(page).getByLabel('Statement account', { exact: true }), 'QA Savings');
    await main(page).getByRole('button', { name: 'Preview import', exact: true }).click();
    await expect(page.getByText('2 new rows · 1 duplicates detected', { exact: true })).toBeVisible();
    await main(page).getByRole('button', { name: 'Import reviewed rows', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Imported 2 rows; skipped 1 duplicates.');
    await expectBalance(page, 'QA Savings', 974950);
    await main(page).getByRole('button', { name: 'Preview import', exact: true }).click();
    await expect(page.getByText('0 new rows · 3 duplicates detected', { exact: true })).toBeVisible();
    await main(page).getByRole('button', { name: 'Import reviewed rows', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Imported 0 rows; skipped 3 duplicates.');
    await expectBalance(page, 'QA Savings', 974950);
    const downloadEvent = page.waitForEvent('download'); await main(page).getByRole('button', { name: 'Transactions CSV', exact: true }).click();
    const download = await downloadEvent; await download.saveAs(resolve(artifacts, 'finance-transactions.csv'));
    const exported = await readFile(resolve(artifacts, 'finance-transactions.csv'), 'utf8'); assert(exported.includes('QA Imported expense')); assert(exported.includes('INVESTMENT_BUY'));
  });
  await journey('reload restores IndexedDB entries, manual prices and local-only privacy', async () => {
    const before = await readLedger(page); await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(/safe home/);
    const after = await readLedger(page); assert.deepEqual(after.accounts, before.accounts); assert.deepEqual(after.transactions, before.transactions); assert.deepEqual(after.prices, before.prices);
    assert(!after.settings.some(setting => setting.key === 'privacyMode' && setting.value === 'CLOUD_SYNC'));
    await expectBalance(page, 'QA Savings', 974950);
    const shell = await waitForOfflineShell(page); assert.equal(new URL(shell.scope).pathname, '/');
  });
  await journey('production shell reloads offline and saves a transaction with no server', async () => {
    await context.setOffline(true); await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(/safe home/);
    await expect(page.locator('.connection-status')).toContainText('Offline');
    await recordTransaction(page, { amount: 12.34, category: 'Food', merchant: 'QA Offline purchase' });
    await expectBalance(page, 'QA Savings', 973716);
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(/Your transactions/);
    await expect(page.getByRole('button', { name: `Edit QA Offline purchase from ${today}`, exact: true })).toBeVisible();
    const data = await readLedger(page); assert.equal(data.transactions.filter(transaction => transaction.merchant === 'QA Offline purchase').length, 1);
  });
  await journey('all routes and mobile navigation remain usable offline without page overflow', async () => {
    for (const [path] of routes) { await openRoute(page, path); await noOverflow(page); }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [path] of routes) { await openRoute(page, path); await noOverflow(page); }
    await openRoute(page, '/'); await expectOverviewGraphs(page); await screenshot(page, 'finance-mobile.png');
    await openRoute(page, '/accounts'); await screenshot(page, 'finance-mobile-accounts.png');
    await page.locator('.quick-add').click(); await expect(dialog(page)).toHaveCount(1); await page.keyboard.press('Escape'); await expect(dialog(page)).toHaveCount(0);
    await screenshot(page, 'finance-mobile-transactions.png');
  });

  await journey('failed market refresh retains the saved valuation, original date and stale label after reload', async () => {
    await context.setOffline(false); await page.setViewportSize({ width: 1440, height: 1100 });
    await openRoute(page, '/investments'); await main(page).getByRole('button', { name: 'Add investment', exact: true }).click();
    await dialog(page).getByLabel('Investment name', { exact: true }).fill('QA Saved-price failure');
    await dialog(page).getByLabel('Valuation method', { exact: true }).selectOption('LIVE_MARKET');
    await dialog(page).getByLabel('Provider ticker (optional)', { exact: true }).fill('QAEXTERNAL');
    await saveDialog(page, 'Save investment');
    const card = page.locator('.investment-card').filter({ has: page.getByRole('heading', { name: 'QA Saved-price failure', exact: true }) });
    const savedDate = new Date(Date.parse(`${today}T12:00:00Z`) - 2 * 86400000).toISOString().slice(0, 10);
    await card.getByRole('button', { name: 'Manual valuation', exact: true }).click();
    await dialog(page).getByLabel('Price per unit / NAV (PHP)', { exact: true }).fill('1');
    await dialog(page).getByLabel('Valuation date', { exact: true }).fill(savedDate);
    await dialog(page).getByLabel('Source / statement reference', { exact: true }).fill('QA declared statement value · isolated acceptance only');
    await saveDialog(page, 'Save valuation');
    await card.getByRole('button', { name: 'Record activity', exact: true }).click();
    await chooseAccount(dialog(page).getByLabel('Account', { exact: true }), 'QA Savings');
    await dialog(page).getByLabel('Units', { exact: true }).fill('1'); await dialog(page).getByLabel('Unit price (PHP)', { exact: true }).fill('1');
    await saveDialog(page, 'Record activity');
    await expect(card.locator('.value')).toHaveText(minorMoney(100));
    const before = await readLedger(page), instrument = before.instruments.find(instrument => instrument.name === 'QA Saved-price failure');
    const savedPrices = before.prices.filter(price => price.instrumentId === instrument.id);
    assert.equal(savedPrices.length, 1); assert.equal(savedPrices[0].asOf, savedDate); assert.equal(savedPrices[0].value, 1);
    await card.getByRole('button', { name: 'Refresh price', exact: true }).click();
    await expect(card.getByText('Saved price · stale', { exact: true })).toBeVisible();
    await expect(card.getByRole('status')).toContainText('The saved valuation is retained.');
    await expect(card.locator('.value')).toHaveText(minorMoney(100));
    await expect(card.locator('p.helper').filter({ hasText: 'Price as of' })).toContainText(savedDate);
    const after = await readLedger(page); assert.deepEqual(after.prices.filter(price => price.instrumentId === instrument.id), savedPrices);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(/Your investments/);
    await expect(card.getByText('Saved price · stale', { exact: true })).toBeVisible();
    await expect(card.locator('.value')).toHaveText(minorMoney(100));
    await expect(card.locator('p.helper').filter({ hasText: 'Price as of' })).toContainText(savedDate);
    await screenshot(page, 'finance-cached-price-failure.png');
    await expectBalance(page, 'QA Savings', 973616); await netWorth(page, 1228716);
  });

  await journey('repository subpath has its own service-worker scope and reloads offline', async () => {
    const mounted = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Manila' });
    const mountedPage = await mounted.newPage(); observe(mountedPage); mountedPage.setDefaultTimeout(15000);
    await mountedPage.goto(origin + '/finance-check/', { waitUntil: 'domcontentloaded' });
    await expect(main(mountedPage).getByRole('heading', { level: 1 })).toHaveText(/A little clarity/);
    const manifest = await mountedPage.locator('link[rel="manifest"]').getAttribute('href');
    assert(new URL(manifest, mountedPage.url()).pathname.startsWith('/finance-check/'));
    const shell = await waitForOfflineShell(mountedPage); assert.equal(new URL(shell.scope).pathname, '/finance-check/');
    await mounted.setOffline(true); await mountedPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(main(mountedPage).getByRole('heading', { level: 1 })).toHaveText(/A little clarity/);
    await createAccount(mountedPage, { name: 'QA Subpath cash', type: 'CASH', opening: '20' });
    await mountedPage.reload({ waitUntil: 'domcontentloaded' });
    await expectBalance(mountedPage, 'QA Subpath cash', 2000); await noOverflow(mountedPage);
    await screenshot(mountedPage, 'finance-mobile-subpath.png'); await mounted.close(); currentPage = page;
  });
  assert.deepEqual(runtimeErrors, [], 'Unexpected browser runtime exceptions');
  assert.deepEqual(consoleErrors, [], 'Unexpected browser console errors');
  await writeFile(resolve(artifacts, 'finance-browser-results.json'), JSON.stringify({ passed, testedAt: new Date().toISOString(), productionBuild: true, offline: true, repositorySubpath: true, runtimeErrors, consoleErrors }, null, 2));
  console.log(`${passed} finance browser journeys passed. Artifacts: finance-desktop.png, finance-mobile.png, finance-mobile-subpath.png.`);
  }
} catch (error) {
  console.error(error.stack || error);
  if (currentPage && !currentPage.isClosed()) await screenshot(currentPage, publicMirror ? 'finance-public-mirror-failure.png' : staticSource ? 'finance-static-source-failure.png' : liveSource ? 'finance-live-source-failure.png' : 'finance-browser-failure.png').catch(() => {});
  await mkdir(artifacts, { recursive: true });
  await writeFile(resolve(artifacts, publicMirror ? 'finance-public-mirror-diagnostic.json' : liveSource ? sourceResultsFile : 'finance-browser-results.json'), JSON.stringify({ passed, failed: String(error), liveSource, staticSource, publicMirror, observations: publicMirror ? mirrorObservations : liveSource ? liveObservations : undefined, publicRequests: liveSource ? [...livePublicRequests] : undefined, runtimeErrors, consoleErrors, networkErrors: liveSource ? liveNetworkErrors : undefined }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
}
