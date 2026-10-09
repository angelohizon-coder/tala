import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalGateway, createMemoryCache } from '../tools/local-gateway.mjs';
import { startServer } from '../tools/serve.mjs';

const PORT = 5180;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const project = fileURLToPath(new URL('../', import.meta.url));
const TOKEN = 'fictional-local-test-token';
const freeStatus = { freeAvailable: true, freeApiBase: '/api/public', freeSource: 'PSE EDGE / Yahoo Finance', markets: ['PH','US','HK','JP','GB','CA','AU'], globalSearch: true };
const request = (path, options = {}) => new Request(`${ORIGIN}/api/${path}`, options);
const configRequest = (body = { token: TOKEN, personalUse: true }, headers = {}) => request('config', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers }, body: JSON.stringify(body),
});
async function fixture(t, options = {}) {
  const parent = join(project, 'artifacts', 'local-gateway-tests');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'case-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(parent));
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = join(directory, '.local-market.json');
  const calls = [];
  const factoryOptions = [];
  const workerFactory = options.workerFactory ?? (settings => {
    factoryOptions.push(settings);
    return { fetch: async (req, env) => {
      calls.push({ request: req, env });
      return new Response(JSON.stringify({ quotes: [{ symbol: 'AC', value: 500 }] }), { headers: { 'Content-Type': 'application/json' } });
    } };
  });
  const gateway = await createLocalGateway({ port: PORT, configPath, workerFactory, ...options });
  return { gateway, configPath, directory, calls, factoryOptions };
}

test('importing local server is inert and status never exposes a credential', async t => {
  assert.equal(typeof startServer, 'function');
  const { gateway } = await fixture(t);
  assert.deepEqual(await (await gateway.handle(request('status'))).json(), { configured: false, provider: 'EODHD', personalUse: false, ...freeStatus });
  assert.equal((await gateway.handle(request('quotes?symbols=AC'))).status, 503);
  assert.equal((await gateway.handle(request('config'))).status, 405);
});

test('explicit same-origin personal configuration is saved atomically outside site and forwards safely', async t => {
  const { gateway, configPath, directory, calls, factoryOptions } = await fixture(t);
  const configured = await gateway.handle(configRequest());
  assert.equal(configured.status, 200);
  const publicBody = await configured.text();
  assert.ok(!publicBody.includes(TOKEN));
  assert.deepEqual(JSON.parse(publicBody), { configured: true, provider: 'EODHD', personalUse: true, ...freeStatus });
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { token: TOKEN, personalUse: true });
  assert.deepEqual(await readdir(directory), ['.local-market.json']);
  const response = await gateway.handle(request('quotes?symbols=AC', { headers: { Origin: ORIGIN, Authorization: 'must-not-forward' } }));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.url, `${ORIGIN}/quotes?symbols=AC`);
  assert.equal(calls[0].request.headers.get('Authorization'), null);
  assert.equal(calls[0].env.EODHD_TOKEN, TOKEN);
  assert.equal(calls[0].env.PRIVATE_LOCAL_USE_CONFIRMED, 'true');
  assert.equal(calls[0].env.PUBLIC_DISPLAY_LICENSED, 'false');
  assert.ok(factoryOptions.every(option => option.privateLocalUse === true));
  assert.equal(factoryOptions.length, 2);
  const restarted = await createLocalGateway({ port: PORT, configPath });
  assert.deepEqual(await (await restarted.handle(request('status'))).json(), { configured: true, provider: 'EODHD', personalUse: true, ...freeStatus });
});

test('host spoofing, remote origins, missing/null origins and sibling loopback origins cannot configure', async t => {
  const { gateway, directory } = await fixture(t);
  const headers = { 'Content-Type': 'application/json' };
  for (const Origin of [undefined, 'null', 'https://evil.test', `http://localhost:${PORT}`, `${ORIGIN}.evil.test`, 'http://127.0.0.1:1234']) {
    const req = request('config', { method: 'POST', headers: { ...headers, ...(Origin === undefined ? {} : { Origin }) }, body: JSON.stringify({ token: TOKEN, personalUse: true }) });
    assert.equal((await gateway.handle(req)).status, 403);
  }
  assert.equal((await gateway.handle(configRequest(undefined, { Host: 'evil.test' }))).status, 403);
  assert.equal((await gateway.handle(new Request('http://evil.test:5180/api/status'))).status, 403);
  assert.equal((await gateway.handle(new Request('http://127.0.0.1:9999/api/status'))).status, 403);
  assert.deepEqual(await readdir(directory), []);
});

test('configuration rejects malformed tokens/schema without reflecting secrets or saving partial data', async t => {
  const { gateway, directory } = await fixture(t);
  for (const body of [null, [], {}, { token: TOKEN }, { token: TOKEN, personalUse: false }, { token: TOKEN, personalUse: 'true' }, { token: TOKEN, personalUse: true, extra: 'unexpected' }]) {
    assert.equal((await gateway.handle(configRequest(body))).status, 400);
  }
  for (const token of [null, undefined, '', 'short', 'x'.repeat(201), 'contains whitespace', 'newline\nvalue', 'unicode-é-token', 'foo&bar=token', 'https://token.example', 'query?token', 'percent%0Atoken']) {
    const response = await gateway.handle(configRequest({ token, personalUse: true }));
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes(TOKEN));
  }
  const wrongType = configRequest(undefined, { 'Content-Type': 'text/plain' });
  assert.equal((await gateway.handle(wrongType)).status, 415);
  const malformed = request('config', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal((await gateway.handle(malformed)).status, 400);
  assert.deepEqual(await readdir(directory), []);
});

test('configuration bounds streaming bodies and times out stalled clients', async t => {
  const { gateway, directory } = await fixture(t, { timeoutMs: 15 });
  const oversized = request('config', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: ' '.repeat(4097) });
  assert.equal((await gateway.handle(oversized)).status, 413);
  const declaredOversized = configRequest(undefined, { 'Content-Length': '4097' });
  assert.equal((await gateway.handle(declaredOversized)).status, 413);
  const stalled = request('config', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: new ReadableStream({ start() {} }), duplex: 'half' });
  assert.equal((await gateway.handle(stalled)).status, 408);
  assert.deepEqual(await readdir(directory), []);
});

test('startup env token never assumes personal-use approval and malformed saved files are ignored', async t => {
  const { configPath } = await fixture(t);
  for (const env of [{ EODHD_TOKEN: TOKEN }, { EODHD_TOKEN: TOKEN, PRIVATE_LOCAL_USE_CONFIRMED: 'false' }, { EODHD_TOKEN: TOKEN, PRIVATE_LOCAL_USE_CONFIRMED: true }]) {
    const gateway = await createLocalGateway({ port: PORT, configPath, env });
    assert.equal((await (await gateway.handle(request('status'))).json()).configured, false);
  }
  const approved = await createLocalGateway({ port: PORT, configPath, env: { EODHD_TOKEN: TOKEN, PRIVATE_LOCAL_USE_CONFIRMED: 'true' } });
  assert.equal((await (await approved.handle(request('status'))).json()).configured, true);
  for (const text of ['{broken', JSON.stringify({ token: TOKEN, personalUse: false }), ' '.repeat(4097)]) {
    await writeFile(configPath, text);
    const gateway = await createLocalGateway({ port: PORT, configPath });
    assert.equal((await (await gateway.handle(request('status'))).json()).configured, false);
  }
});

test('local cache expires at max-age, returns independent copies and bounds entries', async () => {
  let clock = 1000;
  const cache = createMemoryCache({ now: () => clock, maximumEntries: 2 });
  const response = text => new Response(text, { headers: { 'Cache-Control': 'public, max-age=2' } });
  const a = new Request(`${ORIGIN}/a`), b = new Request(`${ORIGIN}/b`), c = new Request(`${ORIGIN}/c`);
  await cache.put(a, response('first'));
  assert.equal(await (await cache.match(a)).text(), 'first');
  assert.equal(await (await cache.match(a)).text(), 'first');
  await cache.put(b, response('second')); await cache.put(c, response('third'));
  assert.equal(await cache.match(a), undefined);
  clock = 3000;
  assert.equal(await cache.match(b), undefined);
  await cache.put(a, new Response('no-cache'));
  assert.equal(await cache.match(a), undefined);
  cache.clear();
  assert.equal(await cache.match(c), undefined);
});

test('provider exceptions and configuration write errors are sanitized', async t => {
  const { gateway } = await fixture(t, { workerFactory: () => ({ fetch: async () => { throw new Error(TOKEN); } }) });
  assert.equal((await gateway.handle(configRequest())).status, 200);
  const response = await gateway.handle(request('quotes?symbols=AC'));
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes(TOKEN));
  const { directory } = await fixture(t);
  const badDestination = join(directory, 'a-directory');
  await mkdir(badDestination);
  const failed = await createLocalGateway({ port: PORT, configPath: badDestination });
  const save = await failed.handle(configRequest());
  assert.equal(save.status, 500);
  assert.ok(!(await save.text()).includes(TOKEN));
  assert.equal((await (await failed.handle(request('status'))).json()).configured, false);
});

test('local adapter reaches the actual normalized Worker with an explicitly confirmed private token', async t => {
  const { configPath } = await fixture(t);
  const clock = Date.parse('2026-10-09T04:00:00Z');
  const upstreamRequests = [];
  const gateway = await createLocalGateway({
    port: PORT, configPath, now: () => clock,
    env: { EODHD_TOKEN: TOKEN, PRIVATE_LOCAL_USE_CONFIRMED: 'true' },
    fetchFn: async target => {
      const url = new URL(target);
      upstreamRequests.push(url);
      assert.equal(url.origin, 'https://eodhd.com');
      const body = url.pathname.includes('exchange-symbol-list')
        ? [{ Code: 'AC', Name: 'Ayala Corporation', Currency: 'PHP', Type: 'Common Stock' }]
        : { code: 'AC.PSE', close: 500, previousClose: 495, timestamp: clock / 1000 - 1200, volume: 10000 };
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  const response = await gateway.handle(request('quotes?symbols=AC', { headers: { Origin: ORIGIN } }));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(TOKEN));
  assert.equal(JSON.parse(text).quotes[0].value, 500);
  assert.ok(upstreamRequests.length > 0);
  const missingIndex = await gateway.handle(request('index/PSEI'));
  assert.equal(missingIndex.status, 503, 'Private equity credentials do not create missing index/fund data.');
});

test('keyless public source uses a separate local route and never receives private credentials', async t => {
  const { configPath } = await fixture(t);
  const calls = [];
  const gateway = await createLocalGateway({ port: PORT, configPath,
    env: { EODHD_TOKEN: TOKEN, PRIVATE_LOCAL_USE_CONFIRMED: 'true' },
    freeFactory: () => ({ handle: async req => {
      calls.push(req);
      return new Response(JSON.stringify({ quotes: [{ symbol: 'BDO', value: 113, source: 'PSE EDGE' }] }));
    } }),
  });
  const response = await gateway.handle(request('public/quotes?symbols=BDO', { headers: { Origin: ORIGIN, Authorization: TOKEN } }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).quotes[0].source, 'PSE EDGE');
  assert.equal(calls[0].url, `${ORIGIN}/quotes?symbols=BDO`);
  assert.equal(calls[0].headers.get('Authorization'), null);
  assert.ok(!calls[0].url.includes(TOKEN));
  assert.equal((await gateway.handle(new Request(`http://evil.test:${PORT}/api/public/catalog`))).status, 403);
});
